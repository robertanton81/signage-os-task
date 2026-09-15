import { setTimeout as sleep } from 'node:timers/promises';

import { TELEMETRY_QUEUE, messageIdentity, type TelemetryMessage } from '@telemetry/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';

import type { TestDevice } from '../../apps/ingest/src/test-device.js';
import {
  SESSION_A,
  connectDevice,
  messages,
  queueDepth,
  type MessageBuilder,
} from '../harness/clients.js';
import {
  bindEnvironment,
  createEnvironment,
  type TestEnvironment,
} from '../harness/environment.js';
import type { QueueMessage } from '../harness/management.js';
import { freePorts, spawnService, startIngest, type IngestInstance } from '../harness/services.js';
import { pause, raiseMemoryAlarm, restart } from '../harness/stack.js';
import { ERROR_LEVEL, WARN_LEVEL, byMsg } from '../harness/wait.js';

/** The reasons of a recycle from `ready`; a failed connect attempt during the outage logs `connect_failed` instead. */
const RECYCLE_REASONS = ['channel_closed', 'connection_closed'];
const BACKOFF_REASONS = [...RECYCLE_REASONS, 'connect_failed'];
/** The ingest process's `AMQP_CLOSE_TIMEOUT_MS`, the second term of its shutdown bound. */
const AMQP_CLOSE_TIMEOUT_MS = 2_000;

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

/** An ingest whose publisher is ready: a fault injected before that would land on no connection. */
async function readyIngest(
  context: TestEnvironment,
  overrides: Record<string, string> = {},
): Promise<IngestInstance> {
  const ingest = await startIngest(context, overrides);
  await context.waitFor(() => ingest.publisher.isReady, {
    describe: () => `publisher ${ingest.publisher.state.name}`,
  });
  return ingest;
}

function distinctIds(drained: readonly QueueMessage[]): Set<string> {
  return new Set(drained.map((message) => message.properties.message_id ?? ''));
}

function identities(sent: readonly TelemetryMessage[]): Set<string> {
  return new Set(sent.map((message) => messageIdentity(message)));
}

type Sender = { device: TestDevice; build: MessageBuilder };

/** One status per device every 20 ms until stopped; `sent` grows as it goes. */
function startSending(
  senders: readonly Sender[],
  signal: AbortSignal,
): { sent: TelemetryMessage[]; stop(): Promise<void> } {
  const sent: TelemetryMessage[] = [];
  let running = true;
  let seq = 0;
  const loop = (async () => {
    while (running) {
      seq += 1;
      for (const { device, build } of senders) {
        const message = build.status(seq);
        device.sendMessage(message);
        sent.push(message);
      }
      try {
        await sleep(20, undefined, { signal });
      } catch {
        running = false;
      }
    }
  })();
  return {
    sent,
    stop: async () => {
      running = false;
      await loop;
    },
  };
}

describe('ingest publisher against RabbitMQ', () => {
  it('I1 a valid message is published with the contract properties and confirmed', async ({
    signal,
  }) => {
    const env = environment(signal);
    const ingest = await startIngest(env);
    const device = await connectDevice(env, ingest.port);
    const message = messages('i1-device', SESSION_A).status(1);
    const before = Date.now();
    device.sendMessage(message);
    await env.waitFor(async () => (await queueDepth(env))?.ready === 1, {
      describe: () => `stats ${JSON.stringify(ingest.stats())}`,
    });

    const [published, ...rest] = await env.management.getMessages(TELEMETRY_QUEUE, 2);
    expect(rest).toEqual([]);
    expect(published?.properties).toMatchObject({
      message_id: messageIdentity(message),
      content_type: 'application/json',
      delivery_mode: 2,
    });
    const timestamp = published?.properties.timestamp;
    expect(timestamp).toBeGreaterThanOrEqual(Math.floor(before / 1000));
    expect(timestamp).toBeLessThanOrEqual(Math.ceil(Date.now() / 1000));
    const receivedAt = published?.properties.headers?.['x-received-at'];
    expect(typeof receivedAt).toBe('number');
    expect(receivedAt).toBeGreaterThanOrEqual(before);
    expect(JSON.parse(published?.payload ?? 'null')).toEqual(message);
    expect(ingest.stats().confirmed).toBe(1);
  });

  it('I2 a broker restart while devices send loses nothing', async ({ signal }) => {
    const env = environment(signal);
    const ingest = await readyIngest(env, { AMQP_HEARTBEAT_S: '1' });
    const senders = await Promise.all(
      ['i2-a', 'i2-b', 'i2-c'].map(async (deviceId) => ({
        device: await connectDevice(env, ingest.port),
        build: messages(deviceId, SESSION_A),
      })),
    );
    const sending = startSending(senders, env.signal);
    try {
      // A threshold read while messages still move is `≥` (decision 13).
      await env.waitFor(() => ingest.stats().confirmed >= 20, {
        describe: () => `confirmed ${String(ingest.stats().confirmed)}`,
      });
      const restarting = restart(env, 'rabbitmq');
      // Not ready at least once during the restart, polled while the restart runs.
      await env.waitFor(async () => (await ingest.readiness()).status === 503, {
        timeoutMs: 15_000,
        describe: () => `publisher ${ingest.publisher.state.name}`,
      });
      await restarting;
      await env.waitFor(() => ingest.publisher.state.name === 'ready', {
        describe: () => `publisher ${ingest.publisher.state.name}`,
      });
      const target = sending.sent.length + 3 * 20;
      await env.waitFor(() => sending.sent.length >= target);
    } finally {
      await sending.stop();
    }
    const sent = identities(sending.sent);
    await env.waitFor(
      () => {
        const stats = ingest.stats();
        return stats.unconfirmed === 0 && stats.confirmed === sent.size;
      },
      { describe: () => `stats ${JSON.stringify(ingest.stats())}, sent ${String(sent.size)}` },
    );

    const reconnects = ingest.logs.filter(byMsg('publisher reconnect scheduled'));
    const reasons = reconnects.map((line) => String(line['reason']));
    expect(
      reasons.some((reason) => RECYCLE_REASONS.includes(reason)),
      reasons.join(','),
    ).toBe(true);
    // Every backoff line names one of the three known reasons: the recycle, or a failed attempt.
    expect(
      reasons.every((reason) => BACKOFF_REASONS.includes(reason)),
      reasons.join(','),
    ).toBe(true);
    expect(reconnects.every((line) => line.level === WARN_LEVEL)).toBe(true);
    const drained = await env.management.getMessages(TELEMETRY_QUEUE, 2 * sending.sent.length);
    expect(distinctIds(drained)).toEqual(sent);
    // Extra copies are at-least-once delivery, expected; `republished` is reported, not asserted.
    expect(
      drained.length,
      `drained ${String(drained.length)}, republished ${String(ingest.stats().republished)}`,
    ).toBeGreaterThanOrEqual(sent.size);
  }, 45_000);

  it('I3 a deleted queue is declared again and the returned message is published again', async ({
    signal,
  }) => {
    const env = environment(signal);
    const ingest = await readyIngest(env);
    await env.management.deleteQueue(TELEMETRY_QUEUE);
    const device = await connectDevice(env, ingest.port);
    const message = messages('i3-device', SESSION_A).status(1);
    device.sendMessage(message);
    await env.waitFor(() => ingest.stats().returned >= 1, {
      describe: () => `stats ${JSON.stringify(ingest.stats())}`,
    });
    // `undefined` until ingest has declared the queue again: the live check is the existence proof.
    await env.waitFor(async () => ((await queueDepth(env))?.ready ?? 0) >= 1, {
      describe: () => `stats ${JSON.stringify(ingest.stats())}`,
    });

    const returned = ingest.logs.filter(byMsg('message returned'));
    expect(returned).toHaveLength(1);
    expect(returned[0]).toMatchObject({ level: ERROR_LEVEL, deviceId: 'i3-device', seq: 1 });
    const drained = await env.management.getMessages(TELEMETRY_QUEUE, 2);
    expect(distinctIds(drained)).toEqual(new Set([messageIdentity(message)]));
  });

  it('I4 a resource alarm blocks publishing and the block clears with the alarm', async ({
    signal,
  }) => {
    const env = environment(signal);
    const ingest = await readyIngest(env, { AMQP_HEARTBEAT_S: '1' });
    const recover = await raiseMemoryAlarm(env);
    const device = await connectDevice(env, ingest.port);
    const build = messages('i4-device', SESSION_A);
    const sent = [1, 2, 3, 4, 5].map((seq) => build.status(seq));
    for (const message of sent) {
      device.sendMessage(message);
    }
    await ingest.logs.waitForLine(byMsg('connection blocked'));
    expect(await ingest.readiness()).toEqual({
      status: 503,
      body: { status: 'not_ready', reason: 'blocked' },
    });
    expect(await env.management.alarms()).toBe(503);
    // The duration of the fault, not a wait for an outcome: longer than two heartbeats (decision 13).
    await sleep(3_000, undefined, { signal: env.signal });
    // A blocked connection is not a stalled one (ingest spec, decision 15): the hold outlasted the
    // stall window and no stall recycle fired. A heartbeat-driven recycle would be legitimate.
    expect(
      ingest.logs.filter(
        (line) =>
          line.msg === 'publisher reconnect scheduled' && line['reason'] === 'confirm_stall',
      ),
    ).toEqual([]);
    await recover();
    await env.waitFor(() => ingest.publisher.isReady, {
      describe: () => `publisher ${JSON.stringify(ingest.publisher.state)}`,
    });
    await env.waitFor(
      async () => ingest.stats().unconfirmed === 0 && ((await queueDepth(env))?.ready ?? 0) >= 5,
      { describe: () => `stats ${JSON.stringify(ingest.stats())}` },
    );

    expect(await env.management.alarms()).toBe(200);
    // Extra copies allowed: a heartbeat-driven reconnect during the alarm republishes the five.
    const drained = await env.management.getMessages(TELEMETRY_QUEUE, 10);
    expect(distinctIds(drained)).toEqual(identities(sent));
  });

  it('I5 SIGTERM with devices connected: close 1001 to every device, exit 0', async ({
    signal,
  }) => {
    const env = environment(signal);
    const [ingestPort = 0, healthPort = 0] = await freePorts(2);
    const shutdownTimeoutMs = 2_000;
    const child = spawnService(env, {
      app: 'ingest',
      variables: {
        RABBITMQ_URL: env.amqpUrl,
        INGEST_HOST: '127.0.0.1',
        INGEST_PORT: String(ingestPort),
        HEALTH_PORT: String(healthPort),
        SHUTDOWN_TIMEOUT_MS: String(shutdownTimeoutMs),
        LOG_LEVEL: 'debug',
      },
    });
    await child.waitForLog('publisher connected');
    const devices = await Promise.all([
      connectDevice(env, ingestPort),
      connectDevice(env, ingestPort),
    ]);
    await env.waitFor(() => child.logs.filter(byMsg('connection accepted')).length >= 2, {
      describe: () => child.logs.messages().join(' | '),
    });

    const signalledAt = performance.now();
    child.kill('SIGTERM');
    const closes = await Promise.all(devices.map((device) => device.closed));
    const exit = await child.closed;
    const lifetimeMs = performance.now() - signalledAt;

    expect(closes.map((close) => close.code)).toEqual([1001, 1001]);
    expect(exit, child.diagnostics()).toEqual({ code: 0, signal: null });
    expect(lifetimeMs).toBeLessThan(shutdownTimeoutMs + AMQP_CLOSE_TIMEOUT_MS + 2_000);
    const lifecycle = ['shutting down', 'publisher stopping', 'stopped'];
    expect(child.logs.messages().filter((msg) => lifecycle.includes(msg))).toEqual(lifecycle);
    expect(child.logs.find(byMsg('shutdown drain ended at its budget'))).toBeUndefined();
  });

  it('I6 invalid frames never reach the queue and the connection stays open', async ({
    signal,
  }) => {
    const env = environment(signal);
    const ingest = await readyIngest(env);
    const device = await connectDevice(env, ingest.port);
    const build = messages('i6-device', SESSION_A);
    const valid = build.status(1);
    device.send('not json');
    device.send(JSON.stringify({ ...build.status(1), seq: -1 }));
    device.sendMessage(valid);
    // Frames of one connection are decoded in order and a rejection happens before the next frame
    // is read, so the valid message's arrival proves the two before it were rejected.
    await env.waitFor(async () => (await queueDepth(env))?.ready === 1, {
      describe: () => `stats ${JSON.stringify(ingest.stats())}`,
    });

    const drained = await env.management.getMessages(TELEMETRY_QUEUE, 3);
    expect(distinctIds(drained)).toEqual(new Set([messageIdentity(valid)]));
    expect(drained).toHaveLength(1);
    expect(ingest.server.stats().rejected).toBe(2);
    const rejected = ingest.logs.filter(byMsg('message rejected'));
    expect(rejected.map((line) => [line.level, line['reason']])).toEqual([
      [WARN_LEVEL, 'invalid_json'],
      [WARN_LEVEL, 'invalid_schema'],
    ]);
    expect(device.ws.readyState).toBe(WebSocket.OPEN);
    device.sendMessage(build.status(2));
    await env.waitFor(() => ingest.stats().confirmed === 2, {
      describe: () => `stats ${JSON.stringify(ingest.stats())}`,
    });
  });

  it('I7 a frozen broker with messages in flight: recycle and republish all five', async ({
    signal,
  }) => {
    const env = environment(signal);
    const ingest = await readyIngest(env, { AMQP_HEARTBEAT_S: '1' });
    const recover = await pause(env, 'rabbitmq');
    const device = await connectDevice(env, ingest.port);
    const build = messages('i7-device', SESSION_A);
    const sent = [1, 2, 3, 4, 5].map((seq) => build.status(seq));
    for (const message of sent) {
      device.sendMessage(message);
    }
    // All five went into the paused broker: published, none confirmed.
    await env.waitFor(() => ingest.stats().unconfirmed === 5, {
      describe: () => `stats ${JSON.stringify(ingest.stats())}`,
    });
    await ingest.logs.waitForLine(byMsg('publisher reconnect scheduled'), 5_000);
    expect((await ingest.readiness()).status).toBe(503);
    await recover();
    await env.waitFor(() => ingest.publisher.state.name === 'ready', {
      describe: () => `publisher ${ingest.publisher.state.name}`,
    });
    await env.waitFor(
      async () => ingest.stats().unconfirmed === 0 && ((await queueDepth(env))?.ready ?? 0) >= 5,
      { describe: () => `stats ${JSON.stringify(ingest.stats())}` },
    );

    expect(ingest.stats().republished).toBe(5);
    const drained = await env.management.getMessages(TELEMETRY_QUEUE, 10);
    expect(distinctIds(drained)).toEqual(identities(sent));
  });
});
