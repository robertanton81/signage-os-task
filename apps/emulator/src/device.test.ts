import {
  createLogger,
  telemetryMessageSchema,
  type Logger,
  type TelemetryMessage,
} from '@telemetry/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { loadEmulatorConfig, type EmulatorConfig } from './config.js';
import { DeviceClient } from './device.js';
import { createRandom } from './random.js';
import { startTestSink, type TestSink } from './test-sink.js';

function silentLogger(): Logger {
  return createLogger({
    service: 'test',
    level: 'silent',
    destination: { write: () => undefined },
  });
}

function configFor(port: number, overrides: Record<string, string> = {}): EmulatorConfig {
  return loadEmulatorConfig({
    INGEST_HOSTS: `127.0.0.1:${String(port)}`,
    EMULATOR_EVENT_INTERVAL_MS: '20',
    EMULATOR_HEARTBEAT_MS: '5000',
    ...overrides,
  });
}

function parse(lines: readonly string[]): TelemetryMessage[] {
  return lines.map((line) => {
    const result = telemetryMessageSchema.safeParse(JSON.parse(line));
    expect(result.success, line).toBe(true);
    if (!result.success) throw new Error('unreachable');
    return result.data;
  });
}

const open: { sinks: TestSink[]; clients: DeviceClient[] } = { sinks: [], clients: [] };

async function sink(): Promise<TestSink> {
  const created = await startTestSink();
  open.sinks.push(created);
  return created;
}

function client(config: EmulatorConfig, seed = 5): DeviceClient {
  const created = new DeviceClient({
    deviceId: 'dev-0001',
    config,
    random: createRandom(seed),
    logger: silentLogger(),
  });
  open.clients.push(created);
  return created;
}

afterEach(async () => {
  await Promise.all(open.clients.map((created) => created.stop()));
  await Promise.all(open.sinks.map((created) => created.close()));
  open.clients.length = 0;
  open.sinks.length = 0;
});

describe('DeviceClient', () => {
  it('delivers valid messages with a strictly increasing, gapless seq', async () => {
    const target = await sink();
    const device = client(configFor(target.port));
    device.start();

    const messages = parse(await target.waitForLines(15));
    expect(messages.map((m) => m.seq)).toEqual(messages.map((_unused, i) => i + 1));
    expect(new Set(messages.map((m) => m.sessionId)).size).toBe(1);
    expect(messages.every((m) => m.deviceId === 'dev-0001')).toBe(true);
  });

  it('opens the session with status online at seq 1', async () => {
    const target = await sink();
    const device = client(configFor(target.port));
    device.start();

    const [first] = parse(await target.waitForLines(1));
    expect(first).toMatchObject({ seq: 1, type: 'status', payload: { state: 'online' } });
  });

  it('sends a heartbeat in an idle gap', async () => {
    // Heartbeat far shorter than the tick: the timer must fire between ticks.
    const target = await sink();
    const device = client(
      configFor(target.port, { EMULATOR_EVENT_INTERVAL_MS: '400', EMULATOR_HEARTBEAT_MS: '30' }),
    );
    device.start();

    const messages = parse(await target.waitForLines(8));
    // The heartbeat period is roughly thirteen times shorter than the tick, so nearly every line
    // must be a heartbeat status. Without the timer there would be exactly one status — the
    // session-start `online` — and the rest would be metrics, so this cannot pass by accident.
    const statuses = messages.filter((m) => m.type === 'status').length;
    const metrics = messages.filter((m) => m.type === 'metrics').length;
    expect(statuses).toBeGreaterThan(metrics);
    expect(statuses).toBeGreaterThanOrEqual(5);
  });

  it('sends no heartbeat while ticks keep re-arming the timer', async () => {
    // Six heartbeat periods fit inside the observation window, so a plain periodic timer would
    // produce about six extra status messages. Exactly one status means the re-arm works.
    const target = await sink();
    const device = client(
      configFor(target.port, { EMULATOR_EVENT_INTERVAL_MS: '20', EMULATOR_HEARTBEAT_MS: '100' }),
      5,
    );
    device.start();

    const messages = parse(await target.waitForLines(25));
    const statuses = messages.filter((m) => m.type === 'status');
    expect(statuses).toHaveLength(1);
    expect(statuses[0]?.payload).toEqual({ state: 'online' });
    // ...and the device really did stay healthy, so "one status" cannot mean "no state change
    // happened to report" for the wrong reason.
    const metrics = messages.filter((m) => m.type === 'metrics');
    expect(metrics.length).toBeGreaterThan(10);
    expect(metrics.every((m) => m.payload.cpuPercent <= 90 && m.payload.temperatureC <= 75)).toBe(
      true,
    );
  });

  it('keeps generating while disconnected and delivers the backlog after reconnecting', async () => {
    const target = await sink();
    const device = client(configFor(target.port));
    device.start();
    const before = parse(await target.waitForLines(5));

    target.dropConnections();
    const after = parse(await target.waitForLines(before.length + 10));

    expect(target.connectionCount()).toBeGreaterThanOrEqual(2);
    // No gap and no repeat across the break: the outbox held them and the session kept counting.
    expect(after.map((m) => m.seq)).toEqual(after.map((_unused, i) => i + 1));
  });

  it('stops cleanly', async () => {
    const target = await sink();
    const device = client(configFor(target.port));
    device.start();
    await target.waitForLines(3);

    await device.stop();
    expect(device.isConnected).toBe(false);
    expect(device.connectionState).toBe('stopped');
  });

  it('queues nothing after the farewell, however long the drain takes', async () => {
    // The regression test for the stopped flag. `prepareShutdown` enqueues, and every enqueue
    // re-arms the heartbeat timer — so without the guard a slow drain gives that timer time to
    // fire and put a `status` on the wire after the `offline` farewell. The fleet-level test
    // cannot catch this: there the drain finishes in under a millisecond, so the timer never
    // gets the chance. Here the wait is explicit and covers several heartbeat periods.
    const target = await sink();
    const device = client(configFor(target.port, { EMULATOR_HEARTBEAT_MS: '20' }));
    device.start();
    await target.waitForLines(5);

    device.stopGenerating();
    device.prepareShutdown();
    const queuedAtShutdown = device.outboxLength;

    // Five heartbeat periods of real time. A live timer would fire repeatedly in this window.
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Nothing new may have been queued while we waited. This is the assertion that bites: a live
    // heartbeat timer would have added several messages behind the farewell.
    expect(device.outboxLength).toBe(queuedAtShutdown);
    device.pump();

    // Wait for the farewell to actually reach the sink — `waitForLines(n)` would be satisfied by
    // the lines that arrived before shutdown and would read the wrong "last" message.
    await vi.waitFor(() => {
      const offline = parse(target.lines()).filter(
        (m) => m.type === 'status' && m.payload.state === 'offline',
      );
      expect(offline).toHaveLength(1);
    });
    expect(parse(target.lines()).at(-1)).toMatchObject({
      type: 'status',
      payload: { state: 'offline' },
    });
  });

  it('counts what it generated and what it wrote', async () => {
    const target = await sink();
    const device = client(configFor(target.port));
    device.start();
    await target.waitForLines(10);

    expect(device.stats.generated).toBeGreaterThan(0);
    expect(device.stats.written).toBeGreaterThanOrEqual(10);
    expect(device.stats.dropped).toBe(0);
  });
});
