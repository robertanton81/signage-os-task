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
} from '../harness/clients.js';
import {
  bindEnvironment,
  createEnvironment,
  type TestEnvironment,
} from '../harness/environment.js';
import { generateLoad } from '../harness/load.js';
import {
  startProcessing,
  type ProcessingInstance,
  type StartProcessingOptions,
} from '../harness/services.js';
import { WARN_LEVEL, byMsg } from '../harness/wait.js';

/** The store's default `MONGODB_TIMEOUT_MS`: the bound of a stop while the store is not ready (C12). */
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
});
