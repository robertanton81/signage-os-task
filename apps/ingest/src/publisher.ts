import { hostname as osHostname } from 'node:os';

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
  messageLogger,
  type Logger,
  type MessageIdentity,
  type TelemetryMessage,
} from '@telemetry/shared';
import { connect, type ChannelModel, type ConfirmChannel, type Message } from 'amqplib';

import { toPublishArgs } from './amqp-message.js';
import { Ledger, StallClock, type LedgerEntry } from './ledger.js';
import {
  BACKOFF_RESET_AFTER_MS,
  INITIAL_STATE,
  isReady,
  transition,
  type Effect,
  type PublisherEvent,
  type PublisherState,
} from './publisher-state.js';

export type PublishRequest = {
  message: TelemetryMessage;
  receivedAt: number;
  /** Runs once, when the broker acks the message. Never runs for a message that is not acked. */
  onConfirmed: () => void;
};

/**
 * All the socket side knows about the broker (ingest spec, decision 24). The server is tested
 * against an in-memory implementation of this port, which is why it stays this small.
 */
export type PublishPort = {
  /** Adds the message to the ledger and sends it at once while the publisher is ready. */
  publish(request: PublishRequest): void;
  /** Connected, confirm channel open, topology declared, not blocked (decision 17). */
  readonly isReady: boolean;
  /** Called on every change of `isReady`; returns a function that unsubscribes. */
  onReadyChange(listener: (ready: boolean) => void): () => void;
  /** Ledger entries: every message handed over and not yet acked. */
  readonly unconfirmed: number;
  /** Stops reconnecting and closes the connection; resolves within AMQP_CLOSE_TIMEOUT_MS whatever the state. */
  stop(): Promise<void>;
};

export type PublisherStats = {
  confirmed: number;
  unconfirmed: number;
  republished: number;
  returned: number;
};

export type AmqpPublisherOptions = {
  url: string;
  heartbeatSeconds: number;
  logger: Logger;
  /** For `connection_name`; defaults to os.hostname(). */
  hostname?: string;
};

/**
 * Bounds `connect()`. amqplib arms it as the socket's inactivity timeout from the TCP connect to the
 * end of the AMQP handshake, and disarms it once the connection is open (`lib/connect.js`, v2.0.1).
 */
export const AMQP_CONNECT_TIMEOUT_MS = 10_000;
/** One budget for opening the confirm channel and declaring the topology (decision 10). */
export const AMQP_SETUP_TIMEOUT_MS = 10_000;
/** Bounds each close of a connection, and `stop()` (decisions 12 and 19). */
export const AMQP_CLOSE_TIMEOUT_MS = 2_000;
export const AMQP_RECONNECT_BASE_MS = 500;
/**
 * The longest reconnect delay. A connection resets the attempt counter only after it stayed ready
 * for at least the longest delay (decision 13), so this value is taken from that constant, not
 * written twice.
 */
export const AMQP_RECONNECT_MAX_MS = BACKOFF_RESET_AFTER_MS;

/** One amqplib connection, from the moment `connect()` resolved until its close has finished. */
type ModelHandle = {
  /** The generation of the attempt that opened it; its listeners dispatch with this number. */
  readonly generation: number;
  readonly model: ChannelModel;
  /** Set by the model's own `close` event, so a later close of it is skipped. */
  closed: boolean;
  /** The error the connection closed with, when the broker or the socket closed it. */
  closeError: Error | undefined;
  /** The one close of this model. A second `close_model` for it waits for the same promise. */
  closing: Promise<void> | undefined;
  /** Set when the setup budget ran out: the sequence still running stops at its next check. */
  abandoned: boolean;
};

/** The connection and confirm channel of the attempt that reached `ready`. */
type Link = { readonly handle: ModelHandle; readonly channel: ConfirmChannel };

type Settled<T> =
  | { outcome: 'resolved'; value: T }
  | { outcome: 'rejected'; error: unknown }
  | { outcome: 'timed_out' };

/**
 * The amqplib shell around the pure state machine of `publisher-state.ts` (ingest spec, section
 * "The publisher"). It turns amqplib events and the outcomes of its own asynchronous work into
 * events, and runs the effects `transition` returns, in order.
 *
 * Invariant 6: one connection and one confirm channel per instance, and a ledger keyed by an
 * instance-local counter; nothing is kept per device. Invariant 2 on the ingest side: every path out
 * of `ready` raises the generation, which makes every sent entry pending again (`lose`), and the next
 * `ready` sends the whole ledger again (`send_pending`). A duplicate is possible; a lost message is not.
 */
export class AmqpPublisher implements PublishPort {
  readonly #connectUrl: string;
  readonly #connectionName: string;
  readonly #confirmTimeoutMs: number;
  readonly #logger: Logger;
  readonly #debug: boolean;
  readonly #ledger = new Ledger();
  readonly #stallClock = new StallClock();
  readonly #readyListeners = new Set<(ready: boolean) => void>();
  /** Events dispatched while effects run; see `#dispatch`. */
  readonly #queue: PublisherEvent[] = [];
  /** Every `close_model` still running; `stop()` waits for them. */
  readonly #closes = new Set<Promise<void>>();
  #dispatching = false;
  #state: PublisherState = INITIAL_STATE;
  #link: Link | undefined;
  /**
   * The error behind the failure that is about to back off: a failed attempt's own error, or the
   * error the recycled connection closed with. The `warn` line of that backoff logs it.
   */
  #failure: { generation: number; error: unknown } | undefined;
  #backoffTimer: NodeJS.Timeout | undefined;
  #stallTimer: NodeJS.Timeout | undefined;
  #confirmed = 0;
  #republished = 0;
  #returned = 0;

  constructor({ url, heartbeatSeconds, logger, hostname = osHostname() }: AmqpPublisherOptions) {
    // amqplib reads the heartbeat it proposes from the URL's query string (`lib/connect.js`). The
    // URL can carry credentials, so it is never logged.
    const connectUrl = new URL(url);
    connectUrl.searchParams.set('heartbeat', String(heartbeatSeconds));
    this.#connectUrl = connectUrl.href;
    this.#connectionName = `ingest@${hostname}`;
    // Decision 15: three heartbeat intervals without an ack while messages wait.
    this.#confirmTimeoutMs = 3 * heartbeatSeconds * 1000;
    this.#logger = logger;
    this.#debug = logger.isLevelEnabled('debug');
  }

  get isReady(): boolean {
    return isReady(this.#state);
  }

  get unconfirmed(): number {
    return this.#ledger.size;
  }

  get state(): PublisherState {
    return this.#state;
  }

  /** Starts the connect loop; the first attempt runs at once. Called once. Never throws. */
  start(): void {
    this.#stallTimer = setInterval(
      () => {
        this.#checkStall();
      },
      Math.floor(this.#confirmTimeoutMs / 3),
    );
    this.#stallTimer.unref();
    this.#dispatch({ type: 'backoff_elapsed', generation: this.#state.generation });
  }

  publish({ message, receivedAt, onConfirmed }: PublishRequest): void {
    const entry = this.#ledger.add({ args: toPublishArgs(message, receivedAt), onConfirmed });
    // In `ready`, blocked or not, the entry goes out at once; in every other state it waits in the
    // ledger for the next `send_pending`.
    if (this.#state.name === 'ready') {
      this.#send(entry);
    }
  }

  onReadyChange(listener: (ready: boolean) => void): () => void {
    this.#readyListeners.add(listener);
    return () => {
      this.#readyListeners.delete(listener);
    };
  }

  stats(): PublisherStats {
    return {
      confirmed: this.#confirmed,
      unconfirmed: this.#ledger.size,
      republished: this.#republished,
      returned: this.#returned,
    };
  }

  /**
   * Stops reconnecting and closes the connection. Resolves when every close still running has
   * finished, and never later than AMQP_CLOSE_TIMEOUT_MS after the call. An attempt still inside
   * `connect()` or a declaration is not waited for: it closes what it opened at its next check
   * (decision 19). Called once; the shared lifecycle handler exits on a second signal.
   */
  async stop(): Promise<void> {
    clearTimeout(this.#backoffTimer);
    clearInterval(this.#stallTimer);
    this.#dispatch({ type: 'stop' });
    await settleWithin(Promise.all(this.#closes), AMQP_CLOSE_TIMEOUT_MS);
  }

  /**
   * Runs one event through `transition`, notifies the readiness listeners when `isReady` changed,
   * then runs the effects in order. An event dispatched while effects run (a publish that throws
   * inside `send_pending`) is queued and runs after them, so a transition never starts while the
   * effects of the one before it are half done.
   */
  #dispatch(event: PublisherEvent): void {
    this.#queue.push(event);
    if (this.#dispatching) {
      return;
    }
    this.#dispatching = true;
    try {
      for (let next = this.#queue.shift(); next !== undefined; next = this.#queue.shift()) {
        const wasReady = isReady(this.#state);
        const { state, effects } = transition(this.#state, next);
        this.#state = state;
        const ready = isReady(state);
        if (ready !== wasReady) {
          for (const listener of this.#readyListeners) {
            listener(ready);
          }
        }
        for (const effect of effects) {
          this.#run(effect);
        }
      }
    } finally {
      this.#dispatching = false;
    }
  }

  #run(effect: Effect): void {
    switch (effect.type) {
      case 'start_attempt': {
        const { generation } = this.#state;
        queueMicrotask(() => {
          void this.#attempt(generation);
        });
        return;
      }
      case 'lose':
        this.#ledger.lose();
        return;
      case 'send_pending':
        this.#sendPending();
        return;
      case 'restart_stall_clock':
        this.#stallClock.restart(Date.now());
        return;
      case 'close_model':
        this.#closeModel();
        return;
      case 'start_backoff':
        this.#startBackoff(effect);
        return;
      case 'log':
        this.#logger[effect.level](effect.fields, effect.message);
        return;
      default:
        assertNever(effect, 'publisher effect');
    }
  }

  /**
   * The connect sequence of decision 10, under the generation it started with. After every await,
   * and once more right before `attempt_succeeded`, the attempt goes on only while the publisher is
   * still connecting on that generation with no trigger since; otherwise it closes what it opened
   * and reports the attempt failed, or reports nothing once the publisher is stopped. Every failure
   * is caught here.
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
        this.#endAttempt({ generation, handle, reason: 'setup_failed', error: setup.error });
        return;
      case 'resolved':
        if (setup.value === undefined || !this.#mayContinue(handle)) {
          this.#endAttempt({ generation, handle, reason: 'superseded' });
          return;
        }
        this.#link = { handle, channel: setup.value };
        this.#dispatch({ type: 'attempt_succeeded', generation, now: Date.now() });
        return;
      default:
        assertNever(setup, 'setup outcome');
    }
  }

  /**
   * Opens the confirm channel and declares the topology, with a check before every step. Undefined
   * as soon as the attempt may not go on; the caller then closes the model.
   */
  async #openChannel(handle: ModelHandle): Promise<ConfirmChannel | undefined> {
    if (!this.#mayContinue(handle)) {
      return undefined;
    }
    const channel = await handle.model.createConfirmChannel();
    this.#watchChannel(channel, handle.generation);
    const declarations = [
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
    ];
    for (const declare of declarations) {
      if (!this.#mayContinue(handle)) {
        return undefined;
      }
      await declare();
    }
    return channel;
  }

  /** Whether an attempt may go on: its budget not spent, still connecting on its generation, no trigger since. */
  #mayContinue(handle: ModelHandle): boolean {
    const state = this.#state;
    return (
      !handle.abandoned &&
      state.name === 'connecting' &&
      state.generation === handle.generation &&
      !state.failed
    );
  }

  /**
   * Ends an attempt that did not reach `ready`: closes the model it opened, if any, with nobody
   * waiting (bounded, never rejects), then reports `attempt_failed` unless the publisher stopped.
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
    this.#dispatch({ type: 'attempt_failed', generation, reason });
  }

  #watchModel(model: ChannelModel, generation: number): ModelHandle {
    const handle: ModelHandle = {
      generation,
      model,
      closed: false,
      closeError: undefined,
      closing: undefined,
      abandoned: false,
    };
    model.on('close', (error?: Error) => {
      // Recorded whatever the generation: a trigger from `ready` raises the generation before this
      // event arrives, and these two fields let that recycle skip the close and name its cause.
      handle.closed = true;
      handle.closeError = error;
      this.#trigger({ generation, reason: 'connection_closed' });
    });
    model.on('error', (error: Error) => {
      // No event of its own: amqplib emits `close` after `error` (`lib/connection.js`), and the
      // close is the trigger.
      if (generation === this.#state.generation) {
        this.#logger.error({ err: error, generation }, 'amqp connection error');
      }
    });
    model.on('blocked', (reason: string) => {
      this.#dispatch({ type: 'blocked', generation, reason });
    });
    model.on('unblocked', () => {
      this.#dispatch({ type: 'unblocked', generation });
    });
    // No `handler-error` listener on the model: the ChannelModel forwards only `error`, `close`,
    // `blocked`, `unblocked` and `update-secret-ok` from the connection (`lib/channel_model.js`), so
    // the event never reaches it.
    return handle;
  }

  #watchChannel(channel: ConfirmChannel, generation: number): void {
    // Prepended: the channel's constructor registers its own `close` listener, which fails every
    // unconfirmed publish callback with "channel closed" (`lib/channel.js`). Running first makes the
    // recycle's reason `channel_closed`, not the `nacked` those failed callbacks would report.
    channel.prependListener('close', () => {
      this.#trigger({ generation, reason: 'channel_closed' });
    });
    channel.on('error', (error: Error) => {
      if (generation === this.#state.generation) {
        this.#logger.error({ err: error, generation }, 'amqp channel error');
      }
    });
    channel.on('return', (message: Message) => {
      if (generation === this.#state.generation) {
        this.#onReturn(message, generation);
      }
    });
    // amqplib catches a throw from one of this channel's listeners, the publish callbacks included,
    // and emits it again as `handler-error` on a later turn (`lib/safe_emit.js`).
    channel.on('handler-error', (error: Error, eventName: string) => {
      if (generation === this.#state.generation) {
        this.#logger.error({ err: error, eventName, generation }, 'amqp handler error');
        this.#trigger({ generation, reason: 'handler_error' });
      }
    });
  }

  /**
   * A mandatory message the broker could not route. `basic.return` arrives before the message's
   * `basic.ack` (RabbitMQ, "Publisher confirms"), so the trigger raises the generation first: the ack
   * that follows is ignored as stale, and the entry, pending again, goes out on the next channel,
   * whose setup declares the queue again (decision 12).
   */
  #onReturn(message: Message, generation: number): void {
    this.#returned += 1;
    const messageId: unknown = message.properties.messageId;
    const identity = parseMessageId(messageId);
    const fields = {
      exchange: message.fields.exchange,
      routingKey: message.fields.routingKey,
      generation,
    };
    if (identity === undefined) {
      this.#logger.error({ ...fields, messageId }, 'message returned');
    } else {
      messageLogger(this.#logger, identity).error(fields, 'message returned');
    }
    this.#trigger({ generation, reason: 'returned' });
  }

  /** Sends every pending entry in insertion order; stops at the first publish that throws. */
  #sendPending(): void {
    for (const entry of this.#ledger.pending()) {
      const again = entry.wasSent;
      if (!this.#send(entry)) {
        // The throw dispatched a trigger, queued behind these effects; the rest waits for the next channel.
        return;
      }
      if (again) {
        this.#republished += 1;
      }
    }
  }

  /**
   * Publishes one entry on the current channel and reports whether the channel took it. amqplib
   * throws on a closed channel before it records the callback (`lib/channel_model.js`), so a throw
   * leaves the entry pending and dispatches a trigger. The entry is marked sent only if the
   * generation is still the one it was published on.
   */
  #send(entry: LedgerEntry): boolean {
    const link = this.#link;
    if (link === undefined) {
      // A programmer error: an attempt stores its link before it dispatches `attempt_succeeded`.
      throw new Error('the publisher is ready without a channel');
    }
    const { generation } = this.#state;
    const { exchange, routingKey, content, options } = entry.args;
    try {
      // The return value is ignored (decision 16): the windows bound what waits in amqplib's buffer.
      link.channel.publish(exchange, routingKey, content, options, (error: unknown) => {
        this.#onConfirm({ entry, generation, error });
      });
    } catch (error) {
      this.#logger.debug({ err: error, generation }, 'publish threw');
      this.#trigger({ generation, reason: 'publish_threw' });
      return false;
    }
    if (this.#state.generation === generation) {
      this.#ledger.markSent(entry, generation);
      this.#stallClock.onSent({ now: Date.now(), sentCount: this.#ledger.sentCount });
    }
    if (this.#debug) {
      this.#messageLog(entry).debug({ generation }, 'message published');
    }
    return true;
  }

  /** The confirm callback of one publish. A callback of a recycled generation is ignored. */
  #onConfirm({
    entry,
    generation,
    error,
  }: {
    entry: LedgerEntry;
    generation: number;
    error: unknown;
  }): void {
    if (generation !== this.#state.generation) {
      return;
    }
    if (error !== null && error !== undefined) {
      // A nack. The entry stays in the ledger and goes out again on the next channel (decision 12).
      this.#logger.debug({ err: error, generation }, 'publish nacked');
      this.#trigger({ generation, reason: 'nacked' });
      return;
    }
    this.#ledger.confirm(entry);
    this.#confirmed += 1;
    this.#stallClock.onAck({ now: Date.now(), sentCount: this.#ledger.sentCount });
    if (this.#debug) {
      this.#messageLog(entry).debug({ generation }, 'message confirmed');
    }
  }

  /** Decision 15: recycle when sent entries have waited longer than the confirm timeout for an ack. */
  #checkStall(): void {
    const state = this.#state;
    if (state.name !== 'ready' || state.blocked || this.#ledger.sentCount === 0) {
      return;
    }
    if (this.#stallClock.isStalled({ now: Date.now(), timeoutMs: this.#confirmTimeoutMs })) {
      this.#trigger({ generation: state.generation, reason: 'confirm_stall' });
    }
  }

  /**
   * Closes the model the shell keeps. Every path (skipped, closed, rejected, timed out) ends the same
   * way, exactly once: the reference is dropped and `close_finished` is dispatched with the generation
   * of the transition that asked for the close. That event is the only way out of `recycling`.
   */
  #closeModel(): void {
    const { generation } = this.#state;
    const link = this.#link;
    const closed = link === undefined ? nextTurn() : this.#closeHandle(link.handle);
    const done = closed.then(() => {
      this.#closes.delete(done);
      if (link !== undefined) {
        if (this.#link === link) {
          this.#link = undefined;
        }
        // The prepended channel listener names the recycle `channel_closed`; the error the
        // connection closed with says why, and the backoff line after `close_finished` logs it.
        if (link.handle.closeError !== undefined) {
          this.#failure = { generation, error: link.handle.closeError };
        }
      }
      this.#dispatch({ type: 'close_finished', generation });
    });
    this.#closes.add(done);
  }

  /** Closes a model once; a later call for the same model returns the same promise. Never rejects. */
  #closeHandle(handle: ModelHandle): Promise<void> {
    handle.closing ??= this.#close(handle);
    return handle.closing;
  }

  async #close(handle: ModelHandle): Promise<void> {
    // On a later turn, never inside an amqplib listener (spec, section "The publisher").
    await nextTurn();
    const fields = { generation: handle.generation };
    if (handle.closed) {
      // The common case after a broker restart or a heartbeat timeout: `close()` would only reject.
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

  #startBackoff({ attempt, reason }: { attempt: number; reason: string }): void {
    const { generation } = this.#state;
    const delayMs = backoffDelay({
      attempt,
      baseMs: AMQP_RECONNECT_BASE_MS,
      maxMs: AMQP_RECONNECT_MAX_MS,
      random: () => Math.random(),
    });
    const failure = this.#failure;
    this.#failure = undefined;
    const err = failure?.generation === generation ? { err: failure.error } : {};
    this.#logger.warn(
      { reason, attempt, delayMs: Math.round(delayMs), ...err },
      'publisher reconnect scheduled',
    );
    this.#backoffTimer = setTimeout(() => {
      this.#backoffTimer = undefined;
      this.#dispatch({ type: 'backoff_elapsed', generation });
    }, delayMs);
  }

  #trigger({ generation, reason }: { generation: number; reason: string }): void {
    this.#dispatch({ type: 'trigger', generation, reason, now: Date.now() });
  }

  /** A logger with the entry's identity, for the debug lines about one message. */
  #messageLog(entry: LedgerEntry): Logger {
    const identity = parseMessageId(entry.args.options.messageId);
    return identity === undefined ? this.#logger : messageLogger(this.#logger, identity);
  }
}

/**
 * The identity inside a message id this service wrote: `deviceId:sessionId:seq` (shared
 * `messageIdentity`; a device id cannot contain a colon). A returned message's id comes back from
 * the broker, so it is checked, not trusted.
 */
function parseMessageId(messageId: unknown): MessageIdentity | undefined {
  if (typeof messageId !== 'string') {
    return undefined;
  }
  const parts = messageId.split(':');
  if (parts.length !== 3) {
    return undefined;
  }
  const [deviceId = '', sessionText = '', seqText = ''] = parts;
  const sessionId = Number(sessionText);
  const seq = Number(seqText);
  if (
    deviceId === '' ||
    sessionText === '' ||
    seqText === '' ||
    !Number.isSafeInteger(sessionId) ||
    !Number.isSafeInteger(seq)
  ) {
    return undefined;
  }
  return { deviceId, sessionId, seq };
}

function nextTurn(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(() => {
      resolve();
    });
  });
}

/**
 * Waits for `promise` at most `timeoutMs` and never rejects. A rejection that arrives after the
 * timeout is still handled, so it never becomes an unhandled rejection. The timer is cleared.
 */
function settleWithin<T>(promise: Promise<T>, timeoutMs: number): Promise<Settled<T>> {
  let timer: NodeJS.Timeout | undefined;
  const timedOut = new Promise<Settled<T>>((resolve) => {
    timer = setTimeout(() => {
      resolve({ outcome: 'timed_out' });
    }, timeoutMs);
  });
  const settled = promise.then(
    (value): Settled<T> => ({ outcome: 'resolved', value }),
    (error: unknown): Settled<T> => ({ outcome: 'rejected', error }),
  );
  return Promise.race([settled, timedOut]).finally(() => {
    clearTimeout(timer);
  });
}
