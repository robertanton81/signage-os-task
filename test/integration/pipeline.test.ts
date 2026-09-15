import type { TelemetryMessage } from '@telemetry/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  SESSION_A,
  SESSION_B,
  connectDevice,
  identitiesOf,
  messages,
  queueDepth,
  readAlerts,
  readEvents,
  readState,
  sectionKey,
  stateMismatches,
} from '../harness/clients.js';
import {
  bindEnvironment,
  createEnvironment,
  type TestEnvironment,
} from '../harness/environment.js';
import { generateLoad } from '../harness/load.js';
import {
  startIngest,
  startProcessing,
  type IngestInstance,
  type ProcessingInstance,
} from '../harness/services.js';
import { byMsg } from '../harness/wait.js';

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

type Pipeline = { ingest: IngestInstance; processing: ProcessingInstance };

/** One ingest and one processing; the consumer is registered, so the acknowledgement count is a sound signal. */
async function startPipeline(context: TestEnvironment): Promise<Pipeline> {
  const processing = await startProcessing(context);
  const ingest = await startIngest(context);
  await processing.logs.waitForLine(byMsg('consumer registered'));
  return { ingest, processing };
}

describe('pipeline: device → ingest → RabbitMQ → processing → MongoDB', () => {
  it('P1 one message of each type reaches MongoDB', async ({ signal }) => {
    const env = environment(signal);
    const { ingest, processing } = await startPipeline(env);
    const device = await connectDevice(env, ingest.port);
    const build = messages('p1-device', SESSION_A);
    const sent = [
      build.status(1),
      build.metrics(2),
      build.counters(3),
      build.diagnostic(4, { severity: 'error' }),
    ];
    for (const message of sent) {
      device.sendMessage(message);
    }
    await env.awaitAcked(processing, 4);

    const events = await readEvents(env);
    expect(events).toHaveLength(4);
    sent.forEach((message, index) => {
      expect(events[index]).toMatchObject({
        deviceId: message.deviceId,
        sessionId: message.sessionId,
        seq: message.seq,
        type: message.type,
        occurredAt: message.occurredAt,
        payload: message.payload,
      });
      expect(typeof events[index]?.receivedAt).toBe('number');
      expect(typeof events[index]?.processedAt).toBe('number');
    });
    const state = await readState(env, 'p1-device');
    expect(sectionKey(state, 'status')).toEqual({ sessionId: SESSION_A, seq: 1 });
    expect(sectionKey(state, 'metrics')).toEqual({ sessionId: SESSION_A, seq: 2 });
    expect(sectionKey(state, 'counters')).toEqual({ sessionId: SESSION_A, seq: 3 });
    expect(sectionKey(state, 'diagnostic')).toEqual({ sessionId: SESSION_A, seq: 4 });
    expect(state?.status).toMatchObject({ state: 'online' });
    expect(state?.lastEvent).toMatchObject({ sessionId: SESSION_A, seq: 4, type: 'diagnostic' });
    const alerts = await readAlerts(env);
    expect(alerts.map((alert) => alert._id)).toEqual([`p1-device:${String(SESSION_A)}:4`]);
    expect(alerts[0]).toMatchObject({ deviceId: 'p1-device', seq: 4, code: 'E_OVERHEAT' });
    const stats = processing.stats();
    // `duplicate` is reported, not asserted: four handlers race on the device's first state write.
    expect(stats, `stats ${JSON.stringify(stats)}`).toMatchObject({
      created: 1,
      applied: 3,
      stale: 0,
      alerts: 1,
      failed: 0,
      rejected: 0,
    });
    expect((await queueDepth(env))?.ready).toBe(0);
  });

  it('P2 a duplicate has no effect', async ({ signal }) => {
    const env = environment(signal);
    const { ingest, processing } = await startPipeline(env);
    const device = await connectDevice(env, ingest.port);
    const build = messages('p2-device', SESSION_A);
    const first = [
      build.counters(1, { operationsTotal: 120 }),
      build.diagnostic(2, { severity: 'error' }),
    ];
    for (const message of first) {
      device.sendMessage(message);
    }
    await env.awaitAcked(processing, 2);
    // Byte for byte: the same objects encode to the same frames.
    for (const message of first) {
      device.sendMessage(message);
    }
    await env.awaitAcked(processing, 4);

    const events = await readEvents(env);
    expect(events.map((event) => event.seq)).toEqual([1, 2]);
    const state = await readState(env, 'p2-device');
    expect(state?.counters).toMatchObject({ sessionId: SESSION_A, seq: 1, operationsTotal: 120 });
    expect(await readAlerts(env)).toHaveLength(1);
    const stats = processing.stats();
    expect(stats, `stats ${JSON.stringify(stats)}`).toMatchObject({
      duplicate: 2,
      stale: 2,
      alerts: 1,
      failed: 0,
    });
  });

  it('P3 an older message never overwrites newer state', async ({ signal }) => {
    const env = environment(signal);
    const { ingest, processing } = await startPipeline(env);
    const device = await connectDevice(env, ingest.port);
    const build = messages('p3-device', SESSION_A);
    device.sendMessage(build.metrics(6, { temperatureC: 41.5 }));
    await env.awaitAcked(processing, 1);
    device.sendMessage(build.metrics(5, { temperatureC: 99 }));
    await env.awaitAcked(processing, 2);

    const state = await readState(env, 'p3-device');
    expect(state?.metrics).toMatchObject({ sessionId: SESSION_A, seq: 6, temperatureC: 41.5 });
    expect((await readEvents(env)).map((event) => event.seq)).toEqual([5, 6]);
    expect(processing.stats()).toMatchObject({ stale: 1, failed: 0 });
  });

  it('P4 order is kept per section, not per message', async ({ signal }) => {
    const env = environment(signal);
    const { ingest, processing } = await startPipeline(env);
    const device = await connectDevice(env, ingest.port);
    const build = messages('p4-device', SESSION_A);
    device.sendMessage(build.metrics(8));
    await env.awaitAcked(processing, 1);
    device.sendMessage(build.status(7));
    await env.awaitAcked(processing, 2);

    const state = await readState(env, 'p4-device');
    expect(sectionKey(state, 'status')).toEqual({ sessionId: SESSION_A, seq: 7 });
    expect(sectionKey(state, 'metrics')).toEqual({ sessionId: SESSION_A, seq: 8 });
    expect(state?.lastEvent).toMatchObject({ sessionId: SESSION_A, seq: 8, type: 'metrics' });
    expect(processing.stats()).toMatchObject({ created: 1, applied: 1, stale: 0, failed: 0 });
  });

  it('P5 a new session wins and a straggler of the old one is stale', async ({ signal }) => {
    const env = environment(signal);
    const { ingest, processing } = await startPipeline(env);
    const device = await connectDevice(env, ingest.port);
    const sessionA = messages('p5-device', SESSION_A);
    const sessionB = messages('p5-device', SESSION_B);
    device.sendMessage(sessionA.counters(1, { operationsTotal: 100 }));
    device.sendMessage(sessionA.status(2));
    await env.awaitAcked(processing, 2);
    device.sendMessage(sessionB.counters(1, { operationsTotal: 5 }));
    await env.awaitAcked(processing, 3);
    device.sendMessage(sessionA.counters(3, { operationsTotal: 200 }));
    await env.awaitAcked(processing, 4);

    const state = await readState(env, 'p5-device');
    expect(state?.counters).toMatchObject({ sessionId: SESSION_B, seq: 1, operationsTotal: 5 });
    expect(sectionKey(state, 'status')).toEqual({ sessionId: SESSION_A, seq: 2 });
    expect(state?.lastEvent).toMatchObject({ sessionId: SESSION_B, seq: 1 });
    expect(await readEvents(env)).toHaveLength(4);
    expect(processing.stats()).toMatchObject({ stale: 1, failed: 0 });
  });

  it('P6 many devices in parallel end in the expected state', async ({ signal }) => {
    const env = environment(signal);
    const { ingest, processing } = await startPipeline(env);
    const { sends, expected } = generateLoad({
      devices: 20,
      messages: 1000,
      hotShare: 0.25,
      duplicatePercent: 5,
      swapPercent: 5,
      seed: 1,
    });
    const streams = new Map<string, TelemetryMessage[]>();
    for (const message of sends) {
      const stream = streams.get(message.deviceId) ?? [];
      stream.push(message);
      streams.set(message.deviceId, stream);
    }
    expect(streams.size).toBe(20);
    const devices = await Promise.all(
      [...streams.keys()].map(() => connectDevice(env, ingest.port)),
    );
    // Every device sends its own stream in order, all twenty at once.
    [...streams.values()].forEach((stream, index) => {
      const device = devices[index];
      if (device === undefined) {
        throw new Error(`no device for stream ${String(index)}`);
      }
      for (const message of stream) {
        device.sendMessage(message);
      }
    });
    await env.awaitAcked(processing, sends.length);

    const events = await readEvents(env);
    expect(identitiesOf(events)).toEqual(expected.identities);
    expect(events).toHaveLength(expected.identities.size);
    expect(await stateMismatches(env, expected)).toEqual([]);
    expect(new Set((await readAlerts(env)).map((alert) => alert._id))).toEqual(expected.alerts);
    const stats = processing.stats();
    // `stale` is reported, not asserted: whether a swapped lower `seq` is processed after the
    // higher one depends on scheduling. `duplicate` counts duplicate inserts of any cause.
    expect(stats, `stats ${JSON.stringify(stats)}`).toMatchObject({
      created: 20,
      failed: 0,
      rejected: 0,
    });
    expect(stats.duplicate, `stats ${JSON.stringify(stats)}`).toBeGreaterThanOrEqual(
      expected.duplicates,
    );
    expect((await queueDepth(env))?.ready).toBe(0);
  }, 60_000);
});
