import { hostname as osHostname } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';

import {
  DEAD_LETTER_EXCHANGE,
  DEAD_LETTER_EXCHANGE_OPTIONS,
  DEAD_LETTER_EXCHANGE_TYPE,
  DEAD_LETTER_QUEUE,
  DEAD_LETTER_QUEUE_OPTIONS,
  TELEMETRY_EXCHANGE,
  TELEMETRY_EXCHANGE_OPTIONS,
  TELEMETRY_EXCHANGE_TYPE,
  TELEMETRY_QUEUE,
  TELEMETRY_QUEUE_OPTIONS,
  TELEMETRY_ROUTING_KEY,
  assertNever,
  backoffDelay,
  settleWithin,
  type Logger,
} from '@telemetry/shared';
import { connect, type Channel, type ChannelModel, type ConsumeMessage } from 'amqplib';

import {
  INITIAL_STATE,
  LINK_RESET_AFTER_MS,
  isConsuming,
  transition,
  type ConsumerEvent,
  type ConsumerState,
  type Effect,
} from './consumer-state.js';
import { processDelivery, type HandlerResult } from './handler.js';
import type { StorePort, StoreWatcher } from './store.js';

export type ConsumerStats = {
  received: number;
  acked: number;
  created: number;
  applied: number;
  stale: number;
  duplicate: number;
  alerts: number;
  gaps: number;
  rejected: number;
  failed: number;
  retries: number;
  returned: number;
  abandoned: number;
  inFlight: number;
  paused: boolean;
  generation: number;
  registered: boolean;
};

export type AmqpConsumerOptions = {
  url: string;
  heartbeatSeconds: number;
  prefetch: number;
  transientAttempts: number;
  shutdownTimeoutMs: number;
  store: StorePort & StoreWatcher;
  logger: Logger;
  /** For `connection_name`; defaults to os.hostname(). */
  hostname?: string;
};

/**
 * Bounds `connect()`. amqplib arms it as the socket's inactivity timeout from the TCP connect to the
 * end of the AMQP handshake, and disarms it once the connection is open (`lib/connect.js`, v2.0.1).
 */
export const AMQP_CONNECT_TIMEOUT_MS = 10_000;
/** One budget for opening the channel, declaring the topology and setting the prefetch. */
export const AMQP_SETUP_TIMEOUT_MS = 10_000;
/** Bounds the close of a connection, and the cancel of a consumer (decisions 12 and 20). */
export const AMQP_CLOSE_TIMEOUT_MS = 2_000;
export const LINK_BACKOFF_BASE_MS = 500;
/**
 * The longest reconnect delay. A link resets the attempt counter only after it stayed open for at
 * least the longest delay (decision 6), so this value is taken from that constant, not written twice.
 */
export const LINK_BACKOFF_MAX_MS = LINK_RESET_AFTER_MS;

/** One amqplib connection, from the moment `connect()` resolved until its close has finished. */
type ModelHandle = {
  /** The generation of the attempt that opened it; its listeners dispatch with this number. */
  readonly generation: number;
  readonly model: ChannelModel;
  /** Set by the model's own `close` event, so a later close of it is skipped. */
  closed: boolean;
  /** The error the connection closed with, when the broker or the socket closed it. */
  closeError: Error | undefined;
  /** The one close of this model. A second `close_link` for it waits for the same promise. */
  closing: Promise<void> | undefined;
  /** Set when the setup budget ran out: the sequence still running stops at its next check. */
  abandoned: boolean;
  /** A close arrived while the attempt was in flight: the attempt reports it as `link_failed`. */
  failed: boolean;
  /** The first end reason, so the second close event of one link (channel, then connection) is ignored. */
  ended: string | undefined;
};

/** The connection and channel of the attempt that reached `open`. */
type Link = { readonly handle: ModelHandle; readonly channel: Channel };

/**
 * One `consume` call: its abort controller, the deliveries it holds, and the handlers it
 * dispatched (decision 7, A10). A broker cancel, a pause and a link end void it: a handler then
 * acknowledges nothing through it, because its tags are void.
 */
type Registration = {
  readonly link: Link;
  readonly controller: AbortController;
  readonly held: Map<number, ConsumeMessage>;
  readonly dispatched: Set<Promise<void>>;
  consumerTag: string | undefined;
  live: boolean;
};

type Counters = Omit<ConsumerStats, 'inFlight' | 'paused' | 'generation' | 'registered'>;

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return sleep(ms, undefined, { signal });
}

/**
 * The amqplib shell around the pure state machine of `consumer-state.ts` (processing spec, section
 * "The consumer"). It turns amqplib events and the outcomes of its own asynchronous work into
 * events, and runs the effects `transition` returns, in order, on one serial queue: the pause
 * returns what it holds only after the cancel resolved and the handlers settled (A9).
 *
 * Invariant 4: every delivery is dispatched with `void`, so up to `prefetch` handlers run at once
 * and the broker bounds them. Invariant 6: one connection and one channel per instance; the held
 * map belongs to one registration and dies with it; nothing is kept per device.
 */
export class AmqpConsumer {
  readonly #connectUrl: string;
  readonly #connectionName: string;
  readonly #prefetch: number;
  readonly #transientAttempts: number;
  readonly #shutdownTimeoutMs: number;
  readonly #store: StorePort & StoreWatcher;
  readonly #logger: Logger;
  readonly #stopController = new AbortController();
  #state: ConsumerState = INITIAL_STATE;
  #link: Link | undefined;
  #registration: Registration | undefined;
  /** The effects of every transition, run in order; never rejects. */
  #effects: Promise<void> = Promise.resolve();
  #backoffTimer: NodeJS.Timeout | undefined;
  #watching = false;
  /** The error behind the failure that is about to back off, for the backoff `warn` line. */
  #failure: { generation: number; error: unknown } | undefined;
  #inFlight = 0;
  #paused = false;
  readonly #counters: Counters = {
    received: 0,
    acked: 0,
    created: 0,
    applied: 0,
    stale: 0,
    duplicate: 0,
    alerts: 0,
    gaps: 0,
    rejected: 0,
    failed: 0,
    retries: 0,
    returned: 0,
    abandoned: 0,
  };

  constructor({
    url,
    heartbeatSeconds,
    prefetch,
    transientAttempts,
    shutdownTimeoutMs,
    store,
    logger,
    hostname = osHostname(),
  }: AmqpConsumerOptions) {
    // amqplib reads the heartbeat it proposes from the URL's query string (`lib/connect.js`). The
    // URL can carry credentials, so it is never logged.
    const connectUrl = new URL(url);
    connectUrl.searchParams.set('heartbeat', String(heartbeatSeconds));
    this.#connectUrl = connectUrl.href;
    this.#connectionName = `processing@${hostname}`;
    this.#prefetch = prefetch;
    this.#transientAttempts = transientAttempts;
    this.#shutdownTimeoutMs = shutdownTimeoutMs;
    this.#store = store;
    this.#logger = logger;
  }

  get state(): ConsumerState {
    return this.#state;
  }

  /** Starts the connect loop; the first attempt runs at once. Called once. Never throws. */
  start(): void {
    this.#dispatch({ type: 'backoff_elapsed', generation: this.#state.generation });
  }

  /** The entry point calls it once `store.start()` resolved ready (decision 21). */
  storeReady(): void {
    this.#dispatch({ type: 'store_ready' });
  }

  stats(): ConsumerStats {
    return {
      ...this.#counters,
      inFlight: this.#inFlight,
      paused: this.#paused,
      generation: this.#state.generation,
      registered: isConsuming(this.#state),
    };
  }

  /**
   * Decision 20: cancel first, drain up to the budget, then abort what is left and close the link.
   * Resolves once the link is closed, within `shutdownTimeoutMs + AMQP_CLOSE_TIMEOUT_MS` plus the
   * cancel's own bound. Called once; the shared lifecycle handler exits on a second signal.
   */
  async stop(): Promise<void> {
    clearTimeout(this.#backoffTimer);
    this.#stopController.abort();
    const from = this.#state.name;
    this.#dispatch({ type: 'stop' });
    this.#logger.info({ from }, 'consumer stopping');
    if (this.#state.name === 'draining') {
      const { generation } = this.#state;
      const registration = this.#registration;
      // The cancel effect first (no new deliveries once it resolved), then every handler dispatched.
      const drained = settleWithin(
        this.#effects.then(() => Promise.allSettled([...(registration?.dispatched ?? [])])),
        this.#shutdownTimeoutMs,
      );
      if ((await drained).outcome === 'timed_out') {
        this.#logger.warn(
          { inFlight: this.#inFlight, timeoutMs: this.#shutdownTimeoutMs },
          'shutdown drain ended at its budget',
        );
      }
      this.#dispatch({ type: 'drained', generation });
    }
    await this.#effects;
  }

  /**
   * Runs one event through `transition`, stores the state, and queues the effects behind those of
   * every earlier transition. Events are applied at once; only their effects lag, in order.
   */
  #dispatch(event: ConsumerEvent): void {
    const { state, effects } = transition(this.#state, event);
    this.#state = state;
    if (effects.length === 0) {
      return;
    }
    const { generation } = state;
    this.#effects = this.#effects.then(() => this.#runEffects(effects, generation));
  }

  async #runEffects(effects: readonly Effect[], generation: number): Promise<void> {
    for (const effect of effects) {
      try {
        await this.#runEffect(effect, generation);
      } catch (error) {
        // Every runner handles its own amqplib errors; this keeps the queue alive on a programmer error.
        this.#logger.error({ err: error, effect: effect.kind, generation }, 'effect failed');
      }
    }
  }

  async #runEffect(effect: Effect, generation: number): Promise<void> {
    switch (effect.kind) {
      case 'open_link':
        queueMicrotask(() => {
          void this.#attempt(generation);
        });
        return;
      case 'schedule_backoff':
        this.#scheduleBackoff(effect, generation);
        return;
      case 'consume':
        await this.#consume(generation);
        return;
      case 'cancel_consumer':
        await this.#cancelConsumer();
        return;
      case 'abort_handlers':
        this.#registration?.controller.abort();
        return;
      case 'return_held':
        await this.#returnHeld(generation);
        return;
      case 'watch_store':
        this.#watchStore();
        return;
      case 'close_link':
        await this.#closeLink();
        return;
      default:
        assertNever(effect, 'consumer effect');
    }
  }

  /**
   * The connect sequence of decision 6, under the generation it started with. After every await
   * the attempt goes on only while the consumer is still connecting on that generation with no
   * close since; otherwise it closes what it opened and reports the attempt failed, or reports
   * nothing once the consumer is stopped. Every failure is caught here.
   */
  async #attempt(generation: number): Promise<void> {
    let model: ChannelModel;
    try {
      model = await connect(this.#connectUrl, {
        timeout: AMQP_CONNECT_TIMEOUT_MS,
        clientProperties: { connection_name: this.#connectionName },
      });
    } catch (error) {
      this.#endAttempt({ generation, reason: 'connect_failed', error });
      return;
    }
    const handle = this.#watchModel(model, generation);
    const setup = await settleWithin(this.#openChannel(handle), AMQP_SETUP_TIMEOUT_MS);
    switch (setup.outcome) {
      case 'timed_out':
        handle.abandoned = true;
        this.#endAttempt({ generation, handle, reason: 'setup_timed_out' });
        return;
      case 'rejected':
        this.#endAttempt({
          generation,
          handle,
          reason: handle.ended ?? 'setup_failed',
          error: setup.error,
        });
        return;
      case 'resolved':
        if (setup.value === undefined || !this.#mayContinue(handle)) {
          this.#endAttempt({ generation, handle, reason: handle.ended ?? 'superseded' });
          return;
        }
        this.#link = { handle, channel: setup.value };
        this.#logger.info(
          { generation, attempt: this.#state.name === 'connecting' ? this.#state.attempt : 0 },
          'consumer connected',
        );
        this.#dispatch({ type: 'link_opened', generation, now: Date.now() });
        return;
      default:
        assertNever(setup, 'setup outcome');
    }
  }

  /**
   * Opens the channel, declares the topology in ingest's order and sets the prefetch, with a check
   * before every step. Undefined as soon as the attempt may not go on; the caller then closes the
   * model.
   */
  async #openChannel(handle: ModelHandle): Promise<Channel | undefined> {
    if (!this.#mayContinue(handle)) {
      return undefined;
    }
    const channel = await handle.model.createChannel();
    this.#watchChannel(channel, handle);
    const steps = [
      () =>
        channel.assertExchange(
          TELEMETRY_EXCHANGE,
          TELEMETRY_EXCHANGE_TYPE,
          TELEMETRY_EXCHANGE_OPTIONS,
        ),
      () =>
        channel.assertExchange(
          DEAD_LETTER_EXCHANGE,
          DEAD_LETTER_EXCHANGE_TYPE,
          DEAD_LETTER_EXCHANGE_OPTIONS,
        ),
      () => channel.assertQueue(TELEMETRY_QUEUE, TELEMETRY_QUEUE_OPTIONS),
      () => channel.assertQueue(DEAD_LETTER_QUEUE, DEAD_LETTER_QUEUE_OPTIONS),
      () => channel.bindQueue(TELEMETRY_QUEUE, TELEMETRY_EXCHANGE, TELEMETRY_ROUTING_KEY),
      // A fanout exchange ignores the routing key.
      () => channel.bindQueue(DEAD_LETTER_QUEUE, DEAD_LETTER_EXCHANGE, ''),
      // Per consumer, never global: quorum queues reject global QoS (decision 4).
      () => channel.prefetch(this.#prefetch, false),
    ];
    for (const step of steps) {
      if (!this.#mayContinue(handle)) {
        return undefined;
      }
      await step();
    }
    return channel;
  }

  /** Whether an attempt may go on: its budget not spent, still connecting on its generation, no close since. */
  #mayContinue(handle: ModelHandle): boolean {
    const state = this.#state;
    return (
      !handle.abandoned &&
      !handle.failed &&
      state.name === 'connecting' &&
      state.generation === handle.generation
    );
  }

  /**
   * Ends an attempt that did not reach `open`: closes the model it opened, if any, with nobody
   * waiting (bounded, never rejects), then reports `link_failed` unless the consumer stopped.
   */
  #endAttempt({
    generation,
    handle,
    reason,
    error,
  }: {
    generation: number;
    handle?: ModelHandle;
    reason: string;
    error?: unknown;
  }): void {
    if (handle !== undefined) {
      void this.#closeHandle(handle);
    }
    if (this.#state.name === 'stopped') {
      return;
    }
    this.#failure = error === undefined ? undefined : { generation, error };
    this.#dispatch({ type: 'link_failed', generation, reason });
  }

  #watchModel(model: ChannelModel, generation: number): ModelHandle {
    const handle: ModelHandle = {
      generation,
      model,
      closed: false,
      closeError: undefined,
      closing: undefined,
      abandoned: false,
      failed: false,
      ended: undefined,
    };
    model.on('close', (error?: Error) => {
      handle.closed = true;
      handle.closeError = error;
      this.#onLinkEnded({ handle, reason: 'connection_closed' });
    });
    model.on('error', (error: Error) => {
      // No event of its own: amqplib emits `close` after `error`, and the close is the trigger.
      if (generation === this.#state.generation) {
        this.#logger.error({ err: error, generation }, 'amqp connection error');
      }
    });
    // A consumer is not blocked by a resource alarm, publishers are: logged only.
    model.on('blocked', (reason: string) => {
      this.#logger.warn({ reason, generation }, 'connection blocked');
    });
    model.on('unblocked', () => {
      this.#logger.info({ generation }, 'connection unblocked');
    });
    return handle;
  }

  #watchChannel(channel: Channel, handle: ModelHandle): void {
    channel.on('close', () => {
      this.#onLinkEnded({ handle, reason: 'channel_closed' });
    });
    channel.on('error', (error: Error) => {
      if (handle.generation === this.#state.generation) {
        this.#logger.error({ err: error, generation: handle.generation }, 'amqp channel error');
      }
    });
    // amqplib catches a throw from one of this channel's listeners and emits it again as
    // `handler-error` on a later turn (`lib/safe_emit.js`). The consume callback never throws.
    channel.on('handler-error', (error: Error, eventName: string) => {
      if (handle.generation === this.#state.generation) {
        this.#logger.error(
          { err: error, eventName, generation: handle.generation },
          'amqp handler error',
        );
      }
    });
  }

  /**
   * A close of the connection or the channel. While the attempt is in flight it only marks the
   * attempt failed, and the attempt reports exactly one `link_failed` when it settles (decision 6).
   * After `link_opened` the first close is `link_closed`; the second one of the same link (the
   * connection's after the channel's) is ignored. The registration is void from here on.
   */
  #onLinkEnded({ handle, reason }: { handle: ModelHandle; reason: string }): void {
    if (handle.ended !== undefined) {
      return;
    }
    handle.ended = reason;
    const state = this.#state;
    if (state.name === 'connecting' && state.generation === handle.generation) {
      handle.failed = true;
      return;
    }
    if (handle.generation !== state.generation) {
      return;
    }
    if (this.#link?.handle === handle) {
      this.#link = undefined;
    }
    if (this.#registration?.link.handle === handle) {
      this.#registration.live = false;
    }
    this.#failure =
      handle.closeError === undefined
        ? undefined
        : { generation: handle.generation, error: handle.closeError };
    this.#dispatch({ type: 'link_closed', generation: handle.generation, reason, now: Date.now() });
  }

  /** The `consume` effect: one registration on the current link (decision 7). */
  async #consume(generation: number): Promise<void> {
    const link = this.#link;
    if (link === undefined || link.handle.generation !== generation) {
      return;
    }
    if (this.#registration?.live === true) {
      // The machine never asks twice on one link; this guard is the belt to its braces.
      return;
    }
    const registration: Registration = {
      link,
      controller: new AbortController(),
      held: new Map(),
      dispatched: new Set(),
      consumerTag: undefined,
      live: true,
    };
    this.#registration = registration;
    let consumerTag: string;
    try {
      const reply = await link.channel.consume(
        TELEMETRY_QUEUE,
        (message) => {
          this.#onMessage(registration, message);
        },
        { noAck: false },
      );
      consumerTag = reply.consumerTag;
    } catch (error) {
      // amqplib rejects an RPC only on a broken channel: its close is the real event.
      registration.live = false;
      this.#logger.debug({ err: error, generation }, 'consume failed');
      return;
    }
    registration.consumerTag = consumerTag;
    if (!registration.live) {
      return;
    }
    this.#paused = false;
    this.#logger.info({ generation, consumerTag }, 'consumer registered');
    this.#dispatch({ type: 'consumer_registered', generation });
  }

  /** The consume callback: `null` is the broker's cancel; a delivery is dispatched to its own handler. */
  #onMessage(registration: Registration, message: ConsumeMessage | null): void {
    const { generation } = registration.link.handle;
    if (message === null) {
      if (!registration.live) {
        return;
      }
      // RabbitMQ 4.3 returned the deliveries first; every tag of this registration is void.
      registration.live = false;
      this.#logger.info({ generation }, 'consumer cancelled');
      this.#dispatch({ type: 'broker_cancelled', generation });
      return;
    }
    registration.held.set(message.fields.deliveryTag, message);
    this.#counters.received += 1;
    // Not awaited: up to `prefetch` handlers run at once, and the broker bounds them (invariant 4).
    void this.#run(registration, message);
  }

  /**
   * One handler; never rejects. Tracks itself in the registration's dispatched set for the drain
   * and the pause, and acknowledges only through a live registration on the current link.
   */
  async #run(registration: Registration, message: ConsumeMessage): Promise<void> {
    const done = Promise.withResolvers<void>();
    registration.dispatched.add(done.promise);
    this.#inFlight += 1;
    try {
      const result = await processDelivery({
        content: message.content,
        headers: message.properties.headers,
        redelivered: message.fields.redelivered,
        store: this.#store,
        clock: () => Date.now(),
        sleep: abortableSleep,
        random: () => Math.random(),
        signal: registration.controller.signal,
        transientAttempts: this.#transientAttempts,
        logger: this.#logger,
      });
      this.#settle({ registration, message, result });
    } catch (error) {
      // processDelivery never rejects; a throw here is a programmer error in the accounting.
      this.#logger.error(
        { err: error, deliveryTag: message.fields.deliveryTag },
        'handler dispatch failed',
      );
    } finally {
      this.#inFlight -= 1;
      registration.dispatched.delete(done.promise);
      done.resolve();
    }
  }

  #settle({
    registration,
    message,
    result,
  }: {
    registration: Registration;
    message: ConsumeMessage;
    result: HandlerResult;
  }): void {
    const counters = this.#counters;
    counters.retries += Math.max(0, result.attempts - 1);
    switch (result.verdict) {
      case 'ack':
        counters.acked += 1;
        counters[result.outcome] += 1;
        if (result.duplicate) {
          counters.duplicate += 1;
        }
        if (result.alert === 'created') {
          counters.alerts += 1;
        }
        if (result.gap) {
          counters.gaps += 1;
        }
        this.#acknowledge({ registration, message, act: (channel) => channel.ack(message) });
        return;
      case 'reject':
        if (result.reason === 'permanent') {
          counters.failed += 1;
        } else {
          counters.rejected += 1;
        }
        this.#acknowledge({
          registration,
          message,
          act: (channel) => channel.reject(message, false),
        });
        return;
      case 'abandon':
        counters.abandoned += 1;
        if (result.cause === 'store_unavailable') {
          this.#dispatch({ type: 'store_unavailable' });
        }
        return;
      default:
        assertNever(result, 'handler verdict');
    }
  }

  /** An individual ack or reject, never `allUpTo`; nothing is acknowledged through a void registration. */
  #acknowledge({
    registration,
    message,
    act,
  }: {
    registration: Registration;
    message: ConsumeMessage;
    act: (channel: Channel) => void;
  }): void {
    if (!registration.live) {
      return;
    }
    registration.held.delete(message.fields.deliveryTag);
    try {
      act(registration.link.channel);
    } catch (error) {
      // The message id property is the identity string ingest set (consistency spec, decision 3).
      const messageId: unknown = message.properties.messageId;
      this.#logger.warn(
        { err: error, deliveryTag: message.fields.deliveryTag, messageId },
        'acknowledge failed',
      );
    }
  }

  /** The `cancel_consumer` effect: no new delivery once it resolved (decision 12). */
  async #cancelConsumer(): Promise<void> {
    const registration = this.#registration;
    if (registration === undefined || registration.consumerTag === undefined) {
      return;
    }
    const { generation } = registration.link.handle;
    try {
      const result = await settleWithin(
        registration.link.channel.cancel(registration.consumerTag),
        AMQP_CLOSE_TIMEOUT_MS,
      );
      this.#logger.debug({ outcome: result.outcome, generation }, 'consumer cancel');
    } catch (error) {
      // A closed channel throws at once; its close is the real event.
      this.#logger.debug({ err: error, generation }, 'consumer cancel');
    }
  }

  /**
   * The `return_held` effect: once every dispatched handler settled, `basic.nack(requeue=true)`
   * for every delivery still held, which in RabbitMQ 4.3 does not count toward the delivery limit
   * (decision 12). A client-initiated cancel returns nothing by itself.
   */
  async #returnHeld(generation: number): Promise<void> {
    const registration = this.#registration;
    if (registration === undefined) {
      return;
    }
    await Promise.allSettled([...registration.dispatched]);
    let returned = 0;
    const { link } = registration;
    if (link.handle.generation === generation && !link.handle.closed) {
      for (const message of registration.held.values()) {
        try {
          link.channel.nack(message, false, true);
          returned += 1;
        } catch (error) {
          this.#logger.debug({ err: error, generation }, 'nack failed');
          break;
        }
      }
    }
    registration.held.clear();
    registration.live = false;
    this.#counters.returned += returned;
    this.#paused = true;
    this.#logger.warn({ generation, returned }, 'consumer paused');
  }

  /** The `watch_store` effect: at most one ping loop at a time (decision 10). */
  #watchStore(): void {
    if (this.#watching) {
      return;
    }
    this.#watching = true;
    void this.#store.watch(this.#stopController.signal).then(
      (outcome) => {
        this.#watching = false;
        if (outcome === 'ready') {
          this.#dispatch({ type: 'store_ready' });
        }
      },
      (error: unknown) => {
        this.#watching = false;
        this.#logger.error({ err: error }, 'store watch failed');
      },
    );
  }

  /** The `close_link` effect: closes the connection, which closes its channel (A12). */
  async #closeLink(): Promise<void> {
    const link = this.#link;
    this.#link = undefined;
    if (this.#registration !== undefined) {
      this.#registration.live = false;
    }
    if (link === undefined) {
      return;
    }
    await this.#closeHandle(link.handle);
  }

  /** Closes a model once; a later call for the same model returns the same promise. Never rejects. */
  #closeHandle(handle: ModelHandle): Promise<void> {
    handle.closing ??= this.#close(handle);
    return handle.closing;
  }

  async #close(handle: ModelHandle): Promise<void> {
    // On a later turn, never inside an amqplib listener.
    await nextTurn();
    const fields = { generation: handle.generation };
    if (handle.closed) {
      this.#logger.debug({ ...fields, outcome: 'skipped' }, 'amqp connection close');
      return;
    }
    const result = await settleWithin(handle.model.close(), AMQP_CLOSE_TIMEOUT_MS);
    switch (result.outcome) {
      case 'resolved':
        this.#logger.debug({ ...fields, outcome: 'closed' }, 'amqp connection close');
        return;
      case 'rejected':
        this.#logger.debug(
          { ...fields, outcome: 'rejected', err: result.error },
          'amqp connection close',
        );
        return;
      case 'timed_out':
        this.#logger.warn(
          { ...fields, outcome: 'timed_out', timeoutMs: AMQP_CLOSE_TIMEOUT_MS },
          'amqp connection close',
        );
        return;
      default:
        assertNever(result, 'close outcome');
    }
  }

  #scheduleBackoff(
    { attempt, reason }: { attempt: number; reason: string },
    generation: number,
  ): void {
    const delayMs = backoffDelay({
      attempt,
      baseMs: LINK_BACKOFF_BASE_MS,
      maxMs: LINK_BACKOFF_MAX_MS,
      random: () => Math.random(),
    });
    const failure = this.#failure;
    this.#failure = undefined;
    const err = failure?.generation === generation ? { err: failure.error } : {};
    this.#logger.warn(
      { reason, attempt, delayMs: Math.round(delayMs), ...err },
      'consumer reconnect scheduled',
    );
    this.#backoffTimer = setTimeout(() => {
      this.#backoffTimer = undefined;
      this.#dispatch({ type: 'backoff_elapsed', generation });
    }, delayMs);
  }
}

function nextTurn(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(() => {
      resolve();
    });
  });
}
