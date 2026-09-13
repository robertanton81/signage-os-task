import { createLogger, encodeFrame, type Logger, type TelemetryMessage } from '@telemetry/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { DeviceConnection } from './connection.js';
import { createRandom, type Random } from './random.js';
import { startTestSink, type TestSink } from './test-sink.js';

function silentLogger(): Logger {
  return createLogger({
    service: 'test',
    level: 'silent',
    destination: { write: () => undefined },
  });
}

function frame(seq: number): Buffer {
  const message: TelemetryMessage = {
    v: 1,
    deviceId: 'dev-0001',
    sessionId: 1_700_000_000_000,
    seq,
    occurredAt: 1_700_000_000_000,
    type: 'metrics',
    payload: { temperatureC: 40, cpuPercent: 10, ramPercent: 50 },
  };
  return encodeFrame(message);
}

/** A Random whose every draw is `value`, so a retry delay is a pure function of the attempt. */
function fixedRandom(value: number): Random {
  return {
    float: () => value,
    int: (min) => min,
    bool: () => false,
    pick: (values) => values[0],
    range: (min, max) => min + value * (max - min),
  };
}

function isWritable(connection: DeviceConnection): boolean {
  const state = connection.state;
  return state.name === 'connected' && state.writable;
}

const open: { sinks: TestSink[]; connections: DeviceConnection[] } = { sinks: [], connections: [] };

async function sink(): Promise<TestSink> {
  const created = await startTestSink();
  open.sinks.push(created);
  return created;
}

function connect(port: number, onWritable: () => void = () => undefined): DeviceConnection {
  const connection = new DeviceConnection({
    deviceId: 'dev-0001',
    hosts: [{ host: '127.0.0.1', port }],
    random: createRandom(3),
    logger: silentLogger(),
    onWritable,
  });
  open.connections.push(connection);
  return connection;
}

afterEach(async () => {
  await Promise.all(open.connections.map((connection) => connection.stop()));
  await Promise.all(open.sinks.map((created) => created.close()));
  open.connections.length = 0;
  open.sinks.length = 0;
});

describe('DeviceConnection', () => {
  it('connects and writes complete frames in the order written', async () => {
    const target = await sink();
    const connection = connect(target.port, () => {
      for (let seq = 1; seq <= 3; seq += 1) connection.write(frame(seq));
    });
    connection.start();

    const lines = await target.waitForLines(3);
    expect(lines.map((line) => (JSON.parse(line) as TelemetryMessage).seq)).toEqual([1, 2, 3]);
  });

  it('reconnects after the peer drops the connection and keeps sending', async () => {
    const target = await sink();
    let seq = 0;
    const connection = connect(target.port, () => {
      seq += 1;
      connection.write(frame(seq));
    });
    connection.start();
    await target.waitForLines(1);

    target.dropConnections();
    // The connection re-resolves and reconnects on its own; onWritable fires again on connect.
    await target.waitForLines(2);
    expect(target.connectionCount()).toBeGreaterThanOrEqual(2);
  });

  it('refuses to write while not connected', async () => {
    const target = await sink();
    const connection = connect(target.port);
    // Nothing started yet, so there is no socket at all.
    expect(connection.write(frame(1))).toBe(false);
    expect(target.lines()).toEqual([]);
  });

  it('reports a stopped state and writes nothing after stop()', async () => {
    const target = await sink();
    const connection = connect(target.port, () => connection.write(frame(1)));
    connection.start();
    await target.waitForLines(1);

    await connection.stop();
    expect(connection.state.name).toBe('stopped');
    expect(connection.isConnected).toBe(false);
    expect(connection.write(frame(2))).toBe(false);
  });

  it('skips a host that does not resolve and connects through the one that does', async () => {
    const target = await sink();
    const connection = new DeviceConnection({
      deviceId: 'dev-0001',
      hosts: [
        { host: 'this-host-does-not-exist.invalid', port: 1 },
        { host: '127.0.0.1', port: target.port },
      ],
      random: createRandom(3),
      logger: silentLogger(),
      onWritable: () => connection.write(frame(1)),
    });
    open.connections.push(connection);
    connection.start();

    const lines = await target.waitForLines(1);
    expect((JSON.parse(lines[0] ?? '{}') as TelemetryMessage).seq).toBe(1);
  });

  it('takes the frame that fills the buffer, then refuses frames until the peer reads again', async () => {
    // The one thing worth testing here, and the reason these tests use a real socket at all: a
    // mocked socket would only test the mock's idea of when `write()` returns false.
    const target = await sink();
    let writable = false;
    const connection = connect(target.port, () => {
      writable = true;
    });
    connection.start();
    await vi.waitFor(() => {
      expect(connection.isConnected).toBe(true);
    });

    target.pauseConnections();

    // Write until the kernel and the socket's own buffer are full. 64 KiB at a time so this ends
    // quickly; the cap stops a runaway if backpressure never appears. Every frame up to and
    // including the one that fills the buffer is taken: that frame is queued, and reporting it
    // as refused would make the pump write it again after 'drain'.
    const chunk = Buffer.alloc(64 * 1024, 0x61);
    let taken = 0;
    while (isWritable(connection) && taken < 500) {
      expect(connection.write(chunk)).toBe(true);
      taken += 1;
    }
    expect(isWritable(connection)).toBe(false);
    // The next frame is refused rather than queued behind the backlog.
    expect(connection.write(chunk)).toBe(false);

    writable = false;
    target.resumeConnections();

    // `'drain'` must fire and re-open the pump; without it the device would stay stuck forever.
    await vi.waitFor(
      () => {
        expect(writable).toBe(true);
      },
      { timeout: 5_000 },
    );
    expect(isWritable(connection)).toBe(true);
  });

  it('refuses a frame once its socket is destroyed, before the close event arrives', async () => {
    // `dropConnection()` destroys the socket at once, but the move to backoff waits for 'close',
    // which Node emits later. A frame written in that gap is discarded with ERR_STREAM_DESTROYED,
    // so it must be reported as not taken and stay in the outbox for the next connection.
    const target = await sink();
    const connection = connect(target.port);
    connection.start();
    await vi.waitFor(() => {
      expect(connection.isConnected).toBe(true);
    });

    connection.dropConnection();

    // Still inside the gap; otherwise the refusal below would come from the state check.
    expect(connection.state.name).toBe('connected');
    expect(connection.write(frame(1))).toBe(false);
  });

  it('abandons a connect attempt that never completes, instead of stalling forever', async () => {
    // 198.51.100.0/24 is TEST-NET-2 (RFC 5737): reserved for documentation and not routed, so the
    // SYN is dropped rather than refused. That is the black-hole case — no 'error', no 'close' —
    // which without a connect timeout leaves the device in `connecting` for the OS SYN budget.
    // The timeout is overridden low so the test does not wait ten seconds for it.
    const connection = new DeviceConnection({
      deviceId: 'dev-0001',
      hosts: [{ host: '198.51.100.1', port: 9 }],
      random: createRandom(3),
      logger: silentLogger(),
      onWritable: () => undefined,
      connectTimeoutMs: 150,
    });
    open.connections.push(connection);
    connection.start();

    // `backoff` specifically. Accepting `resolving` too would make this pass instantly and for
    // the wrong reason: `start()` sets `resolving` synchronously, so `vi.waitFor` would return on
    // its first call, before the connect has had any chance to time out.
    await vi.waitFor(
      () => {
        expect(connection.state.name).toBe('backoff');
      },
      { timeout: 4_000 },
    );
  });

  it('closes within its own deadline even when the peer never responds', async () => {
    const connection = new DeviceConnection({
      deviceId: 'dev-0001',
      hosts: [{ host: '198.51.100.1', port: 9 }],
      random: createRandom(3),
      logger: silentLogger(),
      onWritable: () => undefined,
      connectTimeoutMs: 30_000,
    });
    open.connections.push(connection);
    connection.start();
    // Let it reach `connecting` against the black hole, then stop while it is still there.
    await vi.waitFor(() => {
      expect(connection.state.name).toBe('connecting');
    });

    const startedAt = Date.now();
    await connection.stop();
    // Bounded by CLOSE_TIMEOUT_MS, not by the 30 s connect timeout above.
    expect(Date.now() - startedAt).toBeLessThan(3_000);
    expect(connection.state.name).toBe('stopped');
  });

  it('goes to backoff when the target refuses the connection, and never throws', async () => {
    // Take a port, then release it: connecting there is refused rather than hanging.
    const temporary = await startTestSink();
    const { port } = temporary;
    await temporary.close();

    const connection = connect(port);
    connection.start();
    // `backoff` and nothing else. The earlier version of this test accepted `resolving` and
    // `connecting` as well, which `start()` reaches synchronously — so it returned on the first
    // poll and would have passed identically with the backoff transition deleted.
    await vi.waitFor(() => {
      expect(connection.state.name).toBe('backoff');
    });
  });

  it('retries on the emulator schedule, one seeded draw per retry', async () => {
    // A refused port fails every attempt at once, so each delay comes from the schedule alone:
    // 500 ms doubling to a 10 s cap (emulator spec, decision 17). A draw of 0.01 keeps six retries
    // under 300 ms and gives every ceiling a distinct delay, so swapping the base and the cap, or
    // passing `Math.random` instead of the seeded stream, changes the numbers below.
    const temporary = await startTestSink();
    const { port } = temporary;
    await temporary.close();

    // `vi.waitFor` asks `vi.isFakeTimers()` on every poll, and the first such call in a worker builds
    // vitest's fake-timer controller, which probes the CURRENT global with `setTimeout(NOOP, 0)`
    // (found with a stack capture). Building it before the spy exists keeps that probe out of the
    // recorded calls, whichever test in this file happens to run first.
    vi.isFakeTimers();
    const timeouts = vi.spyOn(globalThis, 'setTimeout');
    try {
      const connection = new DeviceConnection({
        deviceId: 'dev-0001',
        hosts: [{ host: '127.0.0.1', port }],
        random: fixedRandom(0.01),
        logger: silentLogger(),
        onWritable: () => undefined,
      });
      open.connections.push(connection);
      connection.start();

      // The backoff state holds the NEXT attempt, so 6 means the sixth delay has been scheduled.
      await vi.waitFor(
        () => {
          const state = connection.state;
          expect(state.name === 'backoff' ? state.attempt : 0).toBeGreaterThanOrEqual(6);
        },
        { timeout: 5_000 },
      );
      await connection.stop();

      // `vi.waitFor` itself polls with the timers vitest saved at worker setup, so with the probe
      // above out of the way every recorded call is a retry the connection scheduled.
      const delays = timeouts.mock.calls
        .slice(0, 6)
        .map(([, ms]) => Math.round((ms ?? Number.NaN) * 1_000) / 1_000);
      expect(delays).toEqual([5, 10, 20, 40, 80, 100]);
    } finally {
      timeouts.mockRestore();
    }
  });
});
