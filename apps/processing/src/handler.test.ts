import {
  MAX_FRAME_BYTES,
  RECEIVED_AT_HEADER,
  createLogger,
  type DeviceStateDocument,
  type Logger,
  type TelemetryMessage,
} from '@telemetry/shared';
import { describe, expect, it } from 'vitest';

import type { StoreFailure } from './failure.js';
import {
  EXAMPLE_PROCESSED_AT,
  EXAMPLE_RECEIVED_AT,
  exampleAlert,
  exampleEvents,
  exampleMessages,
  exampleState,
} from './fixtures.js';
import { processDelivery, type HandlerInput, type HandlerResult } from './handler.js';
import { TestStore, type StoreMethod } from './test-store.js';

type LogLine = { msg: string; level: number; [field: string]: unknown };

const DEBUG = 20;
const INFO = 30;
const WARN = 40;
const ERROR = 50;

const HEADERS = { [RECEIVED_AT_HEADER]: EXAMPLE_RECEIVED_AT };
const NETWORK_FAILURE: StoreFailure = { kind: 'network', message: 'connection reset' };
const PERMANENT_FAILURE: StoreFailure = {
  kind: 'server',
  code: 121,
  codeName: 'DocumentValidationFailure',
  labels: [],
  message: 'Document failed validation',
};
const CLOSED_FAILURE: StoreFailure = { kind: 'closed', message: 'client was closed' };

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

function bodyOf(message: TelemetryMessage): Buffer {
  return Buffer.from(JSON.stringify(message), 'utf8');
}

type Harness = {
  store: TestStore;
  controller: AbortController;
  /** The delays the handler asked for, in order. */
  sleeps: number[];
  lines: LogLine[];
  /** A property, not a method: the tests destructure it, which the unbound-method rule forbids for methods. */
  run: (message: TelemetryMessage, overrides?: Partial<HandlerInput>) => Promise<HandlerResult>;
};

/**
 * One handler run with a `TestStore`, an injected sleep that records its delay and resolves at
 * once (or rejects when the signal is already aborted, as the real one does), a fixed clock and a
 * fixed random draw of 0.5, so every backoff delay is half the ceiling.
 */
function harness({ transientAttempts = 3 }: { transientAttempts?: number } = {}): Harness {
  const store = new TestStore();
  const controller = new AbortController();
  const sleeps: number[] = [];
  const { logger, lines } = captureLogger();
  const sleep = (ms: number, signal: AbortSignal): Promise<void> => {
    sleeps.push(ms);
    return signal.aborted ? Promise.reject(new Error('aborted')) : Promise.resolve();
  };
  return {
    store,
    controller,
    sleeps,
    lines,
    run: (message, overrides = {}) =>
      processDelivery({
        content: bodyOf(message),
        headers: HEADERS,
        redelivered: false,
        store,
        clock: () => EXAMPLE_PROCESSED_AT,
        sleep,
        random: () => 0.5,
        signal: controller.signal,
        transientAttempts,
        logger,
        ...overrides,
      }),
  };
}

const methodsOf = (store: TestStore): StoreMethod[] => store.calls.map((call) => call.method);
const identityFields = { deviceId: 'dev-0001', sessionId: 1_700_000_000_000, seq: 1 };

describe('processDelivery', () => {
  it('inserts the event, applies the state, acknowledges, and logs the outcome at debug', async () => {
    const { store, lines, run } = harness();

    const result = await run(exampleMessages.status);

    expect(store.calls).toEqual([
      { method: 'insertEvent', doc: exampleEvents.status },
      { method: 'applyState', message: exampleMessages.status, receivedAt: EXAMPLE_RECEIVED_AT },
    ]);
    expect(result).toEqual({
      verdict: 'ack',
      outcome: 'created',
      duplicate: false,
      alert: 'none',
      gap: false,
      attempts: 1,
    });
    expect(lines.filter((line) => line.msg === 'delivery processed')).toEqual([
      expect.objectContaining({
        ...identityFields,
        level: DEBUG,
        outcome: 'created',
        duplicate: false,
        redelivered: false,
        alert: 'none',
        attempts: 1,
      }),
    ]);
  });

  it('logs the redelivered flag of the delivery as it was given', async () => {
    const { lines, run } = harness();

    await run(exampleMessages.status, { redelivered: true });

    expect(lines.find((line) => line.msg === 'delivery processed')).toMatchObject({
      redelivered: true,
    });
  });

  it('creates the alert of an error diagnostic after the two writes', async () => {
    const { store, run } = harness();

    const result = await run(exampleMessages.diagnostic);

    expect(methodsOf(store)).toEqual(['insertEvent', 'applyState', 'insertAlert']);
    expect(store.calls[2]).toEqual({ method: 'insertAlert', doc: exampleAlert });
    expect(result).toMatchObject({ verdict: 'ack', alert: 'created' });
  });

  it('reports the alert as existing when its insert hit the identity already stored', async () => {
    const { store, run } = harness();
    store.answer('insertAlert', { outcome: 'duplicate' });

    const result = await run(exampleMessages.diagnostic);

    expect(methodsOf(store)).toEqual(['insertEvent', 'applyState', 'insertAlert']);
    expect(result).toMatchObject({ verdict: 'ack', alert: 'exists' });
  });

  it.each(['info', 'warning'] as const)(
    'creates no alert for a %s diagnostic',
    async (severity) => {
      const { store, run } = harness();
      const message = {
        ...exampleMessages.diagnostic,
        payload: { ...exampleMessages.diagnostic.payload, severity },
      };

      const result = await run(message);

      expect(methodsOf(store)).toEqual(['insertEvent', 'applyState']);
      expect(result).toMatchObject({ verdict: 'ack', alert: 'none' });
    },
  );

  it('still applies the state after a duplicate event insert and logs the delivery at info', async () => {
    const { store, lines, run } = harness();
    store.answer('insertEvent', { outcome: 'duplicate' });

    const result = await run(exampleMessages.status);

    expect(methodsOf(store)).toEqual(['insertEvent', 'applyState']);
    expect(result).toMatchObject({ verdict: 'ack', outcome: 'created', duplicate: true });
    expect(lines.find((line) => line.msg === 'delivery processed')).toMatchObject({
      level: INFO,
      duplicate: true,
    });
    expect(lines.find((line) => line.msg === 'event already stored')).toMatchObject({
      ...identityFields,
      level: DEBUG,
    });
  });

  it('reports stale at info when the stored section has the same key', async () => {
    const { store, lines, run } = harness();
    store.answer('applyState', { outcome: 'ok', before: exampleState });

    const result = await run(exampleMessages.metrics);

    expect(result).toMatchObject({ verdict: 'ack', outcome: 'stale', duplicate: false });
    expect(lines.find((line) => line.msg === 'delivery processed')).toMatchObject({
      level: INFO,
      outcome: 'stale',
    });
  });

  it('absorbs a redelivered message the stopped instance had stored and applied as a stale duplicate', async () => {
    // T70: a graceful stop can leave acknowledgements unapplied, so the next instance receives the
    // message again with `redelivered: true`. Its event insert hits the unique index and the
    // state guard finds the section at the message's own key: no write, no alert, one info line.
    const { store, lines, run } = harness();
    store.answer('insertEvent', { outcome: 'duplicate' });
    store.answer('applyState', { outcome: 'ok', before: exampleState });

    const result = await run(exampleMessages.metrics, { redelivered: true });

    expect(methodsOf(store)).toEqual(['insertEvent', 'applyState']);
    expect(result).toMatchObject({ verdict: 'ack', outcome: 'stale', duplicate: true });
    expect(lines.find((line) => line.msg === 'delivery processed')).toMatchObject({
      level: INFO,
      outcome: 'stale',
      duplicate: true,
      redelivered: true,
    });
  });

  it('logs a sequence gap with the previous and the received seq', async () => {
    const { store, lines, run } = harness();
    const before: DeviceStateDocument = {
      _id: 'dev-0001',
      lastEvent: {
        sessionId: exampleMessages.status.sessionId,
        seq: 2,
        type: 'status',
        receivedAt: EXAMPLE_RECEIVED_AT,
      },
    };
    store.answer('applyState', { outcome: 'ok', before });

    const result = await run({ ...exampleMessages.status, seq: 5 });

    expect(result).toMatchObject({ verdict: 'ack', outcome: 'applied', gap: true });
    expect(lines.find((line) => line.msg === 'sequence gap')).toMatchObject({
      deviceId: 'dev-0001',
      seq: 5,
      level: INFO,
      previousSeq: 2,
    });
  });

  it('uses its clock as receivedAt when the header is missing, and says so at warn', async () => {
    const { store, lines, run } = harness();

    await run(exampleMessages.status, { headers: undefined });

    expect(store.calls).toEqual([
      {
        method: 'insertEvent',
        doc: { ...exampleEvents.status, receivedAt: EXAMPLE_PROCESSED_AT },
      },
      { method: 'applyState', message: exampleMessages.status, receivedAt: EXAMPLE_PROCESSED_AT },
    ]);
    expect(lines.find((line) => line.msg === 'received-at header missing')).toMatchObject({
      ...identityFields,
      level: WARN,
      receivedAt: EXAMPLE_PROCESSED_AT,
    });
  });

  it.each<{ step: StoreMethod; calls: number }>([
    { step: 'insertEvent', calls: 1 },
    { step: 'applyState', calls: 2 },
    { step: 'insertAlert', calls: 3 },
  ])('rejects on a permanent failure at $step and logs it at error', async ({ step, calls }) => {
    const { store, lines, run } = harness();
    store.answer(step, { outcome: 'fail', failure: PERMANENT_FAILURE });

    const result = await run(exampleMessages.diagnostic);

    expect(result).toEqual({ verdict: 'reject', reason: 'permanent', attempts: 1 });
    expect(store.calls).toHaveLength(calls);
    expect(lines.find((line) => line.msg === 'permanent store failure')).toMatchObject({
      deviceId: 'dev-0001',
      seq: 4,
      level: ERROR,
      step,
      failure: { kind: 'server', code: 121 },
    });
  });

  it('retries the whole sequence from the event insert after a transient failure', async () => {
    const { store, lines, sleeps, run } = harness();
    store.answer('insertEvent', { outcome: 'fail', failure: NETWORK_FAILURE });

    const result = await run(exampleMessages.status);

    expect(result).toMatchObject({ verdict: 'ack', attempts: 2 });
    expect(methodsOf(store)).toEqual(['insertEvent', 'insertEvent', 'applyState']);
    expect(sleeps).toEqual([100]);
    expect(lines.filter((line) => line.msg === 'transient store failure')).toEqual([
      expect.objectContaining({
        ...identityFields,
        level: WARN,
        attempt: 1,
        step: 'insertEvent',
        failure: { kind: 'network', message: 'connection reset' },
      }),
    ]);
  });

  it('abandons as store_unavailable once the attempts are used up', async () => {
    const { store, sleeps, run } = harness({ transientAttempts: 3 });
    for (let i = 0; i < 3; i += 1) {
      store.answer('insertEvent', { outcome: 'fail', failure: NETWORK_FAILURE });
    }

    const result = await run(exampleMessages.status);

    expect(result).toEqual({ verdict: 'abandon', cause: 'store_unavailable', attempts: 3 });
    expect(methodsOf(store)).toEqual(['insertEvent', 'insertEvent', 'insertEvent']);
    expect(sleeps).toEqual([100, 200]);
  });

  it('abandons as aborted when the signal fires during the backoff sleep', async () => {
    const { store, controller, run } = harness();
    store.answer('insertEvent', { outcome: 'fail', failure: NETWORK_FAILURE });
    const abortingSleep = (): Promise<void> => {
      controller.abort();
      return Promise.reject(new Error('aborted'));
    };

    const result = await run(exampleMessages.status, { sleep: abortingSleep });

    expect(result).toEqual({ verdict: 'abandon', cause: 'aborted', attempts: 1 });
    expect(methodsOf(store)).toEqual(['insertEvent']);
  });

  it('abandons before the first write when the signal is already aborted', async () => {
    const { store, controller, run } = harness();
    controller.abort();

    const result = await run(exampleMessages.status);

    expect(result).toEqual({ verdict: 'abandon', cause: 'aborted', attempts: 1 });
    expect(store.calls).toEqual([]);
  });

  // One case per abort check after a write: before the state write, before the alert insert, and
  // before the acknowledgement. A check that vanished would let the next write, or the ack, run.
  it.each<{ after: StoreMethod; message: TelemetryMessage; calls: StoreMethod[] }>([
    { after: 'insertEvent', message: exampleMessages.status, calls: ['insertEvent'] },
    {
      after: 'applyState',
      message: exampleMessages.diagnostic,
      calls: ['insertEvent', 'applyState'],
    },
    {
      after: 'insertAlert',
      message: exampleMessages.diagnostic,
      calls: ['insertEvent', 'applyState', 'insertAlert'],
    },
  ])(
    'stops at the next check when the signal fires after $after',
    async ({ after, message, calls }) => {
      const { store, controller, run } = harness();
      store.onCall = (call) => {
        if (call.method === after) {
          controller.abort();
        }
      };

      const result = await run(message);

      expect(result).toEqual({ verdict: 'abandon', cause: 'aborted', attempts: 1 });
      expect(methodsOf(store)).toEqual(calls);
    },
  );

  it('stops before the second state write when the signal fires after a collided first one', async () => {
    const { store, controller, run } = harness();
    store.answer('applyState', { outcome: 'duplicate' });
    store.onCall = (call) => {
      if (call.method === 'applyState') {
        controller.abort();
      }
    };

    const result = await run(exampleMessages.status);

    expect(result).toEqual({ verdict: 'abandon', cause: 'aborted', attempts: 1 });
    expect(methodsOf(store)).toEqual(['insertEvent', 'applyState']);
  });

  it('abandons as closed when the client was closed under it', async () => {
    const { store, lines, run } = harness();
    store.answer('applyState', { outcome: 'fail', failure: CLOSED_FAILURE });

    const result = await run(exampleMessages.status);

    expect(result).toEqual({ verdict: 'abandon', cause: 'closed', attempts: 1 });
    expect(lines.find((line) => line.msg === 'store closed')).toMatchObject({
      ...identityFields,
      level: WARN,
      step: 'applyState',
    });
  });

  it.each([
    {
      reason: 'body_too_large',
      content: Buffer.alloc(MAX_FRAME_BYTES + 1, 'x'),
      identity: {},
    },
    { reason: 'invalid_utf8', content: Buffer.from([0xff, 0xfe]), identity: {} },
    { reason: 'invalid_json', content: Buffer.from('not json', 'utf8'), identity: {} },
    {
      reason: 'invalid_schema',
      content: Buffer.from('{"type":"bogus","deviceId":"dev-0001"}', 'utf8'),
      identity: { deviceId: 'dev-0001' },
    },
  ] as const)(
    'rejects a body that fails to decode as $reason without a store call',
    async ({ reason, content, identity }) => {
      const { store, lines, run } = harness();

      const result = await run(exampleMessages.status, { content });

      expect(result).toEqual({ verdict: 'reject', reason, attempts: 0 });
      expect(store.calls).toEqual([]);
      expect(lines.filter((line) => line.msg === 'message rejected')).toEqual([
        expect.objectContaining({ ...identity, level: WARN, reason, bytes: content.length }),
      ]);
    },
  );

  it('retries the state write once within the attempt when the first upsert collided', async () => {
    const { store, sleeps, run } = harness();
    store.answer('applyState', { outcome: 'duplicate' });

    const result = await run(exampleMessages.status);

    expect(result).toMatchObject({ verdict: 'ack', attempts: 1 });
    expect(methodsOf(store)).toEqual(['insertEvent', 'applyState', 'applyState']);
    expect(sleeps).toEqual([]);
  });

  it('takes the transient path when the state write collided twice', async () => {
    const { store, lines, sleeps, run } = harness();
    store.answer('applyState', { outcome: 'duplicate' });
    store.answer('applyState', { outcome: 'duplicate' });

    const result = await run(exampleMessages.status);

    expect(result).toMatchObject({ verdict: 'ack', attempts: 2 });
    expect(methodsOf(store)).toEqual([
      'insertEvent',
      'applyState',
      'applyState',
      'insertEvent',
      'applyState',
    ]);
    expect(sleeps).toEqual([100]);
    expect(lines.filter((line) => line.msg === 'transient store failure')).toEqual([
      expect.objectContaining({
        level: WARN,
        attempt: 1,
        step: 'applyState',
        failure: expect.objectContaining({ kind: 'server', code: 11000 }) as StoreFailure,
      }),
    ]);
  });

  it('rejects as permanent and logs a programmer error that escaped the store', async () => {
    const { store, lines, run } = harness();
    store.answer('insertEvent', { outcome: 'throw', error: new TypeError('bug') });

    const result = await run(exampleMessages.status);

    expect(result).toEqual({ verdict: 'reject', reason: 'permanent', attempts: 1 });
    expect(lines.find((line) => line.msg === 'handler failed')).toMatchObject({
      ...identityFields,
      level: ERROR,
      err: expect.objectContaining({ type: 'TypeError', message: 'bug' }) as unknown,
    });
  });
});
