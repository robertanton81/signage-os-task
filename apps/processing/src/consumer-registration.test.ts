import {
  RECEIVED_AT_HEADER,
  TELEMETRY_EXCHANGE,
  TELEMETRY_ROUTING_KEY,
  createLogger,
  type Logger,
  type TelemetryMessage,
} from '@telemetry/shared';
import type { ConsumeMessage } from 'amqplib';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  AMQP_CLOSE_TIMEOUT_MS,
  AMQP_SETUP_TIMEOUT_MS,
  AmqpConsumer,
  LINK_BACKOFF_BASE_MS,
} from './consumer.js';
import type { StoreFailure } from './failure.js';
import { EXAMPLE_RECEIVED_AT, exampleMessages } from './fixtures.js';
import type { StoreWatcher } from './store.js';
import { TestStore } from './test-store.js';

/**
 * The consumer against a broker that stops answering after the link is open: `stop()` while the
 * `basic.consume` reply is still pending, `stop()` while the cancel reply is, and a `basic.consume`
 * reply that never arrives at all; and the order of the closes at a stop (decision 20: the
 * channel's close-ok before the connection close, T70) with the one budget they share. A real broker
 * cannot be asked to withhold one reply, and a TCP stand-in would have to speak the whole AMQP
 * handshake before it could stay silent, so these tests replace the amqplib module with a fake
 * that answers every call except the ones a test holds back. The store is the in-memory port of
 * the handler's tests. Time is faked: every bound is crossed by advancing the clock, never by
 * waiting; the one real timer, a handler's backoff sleep, is ended by the abort under test.
 */

type Reply = { consumerTag: string };
type Listener = (...args: unknown[]) => void;
type LogLine = { msg: string; level: number; [field: string]: unknown };

const SHUTDOWN_TIMEOUT_MS = 100;
/** pino's numeric level for `warn`. */
const WARN = 40;
/**
 * The consumer closes a connection on a later turn (`setImmediate`). The fake clock places an
 * immediate scheduled while a timer runs one millisecond ahead, never zero (vitest 4.1.11's
 * bundled @sinonjs/fake-timers 15.0.0, `addTimer`: `now + (delay || (duringTick ? 1 : 0))`), so
 * every wait that ends in a close crosses its bound by this much.
 */
const IMMEDIATE_MS = 1;
const HEADERS = { [RECEIVED_AT_HEADER]: EXAMPLE_RECEIVED_AT };
const NETWORK_FAILURE: StoreFailure = { kind: 'network', message: 'connection reset' };

const fake = vi.hoisted(() => {
  const events = (): {
    on: (event: string, fn: Listener) => void;
    emit: (event: string, ...args: unknown[]) => void;
  } => {
    const listeners = new Map<string, Listener[]>();
    return {
      on: (event, fn) => {
        listeners.set(event, [...(listeners.get(event) ?? []), fn]);
      },
      emit: (event, ...args) => {
        for (const fn of listeners.get(event) ?? []) {
          fn(...args);
        }
      },
    };
  };
  const state = {
    /** Every broker call the consumer made, in order, acknowledgements included. */
    calls: [] as string[],
    /** Every `consume` call, oldest first; a test settles the reply it holds back. */
    consumes: [] as {
      reply: PromiseWithResolvers<Reply>;
      callback: (message: ConsumeMessage | null) => void;
    }[],
    /** Every `cancel` call, oldest first; answered at once unless a test holds the reply. */
    cancels: [] as PromiseWithResolvers<object>[],
    /** Resolves when the consumer has issued a `consume`; the tests wait for it, not for time. */
    consumeIssued: Promise.withResolvers<void>(),
    /** `false` holds the cancel reply, as a broker that does not answer would. */
    cancelAnswers: true,
    /** `false` holds the channel close-ok and the connection close the same way. */
    closeAnswers: true,
    modelEvents: events(),
    channelEvents: events(),
    reset: (): void => {
      state.calls.length = 0;
      state.consumes.length = 0;
      state.cancels.length = 0;
      state.consumeIssued = Promise.withResolvers<void>();
      state.cancelAnswers = true;
      state.closeAnswers = true;
      state.modelEvents = events();
      state.channelEvents = events();
    },
  };
  const channel = {
    on: (event: string, fn: Listener): void => {
      state.channelEvents.on(event, fn);
    },
    assertExchange: (): Promise<object> => Promise.resolve({}),
    assertQueue: (): Promise<object> => Promise.resolve({}),
    bindQueue: (): Promise<object> => Promise.resolve({}),
    prefetch: (): Promise<object> => Promise.resolve({}),
    consume: (
      _queue: string,
      callback: (message: ConsumeMessage | null) => void,
    ): Promise<Reply> => {
      state.calls.push('consume');
      const reply = Promise.withResolvers<Reply>();
      state.consumes.push({ reply, callback });
      state.consumeIssued.resolve();
      return reply.promise;
    },
    cancel: (): Promise<object> => {
      state.calls.push('cancel');
      const reply = Promise.withResolvers<object>();
      state.cancels.push(reply);
      if (state.cancelAnswers) {
        reply.resolve({});
      }
      return reply.promise;
    },
    close: (): Promise<void> => {
      state.calls.push('closeChannel');
      if (!state.closeAnswers) {
        return new Promise<void>(() => undefined);
      }
      // amqplib 2.0.1 on the channel's close-ok: the channel's `toClosed` (`lib/channel.js`)
      // rejects the replies still pending through `_rejectPending`, and its `close` event follows.
      queueMicrotask(() => {
        const closed = new Error('Channel closed');
        for (const { reply } of state.consumes) {
          reply.reject(closed);
        }
        for (const reply of state.cancels) {
          reply.reject(closed);
        }
        state.channelEvents.emit('close');
      });
      return Promise.resolve();
    },
    ack: (): void => {
      state.calls.push('ack');
    },
    nack: (): void => {
      state.calls.push('nack');
    },
    reject: (): void => {
      state.calls.push('reject');
    },
  };
  const model = {
    on: (event: string, fn: Listener): void => {
      state.modelEvents.on(event, fn);
    },
    createChannel: (): Promise<typeof channel> => Promise.resolve(channel),
    close: (): Promise<void> => {
      state.calls.push('close');
      if (!state.closeAnswers) {
        return new Promise<void>(() => undefined);
      }
      // amqplib 2.0.1 on the broker's close-ok, after the returned promise settles: the connection's
      // `toClosed` (`lib/connection.js`) closes every channel, each channel's `toClosed`
      // (`lib/channel.js`) rejects the replies still pending through `_rejectPending`, and the
      // `close` events follow.
      queueMicrotask(() => {
        const ended = new Error('Channel ended, no reply will be forthcoming');
        for (const { reply } of state.consumes) {
          reply.reject(ended);
        }
        for (const reply of state.cancels) {
          reply.reject(ended);
        }
        state.channelEvents.emit('close');
        state.modelEvents.emit('close');
      });
      return Promise.resolve();
    },
  };
  // The state object itself, not a copy: `reset` replaces fields the fakes read at call time.
  return { state, model };
});

vi.mock('amqplib', () => ({ connect: (): Promise<unknown> => Promise.resolve(fake.model) }));

const broker = fake.state;

/** The store port plus a watch that never resolves: no test here reaches a pause. */
class IdleStore extends TestStore implements StoreWatcher {
  watch(): Promise<'ready' | 'aborted'> {
    return new Promise(() => undefined);
  }
}

function captureLogger(): { logger: Logger; lines: LogLine[] } {
  const lines: LogLine[] = [];
  const logger = createLogger({
    service: 'test',
    level: 'debug',
    destination: {
      write: (line: string) => {
        lines.push(JSON.parse(line) as LogLine);
      },
    },
  });
  return { logger, lines };
}

const messages = (lines: LogLine[]): string[] => lines.map((line) => line.msg);

/** A consumer whose link is open and whose `consume` reply the fake broker has not sent. */
async function consumerWithPendingRegistration({
  transientAttempts = 5,
}: { transientAttempts?: number } = {}): Promise<{
  consumer: AmqpConsumer;
  store: IdleStore;
  lines: LogLine[];
}> {
  const store = new IdleStore();
  const { logger, lines } = captureLogger();
  const consumer = new AmqpConsumer({
    url: 'amqp://127.0.0.1:5672',
    heartbeatSeconds: 10,
    prefetch: 50,
    transientAttempts,
    shutdownTimeoutMs: SHUTDOWN_TIMEOUT_MS,
    store,
    logger,
    hostname: 'test',
  });
  consumer.storeReady();
  consumer.start();
  await broker.consumeIssued.promise;
  expect(consumer.state).toMatchObject({ name: 'open', consumer: 'registering' });
  return { consumer, store, lines };
}

/** The consume call at `index`; every test here issues at least one. */
function consumeCall(index: number): {
  reply: PromiseWithResolvers<Reply>;
  callback: (message: ConsumeMessage | null) => void;
} {
  const consume = broker.consumes[index];
  if (consume === undefined) {
    throw new Error(`no consume call ${String(index)}`);
  }
  return consume;
}

/**
 * One delivery as amqplib hands it to the consume callback, with the fields the consumer reads.
 * amqplib's `MessageProperties` declares every AMQP property as required; the consumer reads
 * `headers` and `messageId` only, hence the conversion through `unknown`.
 */
function delivery(message: TelemetryMessage, deliveryTag: number): ConsumeMessage {
  const shape = {
    content: Buffer.from(JSON.stringify(message), 'utf8'),
    fields: {
      consumerTag: 'tag-1',
      deliveryTag,
      redelivered: false,
      exchange: TELEMETRY_EXCHANGE,
      routingKey: TELEMETRY_ROUTING_KEY,
    },
    properties: {
      headers: HEADERS,
      messageId: `${message.deviceId}:${String(message.sessionId)}:${String(message.seq)}`,
    },
  };
  return shape as unknown as ConsumeMessage;
}

/** A consumer registered and idle, the normal state before a stop. */
async function registeredConsumer(options: { transientAttempts?: number } = {}): Promise<{
  consumer: AmqpConsumer;
  store: IdleStore;
  lines: LogLine[];
}> {
  const started = await consumerWithPendingRegistration(options);
  consumeCall(0).reply.resolve({ consumerTag: 'tag-1' });
  await vi.advanceTimersByTimeAsync(0);
  expect(started.consumer.state).toMatchObject({ name: 'open', consumer: 'active' });
  expect(started.consumer.stats().registered).toBe(true);
  return started;
}

/** A consumer stopped while the fake broker answered neither the consume reply nor the close. */
async function consumerStoppedWithoutAnyAnswer(): Promise<{
  consumer: AmqpConsumer;
  lines: LogLine[];
  stopped: () => boolean;
}> {
  const { consumer, lines } = await consumerWithPendingRegistration();
  broker.closeAnswers = false;
  let stopped = false;
  void consumer.stop().then(() => {
    stopped = true;
  });
  return { consumer, lines, stopped: () => stopped };
}

describe('AmqpConsumer against a broker that stops answering', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // Every backoff delay (the link's and a handler's) is half its ceiling, never a draw near zero
    // that would let a reconnect finish inside the same clock advance as the link's end.
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    broker.reset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('registers and stops normally when every reply arrives', async () => {
    const { consumer, lines } = await registeredConsumer();

    let stopped = false;
    void consumer.stop().then(() => {
      stopped = true;
    });
    await vi.advanceTimersByTimeAsync(IMMEDIATE_MS);
    expect(stopped).toBe(true);
    expect(consumer.state.name).toBe('stopped');
    // Decision 20: the cancel first, then the channel close and the connection close; nothing was
    // in flight, so no budget ran out.
    expect(broker.calls).toEqual(['consume', 'cancel', 'closeChannel', 'close']);
    expect(messages(lines)).not.toContain('shutdown drain ended at its budget');
  });

  it('closes the channel and waits for its close-ok before the connection close, after the last acknowledgement', async () => {
    const { consumer, lines } = await registeredConsumer();
    consumeCall(0).callback(delivery(exampleMessages.status, 1));
    await vi.advanceTimersByTimeAsync(1);
    expect(consumer.stats()).toMatchObject({ received: 1, acked: 1, inFlight: 0 });

    let stopped = false;
    void consumer.stop().then(() => {
      stopped = true;
    });
    await vi.advanceTimersByTimeAsync(IMMEDIATE_MS);
    expect(stopped).toBe(true);
    // T70: the acknowledgement, the cancel, the channel's close-ok, then the connection close.
    expect(broker.calls).toEqual(['consume', 'ack', 'cancel', 'closeChannel', 'close']);
    const closes = lines
      .filter((line) => line.msg.startsWith('amqp '))
      .map((line) => [line.msg, line['outcome']]);
    expect(closes).toEqual([
      ['amqp channel close', 'closed'],
      ['amqp connection close', 'closed'],
    ]);
  });

  it('stop() resolves at the drain budget while the consume reply is pending and the close answers', async () => {
    const { consumer, lines } = await consumerWithPendingRegistration();
    let stopped = false;
    void consumer.stop().then(() => {
      stopped = true;
    });

    await vi.advanceTimersByTimeAsync(SHUTDOWN_TIMEOUT_MS - 1);
    expect(stopped).toBe(false);
    await vi.advanceTimersByTimeAsync(1 + IMMEDIATE_MS);
    expect(stopped).toBe(true);

    expect(consumer.state.name).toBe('stopped');
    // No registration to cancel; the link is closed without waiting for the reply.
    expect(broker.calls).toEqual(['consume', 'closeChannel', 'close']);
    expect(messages(lines)).toContain('shutdown drain ended at its budget');
    expect(messages(lines)).not.toContain('shutdown ended before the link closed');
  });

  it('stop() resolves at the drain budget plus the close budget when the broker answers nothing', async () => {
    const { consumer, lines, stopped } = await consumerStoppedWithoutAnyAnswer();
    const { generation } = consumer.state;

    // At the drain budget the channel close is attempted at once, and stop() waits for it.
    await vi.advanceTimersByTimeAsync(SHUTDOWN_TIMEOUT_MS + IMMEDIATE_MS);
    expect(stopped()).toBe(false);
    expect(broker.calls).toEqual(['consume', 'closeChannel']);
    // The shutdown's bound and the channel close's share of the close budget both run from the
    // drain budget; the connection close follows with nothing left of the budget.
    await vi.advanceTimersByTimeAsync(AMQP_CLOSE_TIMEOUT_MS - IMMEDIATE_MS - 1);
    expect(stopped()).toBe(false);
    expect(broker.calls).toEqual(['consume', 'closeChannel']);
    await vi.advanceTimersByTimeAsync(1 + IMMEDIATE_MS);
    expect(stopped()).toBe(true);
    // The connection close is still attempted, one immediate after the channel close gave up; its
    // empty bound runs out one immediate after that.
    await vi.advanceTimersByTimeAsync(IMMEDIATE_MS);
    expect(broker.calls).toEqual(['consume', 'closeChannel', 'close']);

    expect(consumer.state.name).toBe('stopped');
    const warnings = lines.filter((line) => line.level === WARN);
    expect(messages(warnings)).toEqual([
      'shutdown drain ended at its budget',
      'amqp channel close',
      'shutdown ended before the link closed',
      'amqp connection close',
    ]);
    expect(warnings[1]).toMatchObject({ outcome: 'timed_out', timeoutMs: AMQP_CLOSE_TIMEOUT_MS });
    expect(warnings[2]).toMatchObject({ generation, timeoutMs: AMQP_CLOSE_TIMEOUT_MS });
    expect(warnings[3]).toMatchObject({ outcome: 'timed_out', timeoutMs: AMQP_CLOSE_TIMEOUT_MS });
  });

  it('ignores the link ending after stop() gave up on the close', async () => {
    const { consumer, stopped } = await consumerStoppedWithoutAnyAnswer();
    await vi.advanceTimersByTimeAsync(SHUTDOWN_TIMEOUT_MS + AMQP_CLOSE_TIMEOUT_MS + IMMEDIATE_MS);
    expect(stopped()).toBe(true);

    // The heartbeat timeout ends the link later: amqplib rejects the pending reply and closes;
    // the queued effects run with nothing left to do, and no second close is attempted.
    consumeCall(0).reply.reject(new Error('Channel ended, no reply will be forthcoming'));
    broker.channelEvents.emit('close');
    broker.modelEvents.emit('close', new Error('Heartbeat timeout'));
    await vi.advanceTimersByTimeAsync(0);
    expect(broker.calls).toEqual(['consume', 'closeChannel', 'close']);
    expect(consumer.state.name).toBe('stopped');
  });

  it('aborts a handler in flight at the drain budget while the chain waits for the cancel reply', async () => {
    const RETRIES = 50;
    const { consumer, store, lines } = await registeredConsumer({ transientAttempts: RETRIES + 1 });
    // Every event insert fails transiently: the handler retries with a backoff sleep on the
    // registration's signal, so it stays in flight, asleep or between two attempts, until aborted.
    // With the pinned draw its first sleep is 100 ms, the same as the drain budget; the assertions
    // below hold whichever of the two ends first, because they count neither attempts nor sleeps.
    for (let i = 0; i < RETRIES; i += 1) {
      store.answer('insertEvent', { outcome: 'fail', failure: NETWORK_FAILURE });
    }
    consumeCall(0).callback(delivery(exampleMessages.status, 1));
    await vi.advanceTimersByTimeAsync(0);
    expect(consumer.stats()).toMatchObject({ received: 1, inFlight: 1 });
    expect(messages(lines)).toContain('transient store failure');

    // The broker answers neither the cancel nor the close: the chain is blocked on the cancel for
    // the cancel's own bound, so only the direct abort can end the handler at the drain budget.
    broker.cancelAnswers = false;
    broker.closeAnswers = false;
    let stopped = false;
    void consumer.stop().then(() => {
      stopped = true;
    });
    await vi.advanceTimersByTimeAsync(SHUTDOWN_TIMEOUT_MS + IMMEDIATE_MS);
    expect(consumer.stats()).toMatchObject({ inFlight: 0, abandoned: 1, acked: 0, rejected: 0 });
    expect(broker.calls).toEqual(['consume', 'cancel', 'closeChannel']);
    expect(stopped).toBe(false);
    expect(messages(lines)).toContain('shutdown drain ended at its budget');

    await vi.advanceTimersByTimeAsync(AMQP_CLOSE_TIMEOUT_MS);
    expect(stopped).toBe(true);
    // Nothing was acknowledged through the void registration: the broker requeues the delivery.
    expect(broker.calls).toEqual(['consume', 'cancel', 'closeChannel', 'close']);
    expect(consumer.state.name).toBe('stopped');
  });

  it('ends the link and reconnects when the consume reply does not arrive within the setup budget', async () => {
    const { consumer, store, lines } = await consumerWithPendingRegistration();
    const { generation } = consumer.state;

    await vi.advanceTimersByTimeAsync(AMQP_SETUP_TIMEOUT_MS - 1);
    expect(consumer.state).toMatchObject({ name: 'open', consumer: 'registering' });
    await vi.advanceTimersByTimeAsync(1 + IMMEDIATE_MS);
    expect(messages(lines)).toContain('consume timed out');
    expect(consumer.state.name).toBe('backoff');
    expect(consumer.stats().registered).toBe(false);
    expect(broker.calls).toEqual(['consume', 'close']);
    // The link was open for the whole setup budget, which is the reset threshold: attempt 0.
    expect(lines.find((line) => line.msg === 'consumer reconnect scheduled')).toMatchObject({
      reason: 'consume_timed_out',
      attempt: 0,
    });

    // A delivery that reaches the void registration is not taken: nothing could acknowledge it.
    consumeCall(0).callback(delivery(exampleMessages.status, 1));
    await vi.advanceTimersByTimeAsync(0);
    expect(consumer.stats()).toMatchObject({ received: 0, inFlight: 0 });
    expect(store.calls).toEqual([]);
    // The late reply changes nothing either.
    consumeCall(0).reply.resolve({ consumerTag: 'late' });
    await vi.advanceTimersByTimeAsync(0);
    expect(messages(lines)).not.toContain('consumer registered');
    expect(consumer.state.name).toBe('backoff');

    // The backoff elapses (attempt 0: at most the base delay), a new link opens and registers again.
    broker.consumeIssued = Promise.withResolvers<void>();
    await vi.advanceTimersByTimeAsync(LINK_BACKOFF_BASE_MS + IMMEDIATE_MS);
    await broker.consumeIssued.promise;
    expect(broker.calls).toEqual(['consume', 'close', 'consume']);
    expect(consumer.state).toMatchObject({ name: 'open', consumer: 'registering' });
    expect(consumer.state.generation).toBeGreaterThan(generation);

    let stopped = false;
    void consumer.stop().then(() => {
      stopped = true;
    });
    await vi.advanceTimersByTimeAsync(SHUTDOWN_TIMEOUT_MS + IMMEDIATE_MS);
    expect(stopped).toBe(true);
  });
});
