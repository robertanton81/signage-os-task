import {
  createLogger,
  telemetryMessageSchema,
  type Logger,
  type TelemetryMessage,
} from '@telemetry/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { loadEmulatorConfig, type EmulatorConfig } from './config.js';
import { Fleet } from './fleet.js';
import { startTestSink, type TestSink } from './test-sink.js';

/** A logger whose lines the test can read, for the assertions about warnings. */
function collectingLogger(): { logger: Logger; lines: () => string[] } {
  const lines: string[] = [];
  const logger = createLogger({
    service: 'test',
    level: 'trace',
    destination: {
      write: (line: string) => {
        lines.push(line);
      },
    },
  });
  return { logger, lines: () => [...lines] };
}

function configFor(port: number, overrides: Record<string, string> = {}): EmulatorConfig {
  return loadEmulatorConfig({
    INGEST_HOSTS: `127.0.0.1:${String(port)}`,
    EMULATOR_EVENT_INTERVAL_MS: '20',
    EMULATOR_HEARTBEAT_MS: '5000',
    EMULATOR_DEVICE_COUNT: '3',
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

function byDevice(messages: readonly TelemetryMessage[]): Map<string, TelemetryMessage[]> {
  const grouped = new Map<string, TelemetryMessage[]>();
  for (const message of messages) {
    const existing = grouped.get(message.deviceId) ?? [];
    existing.push(message);
    grouped.set(message.deviceId, existing);
  }
  return grouped;
}

/**
 * `shutdown()` resolving means the bytes reached the kernel, not that the sink's data handler has
 * run. Every assertion about the farewell therefore waits for it to actually arrive; reading
 * `lines()` straight after shutdown is a race, not a check.
 */
async function waitForFarewells(target: TestSink, devices: number): Promise<TelemetryMessage[]> {
  await vi.waitFor(() => {
    const offline = parse(target.messages()).filter(
      (m) => m.type === 'status' && m.payload.state === 'offline',
    );
    expect(offline).toHaveLength(devices);
  });
  return parse(target.messages());
}

const open: { sinks: TestSink[]; fleets: Fleet[] } = { sinks: [], fleets: [] };

async function sink(): Promise<TestSink> {
  const created = await startTestSink();
  open.sinks.push(created);
  return created;
}

function fleet(options: ConstructorParameters<typeof Fleet>[0]): Fleet {
  const created = new Fleet(options);
  open.fleets.push(created);
  return created;
}

afterEach(async () => {
  await Promise.all(open.fleets.map((created) => created.shutdown()));
  await Promise.all(open.sinks.map((created) => created.close()));
  open.fleets.length = 0;
  open.sinks.length = 0;
});

describe('Fleet', () => {
  it('gives every device its own connection, id and seq sequence', async () => {
    const target = await sink();
    const { logger } = collectingLogger();
    fleet({ config: configFor(target.port), logger }).start();

    const messages = parse(await target.waitForMessages(30));
    const grouped = byDevice(messages);
    expect([...grouped.keys()].sort()).toEqual(['dev-0001', 'dev-0002', 'dev-0003']);
    expect(target.connectionCount()).toBeGreaterThanOrEqual(3);
    for (const [, forDevice] of grouped) {
      expect(forDevice.map((m) => m.seq)).toEqual(forDevice.map((_unused, i) => i + 1));
    }
  });

  it('ends every device with status offline as its last message', async () => {
    const target = await sink();
    const { logger } = collectingLogger();
    const running = fleet({ config: configFor(target.port), logger });
    running.start();
    await target.waitForMessages(15);

    await running.shutdown();

    const grouped = byDevice(await waitForFarewells(target, 3));
    expect(grouped.size).toBe(3);
    for (const [deviceId, forDevice] of grouped) {
      const last = forDevice.at(-1);
      expect(last, deviceId).toMatchObject({ type: 'status', payload: { state: 'offline' } });
    }
  });

  it('delivers a message held by out-of-order chaos at shutdown', async () => {
    // At 100 per cent, a message is in the hold slot whenever shutdown arrives. If the farewell
    // were routed back through the policy it would be captured there and lost silently, and the
    // per-device seq run would be missing its highest value.
    const target = await sink();
    const { logger } = collectingLogger();
    const running = fleet({
      config: configFor(target.port, {
        EMULATOR_CHAOS: 'out-of-order',
        EMULATOR_CHAOS_PERCENT: '100',
      }),
      logger,
    });
    running.start();
    await target.waitForMessages(15);

    await running.shutdown();

    for (const [deviceId, forDevice] of byDevice(await waitForFarewells(target, 3))) {
      const seqs = forDevice.map((m) => m.seq).sort((a, b) => a - b);
      expect(seqs, deviceId).toEqual(seqs.map((_unused, i) => i + 1));
    }
  });

  it('gives up inside the budget and warns when a device cannot deliver', async () => {
    // Bind a port, then release it: every device stays in backoff and nothing can be written.
    const temporary = await startTestSink();
    const { port } = temporary;
    await temporary.close();

    const { logger, lines } = collectingLogger();
    const running = fleet({
      config: configFor(port, { SHUTDOWN_TIMEOUT_MS: '200' }),
      logger,
    });
    running.start();

    const startedAt = Date.now();
    await running.shutdown();
    const elapsed = Date.now() - startedAt;

    expect(elapsed).toBeLessThan(2_000);
    const warnings = lines().filter((line) => line.includes('shutdown timed out'));
    expect(warnings.length).toBeGreaterThanOrEqual(1);
    // The warning must identify which device and how much it lost.
    expect(warnings[0]).toContain('"deviceId":"dev-000');
    expect(warnings[0]).toContain('"remaining"');
  });

  it('stops the summary interval on shutdown', async () => {
    const target = await sink();
    const { logger, lines } = collectingLogger();
    const running = fleet({
      config: configFor(target.port),
      logger,
      summaryIntervalMs: 10,
    });
    running.start();
    await target.waitForMessages(5);

    await running.shutdown();
    const after = lines().filter((line) => line.includes('emulator fleet summary')).length;
    await new Promise((resolve) => setTimeout(resolve, 60));
    const later = lines().filter((line) => line.includes('emulator fleet summary')).length;
    // Six poll periods pass; an uncleared interval would have logged again.
    expect(later).toBe(after);
  });

  it('sends nothing after the farewell even when the heartbeat period fits in the drain', async () => {
    // Guards the stopped flag: without it, prepareShutdown's push re-arms the heartbeat timer
    // that shutdown just cleared, and a status lands after the offline farewell.
    const target = await sink();
    const { logger } = collectingLogger();
    const running = fleet({
      config: configFor(target.port, {
        EMULATOR_HEARTBEAT_MS: '20',
        SHUTDOWN_TIMEOUT_MS: '300',
      }),
      logger,
    });
    running.start();
    await target.waitForMessages(10);

    await running.shutdown();
    await waitForFarewells(target, 3);
    // Then give any wrongly re-armed heartbeat several periods to show itself.
    await new Promise((resolve) => setTimeout(resolve, 150));

    for (const [deviceId, forDevice] of byDevice(parse(target.messages()))) {
      const offlineIndex = forDevice.findIndex(
        (m) => m.type === 'status' && m.payload.state === 'offline',
      );
      expect(offlineIndex, deviceId).toBeGreaterThanOrEqual(0);
      expect(offlineIndex, deviceId).toBe(forDevice.length - 1);
    }
  });
});
