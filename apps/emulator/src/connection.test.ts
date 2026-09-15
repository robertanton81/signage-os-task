import http from 'node:http';

import { createLogger, encodeMessage, type Logger, type TelemetryMessage } from '@telemetry/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';

import { DeviceConnection, socketUrl } from './connection.js';
import { createRandom, type Random } from './random.js';
import { startTestSink, type TestSink } from './test-sink.js';

function silentLogger(): Logger {
  return createLogger({
    service: 'test',
    level: 'silent',
    destination: { write: () => undefined },
  });
}

/** A logger whose lines the test can read. */
function collectingLogger(): { logger: Logger; lines: () => Record<string, unknown>[] } {
  const lines: Record<string, unknown>[] = [];
  const logger = createLogger({
    service: 'test',
    level: 'debug',
    destination: {
      write: (line: string) => {
        lines.push(JSON.parse(line) as Record<string, unknown>);
      },
    },
  });
  return { logger, lines: () => [...lines] };
}

function text(seq: number): string {
  const message: TelemetryMessage = {
    v: 1,
    deviceId: 'dev-0001',
    sessionId: 1_700_000_000_000,
    seq,
    occurredAt: 1_700_000_000_000,
    type: 'metrics',
    payload: { temperatureC: 40, cpuPercent: 10, ramPercent: 50 },
  };
  return encodeMessage(message);
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

const open: { sinks: TestSink[]; connections: DeviceConnection[]; servers: http.Server[] } = {
  sinks: [],
  connections: [],
  servers: [],
};

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

/** A server that answers every upgrade with 404: ingest with another path, or not ingest at all. */
async function rejectingServer(): Promise<number> {
  const server = http.createServer();
  server.on('upgrade', (_request, socket) => {
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
    socket.destroy();
  });
  open.servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  return typeof address === 'object' && address !== null ? address.port : 0;
}

afterEach(async () => {
  await Promise.all(open.connections.map((connection) => connection.stop()));
  await Promise.all(open.sinks.map((created) => created.close()));
  await Promise.all(
    open.servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
  open.connections.length = 0;
  open.sinks.length = 0;
  open.servers.length = 0;
});

describe('socketUrl', () => {
  it('builds the endpoint URL and brackets an IPv6 literal', () => {
    expect(socketUrl({ host: '10.0.0.5', port: 4000 })).toBe('ws://10.0.0.5:4000/telemetry');
    expect(socketUrl({ host: 'ingest', port: 4000 })).toBe('ws://ingest:4000/telemetry');
    expect(socketUrl({ host: '::1', port: 4000 })).toBe('ws://[::1]:4000/telemetry');
  });
});

describe('DeviceConnection', () => {
  it('connects and sends complete messages in the order written', async () => {
    const target = await sink();
    const connection = connect(target.port, () => {
      for (let seq = 1; seq <= 3; seq += 1) connection.write(text(seq));
    });
    connection.start();

    const messages = await target.waitForMessages(3);
    expect(messages.map((line) => (JSON.parse(line) as TelemetryMessage).seq)).toEqual([1, 2, 3]);
  });

  it('reconnects after the peer drops the connection and keeps sending', async () => {
    const target = await sink();
    let seq = 0;
    const connection = connect(target.port, () => {
      seq += 1;
      connection.write(text(seq));
    });
    connection.start();
    await target.waitForMessages(1);

    target.dropConnections();
    // The connection re-resolves and reconnects on its own; onWritable fires again on connect.
    await target.waitForMessages(2);
    expect(target.connectionCount()).toBeGreaterThanOrEqual(2);
  });

  it('refuses to write while not connected', async () => {
    const target = await sink();
    const connection = connect(target.port);
    // Nothing started yet, so there is no socket at all.
    expect(connection.write(text(1))).toBe(false);
    expect(target.messages()).toEqual([]);
  });

  it('reports a stopped state and writes nothing after stop()', async () => {
    const target = await sink();
    const connection = connect(target.port, () => connection.write(text(1)));
    connection.start();
    await target.waitForMessages(1);

    await connection.stop();
    expect(connection.state.name).toBe('stopped');
    expect(connection.isConnected).toBe(false);
    expect(connection.write(text(2))).toBe(false);
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
      onWritable: () => connection.write(text(1)),
    });
    open.connections.push(connection);
    connection.start();

    const messages = await target.waitForMessages(1);
    expect((JSON.parse(messages[0] ?? '{}') as TelemetryMessage).seq).toBe(1);
  });

  it('connects through the address that resolved while another lookup never answers', async () => {
    const target = await sink();
    const connection = new DeviceConnection({
      deviceId: 'dev-0001',
      hosts: [
        { host: 'slow.test', port: 1 },
        { host: 'fast.test', port: target.port },
      ],
      random: createRandom(3),
      logger: silentLogger(),
      onWritable: () => connection.write(text(1)),
      resolveTimeoutMs: 100,
      // `dns.lookup` has no timeout: a resolver that never answers looks exactly like this.
      lookup: (host) =>
        host === 'fast.test'
          ? Promise.resolve([{ address: '127.0.0.1' }])
          : new Promise(() => undefined),
    });
    open.connections.push(connection);
    connection.start();

    const messages = await target.waitForMessages(1);
    expect((JSON.parse(messages[0] ?? '{}') as TelemetryMessage).seq).toBe(1);
  });

  it('stops waiting at the deadline and backs off when no lookup answered', async () => {
    const { logger, lines } = collectingLogger();
    const connection = new DeviceConnection({
      deviceId: 'dev-0001',
      hosts: [{ host: 'slow.test', port: 1 }],
      random: fixedRandom(0.5),
      logger,
      onWritable: () => undefined,
      resolveTimeoutMs: 20,
      lookup: () => new Promise(() => undefined),
    });
    open.connections.push(connection);
    connection.start();

    await vi.waitFor(() => {
      expect(connection.state.name).toBe('backoff');
    });
    const deadline = lines().filter((line) => line.msg === 'dns lookup deadline reached');
    expect(deadline.map((line) => [line.resolved, line.hosts])).toEqual([[0, 1]]);
  });

  it('drops a lookup that answers after the deadline, and only logs it at debug', async () => {
    const { logger, lines } = collectingLogger();
    const late = new Map<
      string,
      { resolve: (value: { address: string }[]) => void; reject: (error: Error) => void }
    >();
    const connection = new DeviceConnection({
      deviceId: 'dev-0001',
      hosts: [
        { host: 'late-answer.test', port: 1 },
        { host: 'late-failure.test', port: 1 },
      ],
      random: fixedRandom(0.5),
      logger,
      onWritable: () => undefined,
      resolveTimeoutMs: 20,
      lookup: (host) =>
        new Promise((resolve, reject) => {
          late.set(host, { resolve, reject });
        }),
    });
    open.connections.push(connection);
    connection.start();
    await vi.waitFor(() => {
      expect(connection.state.name).toBe('backoff');
    });
    await connection.stop();

    late.get('late-answer.test')?.resolve([{ address: '127.0.0.1' }]);
    late.get('late-failure.test')?.reject(new Error('ENOTFOUND'));
    await vi.waitFor(() => {
      const after = lines().filter((line) => String(line.msg).endsWith('after the deadline'));
      expect(after.map((line) => [line.level, line.msg, line.host])).toEqual([
        [20, 'dns lookup answered after the deadline', 'late-answer.test'],
        [20, 'dns lookup failed after the deadline', 'late-failure.test'],
      ]);
    });
    expect(lines().filter((line) => line.msg === 'dns lookup failed')).toEqual([]);
  });

  it('takes the message that reaches the high-water mark, refuses the next, and becomes writable again through the send callback after the peer reads again', async () => {
    // The one thing worth testing here, and the reason these tests use a real socket at all: a
    // mocked socket would only test the mock's idea of when the send buffer is full.
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

    // Send until the kernel and the socket's own buffer are full. 16 KiB at a time so this ends
    // quickly; the cap stops a runaway if backpressure never appears. Every message up to and
    // including the one that reaches the mark is taken: that message is queued, and reporting
    // it as refused would make the pump send it again after the buffer drained.
    const chunk = 'a'.repeat(16 * 1024);
    let taken = 0;
    while (isWritable(connection) && taken < 4_000) {
      expect(connection.write(chunk)).toBe(true);
      taken += 1;
    }
    expect(isWritable(connection)).toBe(false);
    // The next message is refused rather than queued behind the backlog.
    expect(connection.write(chunk)).toBe(false);

    writable = false;
    target.resumeConnections();

    // The send callback must fire and re-open the pump; without it the device would stay stuck.
    await vi.waitFor(
      () => {
        expect(writable).toBe(true);
      },
      { timeout: 5_000 },
    );
    expect(isWritable(connection)).toBe(true);
    // Nothing was lost or sent twice: the sink holds exactly what was taken, in order.
    await target.waitForMessages(taken);
    expect(target.messages()).toHaveLength(taken);
  }, 20_000);

  it('refuses a message once its socket is terminated, before the close event arrives', async () => {
    // `dropConnection()` destroys the socket at once, but the move to backoff waits for 'close',
    // which ws emits later. A send in that gap fails only through its callback, so the message
    // must be reported as not taken and stay in the outbox for the next connection.
    const target = await sink();
    const connection = connect(target.port);
    connection.start();
    await vi.waitFor(() => {
      expect(connection.isConnected).toBe(true);
    });

    connection.dropConnection();

    // Still inside the gap; otherwise the refusal below would come from the state check.
    expect(connection.state.name).toBe('connected');
    expect(connection.write(text(1))).toBe(false);
  });

  it('abandons a handshake that never completes, instead of stalling forever', async () => {
    // 198.51.100.0/24 is TEST-NET-2 (RFC 5737): reserved for documentation and not routed, so the
    // SYN is dropped rather than refused. That is the black-hole case — no 'error', no 'close' —
    // which without a handshake timeout leaves the device in `connecting` for the OS SYN budget.
    // The timeout is overridden low so the test does not wait ten seconds for it. This relies on
    // the environment dropping the packets: a firewall that answers with a reset instead would
    // turn the timeout error below into ECONNREFUSED or ENETUNREACH, and the test would fail for a
    // reason unrelated to the connection code.
    const { logger, lines } = collectingLogger();
    const connection = new DeviceConnection({
      deviceId: 'dev-0001',
      hosts: [{ host: '198.51.100.1', port: 9 }],
      random: createRandom(3),
      logger,
      onWritable: () => undefined,
      connectTimeoutMs: 150,
    });
    open.connections.push(connection);
    connection.start();

    // `backoff` specifically. Accepting `resolving` too would make this pass instantly and for
    // the wrong reason: `start()` sets `resolving` synchronously, so `vi.waitFor` would return on
    // its first call, before the handshake has had any chance to time out.
    await vi.waitFor(
      () => {
        expect(connection.state.name).toBe('backoff');
      },
      { timeout: 4_000 },
    );
    // `backoff` is re-entered after every failed attempt, and Full Jitter can schedule the next
    // attempt almost at once (`backoffDelay`), so on a slow runner a second handshake can time out
    // before `vi.waitFor` polls (two lines on the CI runner, 2026-09-15). The first attempt is
    // the subject; every attempt must have ended the same way.
    const reasons = lines()
      .filter((line) => line.msg === 'device socket error')
      .map((line) => (line.err as { message: string }).message);
    expect(reasons.length).toBeGreaterThanOrEqual(1);
    expect(new Set(reasons)).toEqual(new Set(['Opening handshake has timed out']));
  });

  it('closes within its own deadline even when the peer never responds', async () => {
    const { logger, lines } = collectingLogger();
    const connection = new DeviceConnection({
      deviceId: 'dev-0001',
      hosts: [{ host: '198.51.100.1', port: 9 }],
      random: createRandom(3),
      logger,
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
    // The handshake is aborted at once, not after the 30 s handshake timeout above.
    expect(Date.now() - startedAt).toBeLessThan(3_000);
    expect(connection.state.name).toBe('stopped');
    // The abort raises an error on the socket; once stopped it is noise, logged at debug only.
    await vi.waitFor(() => {
      expect(lines().filter((line) => line.msg === 'device socket error')).toHaveLength(1);
    });
    expect(lines().filter((line) => line.msg === 'device socket error')[0]).toMatchObject({
      level: 20,
      err: { message: 'WebSocket was closed before the connection was established' },
    });
  });

  it('goes to backoff when the target refuses the connection', async () => {
    // Take a port, then release it: connecting there is refused rather than hanging.
    const temporary = await startTestSink();
    const { port } = temporary;
    await temporary.close();

    const connection = connect(port);
    connection.start();
    // `backoff` and nothing else: accepting `resolving` or `connecting` too would make this pass
    // on the first poll, since `start()` reaches them synchronously — identically whether or not
    // the backoff transition ever ran.
    await vi.waitFor(() => {
      expect(connection.state.name).toBe('backoff');
    });
  });

  it('goes to backoff when the server rejects the upgrade, and logs the response', async () => {
    const port = await rejectingServer();
    const { logger, lines } = collectingLogger();
    const connection = new DeviceConnection({
      deviceId: 'dev-0001',
      hosts: [{ host: '127.0.0.1', port }],
      random: createRandom(3),
      logger,
      onWritable: () => undefined,
    });
    open.connections.push(connection);
    connection.start();

    await vi.waitFor(() => {
      expect(connection.state.name).toBe('backoff');
    });
    // The first attempt only: the seeded backoff can schedule a retry within the wait above, and
    // that retry is refused the same way.
    const [error] = lines().filter((line) => line.msg === 'device socket error');
    expect(error).toMatchObject({ level: 40, err: { message: 'Unexpected server response: 404' } });
    const [closed] = lines().filter((line) => line.msg === 'device socket closed, reconnecting');
    expect(closed).toMatchObject({ attempt: 0, closeCode: 1006 });
  });

  it('does not connect when stopped during a DNS lookup that answers afterwards', async () => {
    // `stop()` can run while `#resolveAndConnect` awaits the lookups; the check after the await
    // is what keeps a stopped device from opening a socket the caller will never close.
    const target = await sink();
    let answer: ((value: { address: string }[]) => void) | undefined;
    const connection = new DeviceConnection({
      deviceId: 'dev-0001',
      hosts: [{ host: 'late.test', port: target.port }],
      random: createRandom(3),
      logger: silentLogger(),
      onWritable: () => undefined,
      lookup: () =>
        new Promise((resolve) => {
          answer = resolve;
        }),
    });
    open.connections.push(connection);
    connection.start();
    expect(connection.state.name).toBe('resolving');

    await connection.stop();
    expect(answer).toBeDefined();
    answer?.([{ address: '127.0.0.1' }]);
    // The lookup has answered and would have connected; give a connect attempt time to show up.
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(connection.state.name).toBe('stopped');
    expect(target.connectionCount()).toBe(0);
  });

  it('stops within its own deadline when the peer never reads the close frame', async () => {
    const target = await sink();
    const connection = connect(target.port);
    connection.start();
    await vi.waitFor(() => {
      expect(connection.isConnected).toBe(true);
    });
    // A paused peer reads nothing, so it never replies to the close frame and the closing
    // handshake cannot finish; only the cap ends the wait.
    target.pauseConnections();

    const startedAt = performance.now();
    await connection.stop();
    const elapsed = performance.now() - startedAt;
    expect(elapsed).toBeGreaterThanOrEqual(900);
    expect(elapsed).toBeLessThan(3_000);
    expect(connection.state.name).toBe('stopped');
  });

  it('does not reopen the gate from the failed callback of a terminated socket, only from the next connection', async () => {
    // A gated send whose socket is destroyed calls back with an error. Without the error check,
    // that callback would mark the dead connection writable and run the pump into it.
    const target = await sink();
    const seen: string[] = [];
    const connection = connect(target.port, () => {
      const state = connection.state;
      seen.push(
        state.name === 'connected'
          ? `connected:${state.socket.readyState === WebSocket.OPEN ? 'open' : 'not-open'}`
          : state.name,
      );
    });
    connection.start();
    await vi.waitFor(() => {
      expect(connection.isConnected).toBe(true);
    });
    target.pauseConnections();
    const chunk = 'a'.repeat(16 * 1024);
    let taken = 0;
    while (isWritable(connection) && taken < 4_000) {
      connection.write(chunk);
      taken += 1;
    }
    expect(isWritable(connection)).toBe(false);
    const before = seen.length;

    connection.dropConnection();
    // The reconnect opens a new socket; its 'open' is the next legitimate writable signal.
    await vi.waitFor(
      () => {
        expect(target.connectionCount()).toBe(2);
        expect(connection.isConnected).toBe(true);
      },
      { timeout: 5_000 },
    );
    expect(seen.slice(before)).toEqual(['connected:open']);
    target.resumeConnections();
  }, 20_000);

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
      // Every attempt also arms the DNS deadline timer; a value no retry can produce makes it
      // recognisable, so it is filtered out of the recorded calls below. ws's handshake timeout is
      // the request socket's own timer, not a global `setTimeout`, so it never shows up here.
      const resolveTimeoutMs = 1_234;
      const connection = new DeviceConnection({
        deviceId: 'dev-0001',
        hosts: [{ host: '127.0.0.1', port }],
        random: fixedRandom(0.01),
        logger: silentLogger(),
        onWritable: () => undefined,
        resolveTimeoutMs,
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
      // above out of the way every recorded call is either the DNS deadline of an attempt or a
      // retry the connection scheduled.
      const delays = timeouts.mock.calls
        .filter(([, ms]) => ms !== resolveTimeoutMs)
        .slice(0, 6)
        .map(([, ms]) => Math.round((ms ?? Number.NaN) * 1_000) / 1_000);
      expect(delays).toEqual([5, 10, 20, 40, 80, 100]);
    } finally {
      timeouts.mockRestore();
    }
  });
});
