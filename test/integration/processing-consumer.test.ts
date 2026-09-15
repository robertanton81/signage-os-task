import {
  DEAD_LETTER_QUEUE,
  MAX_FRAME_BYTES,
  TELEMETRY_QUEUE,
  messageIdentity,
  type TelemetryMessage,
} from '@telemetry/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  SESSION_A,
  deleteAlertDocument,
  deleteStateDocument,
  holdInserts,
  identitiesOf,
  messages,
  openDirectPublisher,
  queueDepth,
  readAlerts,
  readEvents,
  readState,
  sectionKey,
  stateMismatches,
  type DirectPublisher,
  type MessageBuilder,
  type QueueDepth,
} from '../harness/clients.js';
import {
  bindEnvironment,
  createEnvironment,
  type TestEnvironment,
} from '../harness/environment.js';
import { generateLoad, mergeExpected } from '../harness/load.js';
import {
  freePorts,
  spawnService,
  startProcessing,
  type ProcessingInstance,
  type StartProcessingOptions,
} from '../harness/services.js';
import { pause, restart, stop } from '../harness/stack.js';
import { WARN_LEVEL, byMsg, type LogLine } from '../harness/wait.js';

/** The consumer's `AMQP_CLOSE_TIMEOUT_MS` and the store's default `MONGODB_TIMEOUT_MS`: terms of the shutdown bounds. */
const AMQP_CLOSE_TIMEOUT_MS = 2_000;
const MONGODB_TIMEOUT_MS = 5_000;

let created: TestEnvironment | undefined;

beforeEach(async () => {
  created = await createEnvironment();
});

afterEach(async () => {
  const current = created;
  created = undefined;
  await current?.dispose();
});

const environment = (signal: AbortSignal): TestEnvironment => bindEnvironment(created, signal);

/** A processing instance whose consumer is registered, so it receives what the test publishes next. */
async function registeredProcessing(
  context: TestEnvironment,
  options: StartProcessingOptions = {},
): Promise<ProcessingInstance> {
  const instance = await startProcessing(context, options);
  await instance.logs.waitForLine(byMsg('consumer registered'));
  return instance;
}

/** In order, each confirmed before the next goes out. */
async function publishAll(
  publisher: DirectPublisher,
  sends: readonly TelemetryMessage[],
): Promise<void> {
  for (const message of sends) {
    await publisher.publish(message);
  }
}

function identities(sent: readonly TelemetryMessage[]): Set<string> {
  return new Set(sent.map((message) => messageIdentity(message)));
}

/** status, metrics, counters, info diagnostic, in rotation by `seq`. */
function rotating(build: MessageBuilder, seq: number): TelemetryMessage {
  switch (seq % 4) {
    case 1:
      return build.status(seq);
    case 2:
      return build.metrics(seq);
    case 3:
      return build.counters(seq);
    default:
      return build.diagnostic(seq, { severity: 'info' });
  }
}

/** The store failure of a timed-out operation against a frozen server: the socket timeout, or the server's MaxTimeMSExpired (50). */
function isTimeoutFailure(failure: unknown): boolean {
  if (typeof failure !== 'object' || failure === null) {
    return false;
  }
  const { kind, code } = failure as { kind?: unknown; code?: unknown };
  return kind === 'network' || (kind === 'server' && code === 50);
}

/** The keys `rotating` leaves per section after `count` messages of one device. */
function rotatingKeys(
  count: number,
): Record<'status' | 'metrics' | 'counters' | 'diagnostic', number> {
  const highest = (remainder: number): number => {
    let seq = count;
    while (seq > 0 && seq % 4 !== remainder) {
      seq -= 1;
    }
    return seq;
  };
  return { status: highest(1), metrics: highest(2), counters: highest(3), diagnostic: highest(0) };
}

describe('processing consumer against RabbitMQ and MongoDB', () => {
  it('C6 two instances on one queue end in one consistent state', async ({ signal }) => {
    const env = environment(signal);
    const a = await registeredProcessing(env, { hostname: 'a' });
    const b = await registeredProcessing(env, { hostname: 'b' });
    const { sends, expected } = generateLoad({
      devices: 20,
      messages: 1000,
      hotShare: 0.25,
      duplicatePercent: 5,
      swapPercent: 5,
      seed: 2,
    });
    const publisher = await openDirectPublisher(env);
    await publishAll(publisher, sends);
    await env.waitFor(
      () => {
        const [sa, sb] = [a.stats(), b.stats()];
        return sa.acked + sb.acked === sends.length && sa.inFlight === 0 && sb.inFlight === 0;
      },
      { describe: () => `a ${JSON.stringify(a.stats())}, b ${JSON.stringify(b.stats())}` },
    );

    const events = await readEvents(env);
    expect(identitiesOf(events)).toEqual(expected.identities);
    expect(events).toHaveLength(expected.identities.size);
    expect(await stateMismatches(env, expected)).toEqual([]);
    expect(new Set((await readAlerts(env)).map((alert) => alert._id))).toEqual(expected.alerts);
    const [sa, sb] = [a.stats(), b.stats()];
    const detail = `a ${JSON.stringify(sa)}, b ${JSON.stringify(sb)}`;
    expect(sa.received, detail).toBeGreaterThan(0);
    expect(sb.received, detail).toBeGreaterThan(0);
    expect(sa.duplicate + sb.duplicate, detail).toBeGreaterThanOrEqual(expected.duplicates);
    expect([sa.failed, sb.failed], detail).toEqual([0, 0]);
  }, 60_000);

  it('C7 poison bodies are dead-lettered once, with nothing stored', async ({ signal }) => {
    const env = environment(signal);
    const processing = await registeredProcessing(env);
    const publisher = await openDirectPublisher(env);
    const build = messages('c7-device', SESSION_A);
    const text = JSON.stringify(build.diagnostic(3, { message: 'bad byte follows' }));
    const cut = text.indexOf('follows');
    const invalidUtf8 = Buffer.concat([
      Buffer.from(text.slice(0, cut), 'utf8'),
      Buffer.from([0xff]),
      Buffer.from(text.slice(cut), 'utf8'),
    ]);
    const bodies: [string, Buffer][] = [
      ['invalid_json', Buffer.from('not json', 'utf8')],
      ['invalid_schema', Buffer.from(JSON.stringify({ ...build.status(2), seq: -1 }), 'utf8')],
      ['invalid_utf8', invalidUtf8],
      // 70 KiB: above the 64 KiB frame bound, which processing applies to the AMQP body as well.
      ['body_too_large', Buffer.alloc(MAX_FRAME_BYTES + 6 * 1024, 0x20)],
    ];
    for (const [, body] of bodies) {
      await publisher.publishRaw(body, { contentType: 'application/json' });
    }
    await env.waitFor(async () => (await queueDepth(env, DEAD_LETTER_QUEUE))?.ready === 4, {
      describe: () => `stats ${JSON.stringify(processing.stats())}`,
    });

    const dead = await env.management.getMessages(DEAD_LETTER_QUEUE, 4);
    expect(dead).toHaveLength(4);
    for (const message of dead) {
      const deaths = message.properties.headers?.['x-death'] as
        { reason?: string; queue?: string }[] | undefined;
      // `rejected`, never `delivery_limit`: rejected once, never requeued and retried.
      expect(deaths?.[0]).toMatchObject({ reason: 'rejected', queue: TELEMETRY_QUEUE });
    }
    expect(await readEvents(env)).toEqual([]);
    expect(await readAlerts(env)).toEqual([]);
    expect(await readState(env, 'c7-device')).toBeNull();
    const rejected = processing.logs.filter(byMsg('message rejected'));
    expect(rejected).toHaveLength(4);
    expect(rejected.every((line) => line.level === WARN_LEVEL)).toBe(true);
    expect(new Set(rejected.map((line) => line['reason']))).toEqual(
      new Set(bodies.map(([reason]) => reason)),
    );
    expect(processing.stats()).toMatchObject({ rejected: 4, failed: 0, acked: 0 });
  });

  it('C12 wrong database credentials: not ready, still linked to the broker, stoppable', async ({
    signal,
  }) => {
    const env = environment(signal);
    const wrong = await startProcessing(env, { overrides: { MONGODB_URL: env.wrongMongoUrl } });
    await env.waitFor(() => wrong.logs.filter(byMsg('store not ready')).length >= 3, {
      describe: () => wrong.logs.messages().join(' | '),
    });

    const notReady = wrong.logs.filter(byMsg('store not ready'));
    expect(notReady.every((line) => line.level === WARN_LEVEL)).toBe(true);
    expect(notReady[0]).toMatchObject({ failure: { kind: 'server', code: 18 } });
    expect(await wrong.readiness()).toEqual({
      status: 503,
      body: { status: 'not_ready', reason: 'mongodb' },
    });
    expect(['connecting', 'open']).toContain(wrong.consumer.state.name);
    // The wrong password is the right one with `-wrong` appended; no line may carry it.
    expect(JSON.stringify(wrong.logs.lines())).not.toContain('-wrong');
    const startedAt = performance.now();
    await wrong.stop();
    expect(performance.now() - startedAt).toBeLessThan(MONGODB_TIMEOUT_MS);
    const right = await startProcessing(env);
    await env.waitFor(async () => (await right.readiness()).status === 200, {
      describe: () => `state ${JSON.stringify(right.consumer.state)}`,
    });
  });

  it('C13 a redelivery after a crash between the event insert and the state update completes both missing writes once', async ({
    signal,
  }) => {
    const env = environment(signal);
    const processing = await registeredProcessing(env);
    const publisher = await openDirectPublisher(env);
    const message = messages('c13-device', SESSION_A).diagnostic(1, { severity: 'error' });
    const identity = messageIdentity(message);
    await publisher.publish(message);
    await env.awaitAcked(processing, 1);
    // The crash: the event is stored, the state and the alert are not.
    await deleteStateDocument(env, 'c13-device');
    await deleteAlertDocument(env, identity);
    await publisher.publish(message);
    await env.awaitAcked(processing, 2);

    const state = await readState(env, 'c13-device');
    expect(sectionKey(state, 'diagnostic')).toEqual({ sessionId: SESSION_A, seq: 1 });
    expect(state?.lastEvent).toMatchObject({ sessionId: SESSION_A, seq: 1 });
    expect((await readAlerts(env)).map((alert) => alert._id)).toEqual([identity]);
    expect(await readEvents(env)).toHaveLength(1);
    const stats = processing.stats();
    expect(stats, `stats ${JSON.stringify(stats)}`).toMatchObject({
      duplicate: 1,
      created: 2,
      alerts: 2,
      failed: 0,
    });
  });

  it('C14 a redelivery after a crash between the state update and the alert insert creates the alert once and leaves the state as it was', async ({
    signal,
  }) => {
    const env = environment(signal);
    const processing = await registeredProcessing(env);
    const publisher = await openDirectPublisher(env);
    const message = messages('c14-device', SESSION_A).diagnostic(1, { severity: 'error' });
    const identity = messageIdentity(message);
    await publisher.publish(message);
    await env.awaitAcked(processing, 1);
    const before = await readState(env, 'c14-device');
    expect(before).not.toBeNull();
    // The crash: the event and the state are stored, the alert is not.
    await deleteAlertDocument(env, identity);
    await publisher.publish(message);
    await env.awaitAcked(processing, 2);

    expect((await readAlerts(env)).map((alert) => alert._id)).toEqual([identity]);
    expect(await readState(env, 'c14-device')).toEqual(before);
    expect(await readEvents(env)).toHaveLength(1);
    const stats = processing.stats();
    expect(stats, `stats ${JSON.stringify(stats)}`).toMatchObject({
      duplicate: 1,
      stale: 1,
      alerts: 2,
      failed: 0,
    });
  });

  it('C8 MongoDB stopped, then back: the consumer pauses, returns what it holds and resumes', async ({
    signal,
  }) => {
    const env = environment(signal);
    // Shorter than the defaults (5 000 ms, 5 attempts): every attempt against a stopped server
    // waits the whole server selection timeout, and the pause must arrive inside the budget.
    const processing = await registeredProcessing(env, {
      overrides: { MONGODB_TIMEOUT_MS: '1000', PROCESSING_TRANSIENT_ATTEMPTS: '3' },
    });
    await env.waitFor(async () => (await processing.readiness()).status === 200, {
      describe: () => `state ${JSON.stringify(processing.consumer.state)}`,
    });
    const recover = await stop(env, 'mongodb');
    const publisher = await openDirectPublisher(env);
    const builds = [messages('c8-a', SESSION_A), messages('c8-b', SESSION_A)];
    const sends = Array.from({ length: 15 }, (_, index) => index + 1).flatMap((seq) =>
      builds.map((build) => rotating(build, seq)),
    );
    await publishAll(publisher, sends);

    const paused = await processing.logs.waitForLine(byMsg('consumer paused'));
    const returned = Number(paused['returned']);
    expect(paused.level).toBe(WARN_LEVEL);
    expect(returned).toBeGreaterThanOrEqual(1);
    expect(await processing.readiness()).toEqual({
      status: 503,
      body: { status: 'not_ready', reason: 'mongodb' },
    });
    await env.waitFor(async () => ((await queueDepth(env))?.ready ?? 0) >= returned, {
      describe: () => `returned ${String(returned)}, stats ${JSON.stringify(processing.stats())}`,
    });
    await recover();
    // The second `store ready` (the first was the startup) and the second registration.
    await env.waitFor(() => processing.logs.filter(byMsg('store ready')).length >= 2, {
      timeoutMs: 25_000,
      describe: () => processing.logs.messages().slice(-8).join(' | '),
    });
    await env.waitFor(() => processing.logs.filter(byMsg('consumer registered')).length >= 2, {
      describe: () => `state ${JSON.stringify(processing.consumer.state)}`,
    });
    await env.awaitAcked(processing, 30);

    const events = await readEvents(env);
    expect(identitiesOf(events)).toEqual(identities(sends));
    expect(events).toHaveLength(30);
    const keys = rotatingKeys(15);
    for (const deviceId of ['c8-a', 'c8-b']) {
      const state = await readState(env, deviceId);
      for (const type of ['status', 'metrics', 'counters', 'diagnostic'] as const) {
        expect(sectionKey(state, type), `${deviceId}.${type}`).toEqual({
          sessionId: SESSION_A,
          seq: keys[type],
        });
      }
      expect(state?.lastEvent).toMatchObject({ sessionId: SESSION_A, seq: 15 });
    }
    expect(processing.stats().failed).toBe(0);
  }, 45_000);

  it('C9 MongoDB frozen: the timeout is transient, the consumer pauses and resumes after the unpause', async ({
    signal,
  }) => {
    const env = environment(signal);
    const timeoutMs = 1_000;
    const processing = await registeredProcessing(env, {
      overrides: { MONGODB_TIMEOUT_MS: String(timeoutMs), PROCESSING_TRANSIENT_ATTEMPTS: '3' },
    });
    await env.waitFor(async () => (await processing.readiness()).status === 200, {
      describe: () => `state ${JSON.stringify(processing.consumer.state)}`,
    });
    const pausedAt = performance.now();
    const recover = await pause(env, 'mongodb');
    const publisher = await openDirectPublisher(env);
    const build = messages('c9-device', SESSION_A);
    const sends = Array.from({ length: 10 }, (_, index) => rotating(build, index + 1));
    await publishAll(publisher, sends);

    const failure = await processing.logs.waitForLine(
      (line) => line.msg === 'transient store failure' && isTimeoutFailure(line['failure']),
      3 * timeoutMs + 2_000,
    );
    expect(failure.level).toBe(WARN_LEVEL);
    expect(performance.now() - pausedAt).toBeLessThan(3 * timeoutMs + 2_000);
    await processing.logs.waitForLine(byMsg('consumer paused'));
    expect(await processing.readiness()).toEqual({
      status: 503,
      body: { status: 'not_ready', reason: 'mongodb' },
    });
    await recover();
    await env.waitFor(() => processing.logs.filter(byMsg('consumer registered')).length >= 2, {
      timeoutMs: 25_000,
      describe: () => `state ${JSON.stringify(processing.consumer.state)}`,
    });
    await env.awaitAcked(processing, 10);

    const events = await readEvents(env);
    expect(identitiesOf(events)).toEqual(identities(sends));
    expect(events).toHaveLength(10);
    const keys = rotatingKeys(10);
    const state = await readState(env, 'c9-device');
    for (const type of ['status', 'metrics', 'counters', 'diagnostic'] as const) {
      expect(sectionKey(state, type), type).toEqual({ sessionId: SESSION_A, seq: keys[type] });
    }
    // `duplicate` may be above zero: a write the frozen server executed after the client timed
    // out is a duplicate on the retry, which the index absorbs.
    expect(processing.stats(), JSON.stringify(processing.stats())).toMatchObject({ failed: 0 });
  }, 45_000);

  it('C10 a broker restart with a registered consumer: reconnection, then a second batch', async ({
    signal,
  }) => {
    const env = environment(signal);
    const processing = await registeredProcessing(env);
    const shape = { devices: 10, messages: 100, hotShare: 0, duplicatePercent: 0, swapPercent: 0 };
    const batch1 = generateLoad({ ...shape, seed: 3, deviceIdPrefix: 'c10a' });
    const batch2 = generateLoad({ ...shape, seed: 4, deviceIdPrefix: 'c10b' });
    const expected = mergeExpected({ first: batch1.expected, second: batch2.expected });
    // A check of the test's own arithmetic before anything is published.
    expect(expected.identities.size).toBe(200);
    expect(expected.alerts.size).toBe(20);
    const first = await openDirectPublisher(env);
    await publishAll(first, batch1.sends);
    await env.awaitAcked(processing, 100);

    const restarting = restart(env, 'rabbitmq');
    await processing.logs.waitForLine(byMsg('consumer reconnect scheduled'), 15_000);
    // Polled while the restart runs, as the spec says; the broker is down for seconds, so the
    // consumer cannot register again before this resolves.
    await env.waitFor(
      async () => {
        const report = await processing.readiness();
        return report.status === 503 && report.body.reason === 'connecting';
      },
      {
        timeoutMs: 15_000,
        describe: () => `state ${JSON.stringify(processing.consumer.state)}`,
      },
    );
    await restarting;
    await env.waitFor(() => processing.logs.filter(byMsg('consumer registered')).length >= 2, {
      timeoutMs: 25_000,
      describe: () => `state ${JSON.stringify(processing.consumer.state)}`,
    });
    // A fresh publisher: the first one's connection died with the broker.
    const second = await openDirectPublisher(env);
    await publishAll(second, batch2.sends);
    await env.awaitEndState(expected);
    await env.waitFor(() => processing.stats().inFlight === 0, {
      describe: () => `stats ${JSON.stringify(processing.stats())}`,
    });

    const events = await readEvents(env);
    expect(identitiesOf(events)).toEqual(expected.identities);
    expect(events).toHaveLength(200);
    expect(new Set((await readAlerts(env)).map((alert) => alert._id))).toEqual(expected.alerts);
    expect(await stateMismatches(env, expected)).toEqual([]);
    const stats = processing.stats();
    // `acked` above 200 would be a redelivery after an acknowledgement lost in the restart, and
    // `duplicate` counts duplicate inserts of any cause: both are in the failure text, not asserted.
    expect(stats.failed, `stats ${JSON.stringify(stats)}`).toBe(0);
    expect((await queueDepth(env))?.ready).toBe(0);
  }, 45_000);

  it('C11 SIGTERM on a registered instance: cancel, close, exit 0', async ({ signal }) => {
    const env = environment(signal);
    const [healthPort = 0] = await freePorts(1);
    const shutdownTimeoutMs = 2_000;
    const child = spawnService(env, {
      app: 'processing',
      variables: {
        RABBITMQ_URL: env.amqpUrl,
        MONGODB_URL: env.mongoUrl,
        MONGODB_DB: env.dbName,
        HEALTH_PORT: String(healthPort),
        SHUTDOWN_TIMEOUT_MS: String(shutdownTimeoutMs),
        LOG_LEVEL: 'debug',
      },
    });
    await child.waitForLog('consumer registered');

    const signalledAt = performance.now();
    child.kill('SIGTERM');
    const exit = await child.closed;
    const lifetimeMs = performance.now() - signalledAt;

    expect(exit, child.diagnostics()).toEqual({ code: 0, signal: null });
    expect(lifetimeMs).toBeLessThan(
      shutdownTimeoutMs + AMQP_CLOSE_TIMEOUT_MS + MONGODB_TIMEOUT_MS + 2_000,
    );
    const lifecycle = ['shutting down', 'consumer stopping', 'consumer cancel', 'stopped'];
    expect(child.logs.messages().filter((msg) => lifecycle.includes(msg))).toEqual(lifecycle);
    expect(child.logs.find(byMsg('consumer cancel'))).toMatchObject({ outcome: 'resolved' });
    expect(child.logs.find(byMsg('shutdown drain ended at its budget'))).toBeUndefined();
    let depth: QueueDepth | undefined;
    await env.waitFor(
      async () => {
        depth = await queueDepth(env);
        return depth?.consumers === 0;
      },
      { describe: () => `queue ${JSON.stringify(depth)}` },
    );
  });

  it('C11b a graceful drain with deliveries in flight: the held fifty are acknowledged, the next instance gets exactly the rest', async ({
    signal,
  }) => {
    const env = environment(signal);
    const { sends, expected } = generateLoad({
      devices: 10,
      messages: 200,
      hotShare: 0,
      duplicatePercent: 0,
      swapPercent: 0,
      seed: 4,
    });
    expect(expected.alerts.size).toBe(20);
    const publisher = await openDirectPublisher(env);
    await publishAll(publisher, sends);
    const gate = holdInserts(env);
    const shutdownTimeoutMs = 5_000;
    const a = await registeredProcessing(env, {
      hostname: 'a',
      overrides: { SHUTDOWN_TIMEOUT_MS: String(shutdownTimeoutMs) },
      wrapStore: gate.wrap,
    });
    // The broker delivers the prefetch and nothing completes: exactly fifty in flight.
    await env.waitFor(() => a.stats().inFlight === 50, {
      describe: () => `a ${JSON.stringify(a.stats())}`,
    });

    const startedAt = performance.now();
    const stopping = a.stop();
    const cancel = await a.logs.waitForLine(byMsg('consumer cancel'));
    expect(cancel).toMatchObject({ outcome: 'resolved' });
    // No further delivery can arrive once the cancel reply is in; now the held fifty may finish.
    gate.release();
    await stopping;
    const stopMs = performance.now() - startedAt;
    expect(stopMs).toBeLessThan(
      shutdownTimeoutMs + AMQP_CLOSE_TIMEOUT_MS + MONGODB_TIMEOUT_MS + 2_000,
    );
    const b = await registeredProcessing(env, { hostname: 'b' });
    // The broker redelivers the message(s) acknowledged right before the link closed (measured
    // in the plan's probe, T70): b's count is 150 plus those, and each of them is a duplicate
    // that a had already stored.
    const redelivered = (): LogLine[] =>
      b.logs.filter((line) => line.msg === 'delivery processed' && line['redelivered'] === true);
    await env.waitFor(
      async () => {
        const stats = b.stats();
        if (stats.acked !== 150 + redelivered().length || stats.inFlight !== 0) {
          return false;
        }
        return (await queueDepth(env))?.ready === 0;
      },
      {
        describe: () =>
          `b ${JSON.stringify(b.stats())}, redelivered ${String(redelivered().length)}`,
      },
    );

    const [sa, sb] = [a.stats(), b.stats()];
    const detail = `a ${JSON.stringify(sa)}, b ${JSON.stringify(sb)}, redelivered ${String(redelivered().length)}`;
    // A stop that does not cancel first shows as `a.acked > 50`; one that does not wait for its
    // handlers as `a.abandoned > 0` and redeliveries that are not duplicates.
    expect(sa, detail).toMatchObject({ received: 50, acked: 50, abandoned: 0, failed: 0 });
    expect(a.logs.find(byMsg('shutdown drain ended at its budget'))).toBeUndefined();
    expect(sb.received, detail).toBe(150 + redelivered().length);
    expect(sb.failed, detail).toBe(0);
    // Only acknowledgements of the one drain can be lost, and each redelivered message was stored by a.
    expect(redelivered().length, detail).toBeLessThanOrEqual(50);
    for (const line of redelivered()) {
      expect(line, detail).toMatchObject({ outcome: 'stale', duplicate: true });
    }
    const events = await readEvents(env);
    expect(identitiesOf(events)).toEqual(expected.identities);
    expect(events).toHaveLength(200);
    expect(new Set((await readAlerts(env)).map((alert) => alert._id))).toEqual(expected.alerts);
    expect(await stateMismatches(env, expected)).toEqual([]);
    expect((await queueDepth(env))?.ready).toBe(0);
  }, 45_000);

  it('C11c a stop with the registration pending on a frozen broker returns at its bound', async ({
    signal,
  }) => {
    const env = environment(signal);
    const recoverMongo = await stop(env, 'mongodb');
    const shutdownTimeoutMs = 500;
    const instance = await startProcessing(env, {
      overrides: {
        SHUTDOWN_TIMEOUT_MS: String(shutdownTimeoutMs),
        // Long enough that the heartbeat timeout cannot end the link during the test.
        AMQP_HEARTBEAT_S: '30',
        MONGODB_TIMEOUT_MS: '1000',
      },
    });
    await instance.logs.waitForLine(byMsg('consumer connected'));
    expect(instance.consumer.state).toMatchObject({
      name: 'open',
      consumer: 'idle',
      storeReady: false,
    });
    const recoverBroker = await pause(env, 'rabbitmq');
    await recoverMongo();
    // `store ready` issues the `consume` into the paused broker; its reply never comes.
    await env.waitFor(
      () => {
        const state = instance.consumer.state;
        return state.name === 'open' && state.consumer === 'registering';
      },
      { timeoutMs: 25_000, describe: () => JSON.stringify(instance.consumer.state) },
    );

    const startedAt = performance.now();
    await instance.stop();
    const stopMs = performance.now() - startedAt;

    expect(stopMs).toBeLessThan(shutdownTimeoutMs + AMQP_CLOSE_TIMEOUT_MS + 1_000);
    const lifecycle = [
      'consumer stopping',
      'shutdown drain ended at its budget',
      'shutdown ended before the link closed',
    ];
    expect(instance.logs.messages().filter((msg) => lifecycle.includes(msg))).toEqual(lifecycle);
    expect(instance.logs.find(byMsg('consumer cancel'))).toBeUndefined();
    await recoverBroker();
    // The broker answers the pending `consume`, then the close: no consumer is left behind.
    let depth: QueueDepth | undefined;
    await env.waitFor(
      async () => {
        depth = await queueDepth(env);
        return depth?.consumers === 0;
      },
      { timeoutMs: 5_000, describe: () => `queue ${JSON.stringify(depth)}` },
    );
    expect(instance.stats().failed).toBe(0);
  }, 45_000);

  it('C15 confirmed messages survive a broker restart', async ({ signal }) => {
    const env = environment(signal);
    const { sends, expected } = generateLoad({
      devices: 10,
      messages: 100,
      hotShare: 0,
      duplicatePercent: 0,
      swapPercent: 0,
      seed: 5,
      deviceIdPrefix: 'c15',
    });
    expect(expected.alerts.size).toBe(10);
    // No consumer: the batch is pending in the queue across the restart.
    const publisher = await openDirectPublisher(env);
    await publishAll(publisher, sends);
    await restart(env, 'rabbitmq');
    // A fresh connection: the publisher's died with the broker.
    expect((await queueDepth(env))?.ready).toBe(100);
    const processing = await registeredProcessing(env);
    await env.awaitAcked(processing, 100);

    const events = await readEvents(env);
    expect(identitiesOf(events)).toEqual(expected.identities);
    expect(events).toHaveLength(100);
    expect(new Set((await readAlerts(env)).map((alert) => alert._id))).toEqual(expected.alerts);
    expect(await stateMismatches(env, expected)).toEqual([]);
    expect(processing.stats().failed).toBe(0);
    expect((await queueDepth(env))?.ready).toBe(0);
  }, 45_000);
});
