import { spawn, type ChildProcess } from 'node:child_process';
import net from 'node:net';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { connectTestDevice, type TestDevice } from './test-device.js';

const MAIN = fileURLToPath(new URL('./main.ts', import.meta.url));
const SOURCE_HOOKS = fileURLToPath(new URL('./test-source-hooks.ts', import.meta.url));

/** A credential that must never appear in the process output. Not a secret: a test value. */
const PLACEHOLDER = 'PLACEHOLDER_SECRET';
/** Short, so the test is quick; the drain below always runs to its budget. */
const SHUTDOWN_BUDGET_MS = 500;
/** The lines of a shutdown whose drain ran out of time, in order. */
const SHUTDOWN_LINES = [
  'shutting down',
  'shutdown drain ended at its budget',
  'publisher stopping',
  'stopped',
];

type LogLine = { msg: string; level: number; [field: string]: unknown };
type Exit = { code: number | null; signal: NodeJS.Signals | null };

type IngestProcess = {
  /** Every JSON line the child wrote to stdout, in order. */
  lines: () => LogLine[];
  /** Resolves once a line with this `msg` arrives; rejects with the diagnostics if the child ends first. */
  waitForLog: (msg: string) => Promise<void>;
  /** Resolves on 'close': the process has ended and its stdout has been read to the end. */
  closed: Promise<Exit>;
  /** Everything the child wrote to stderr, and any stdout line that was not JSON. */
  diagnostics: () => string;
  kill: (signal: NodeJS.Signals) => void;
};

const children: ChildProcess[] = [];
const servers: net.Server[] = [];
const devices: TestDevice[] = [];

function startIngest(env: Record<string, string>): IngestProcess {
  // The real entry point, from its sources (see `test-source-hooks.ts`). A passed `env` replaces the
  // parent's environment (Node child_process docs), so the child sees only the variables set here.
  const child = spawn(
    process.execPath,
    ['--experimental-transform-types', '--import', SOURCE_HOOKS, MAIN],
    { env, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  children.push(child);

  const lines: LogLine[] = [];
  const listeners = new Set<() => void>();
  let pending = '';
  let diagnostics = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    pending += chunk;
    let index = pending.indexOf('\n');
    while (index !== -1) {
      const raw = pending.slice(0, index);
      pending = pending.slice(index + 1);
      try {
        lines.push(JSON.parse(raw) as LogLine);
      } catch {
        // The logger writes JSON only, so such a line is itself the diagnosis.
        diagnostics += `[stdout, not JSON] ${raw}\n`;
      }
      index = pending.indexOf('\n');
    }
    for (const listener of [...listeners]) listener();
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    diagnostics += chunk;
  });
  child.once('error', (error) => {
    diagnostics += `[spawn error] ${error.message}\n`;
  });
  // 'close', not 'exit': 'exit' can fire while stdout still holds the last lines.
  const closed = new Promise<Exit>((resolve) => {
    child.once('close', (code, signal) => resolve({ code, signal }));
  });

  return {
    lines: () => [...lines],
    waitForLog: (msg) =>
      new Promise<void>((resolve, reject) => {
        const check = () => {
          if (lines.some((line) => line.msg === msg)) {
            listeners.delete(check);
            resolve();
          }
        };
        listeners.add(check);
        check();
        void closed.then(({ code }) => {
          if (listeners.delete(check)) {
            reject(
              new Error(
                `ingest ended (code ${String(code)}) before logging "${msg}":\n${diagnostics}`,
              ),
            );
          }
        });
      }),
    closed,
    diagnostics: () => diagnostics,
    kill: (signal) => {
      child.kill(signal);
    },
  };
}

function listen(server: net.Server, host?: string): Promise<number> {
  servers.push(server);
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    const onListening = () => {
      const address = server.address();
      resolve(typeof address === 'object' && address !== null ? address.port : 0);
    };
    if (host === undefined) {
      server.listen(0, onListening);
    } else {
      server.listen(0, host, onListening);
    }
  });
}

function close(server: net.Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

/** Distinct free ports, taken together and released together, so no two are the same. */
async function freePorts(count: number): Promise<number[]> {
  const held = Array.from({ length: count }, () => net.createServer());
  const ports = await Promise.all(held.map((server) => listen(server, '127.0.0.1')));
  await Promise.all(held.map((server) => close(server)));
  return ports;
}

function baseEnv(ports: {
  broker: number;
  ingest: number;
  health: number;
}): Record<string, string> {
  return {
    // Nothing listens on the broker port, so every connect attempt is refused.
    RABBITMQ_URL: `amqp://probe:${PLACEHOLDER}@127.0.0.1:${String(ports.broker)}`,
    INGEST_HOST: '127.0.0.1',
    INGEST_PORT: String(ports.ingest),
    HEALTH_PORT: String(ports.health),
    SHUTDOWN_TIMEOUT_MS: String(SHUTDOWN_BUDGET_MS),
    LOG_LEVEL: 'info',
  };
}

afterEach(async () => {
  // A test that fails before its child ends must not leave an ingest process running.
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
  children.length = 0;
  for (const device of devices.splice(0)) device.terminate();
  await Promise.all(
    servers
      .splice(0)
      .filter((server) => server.listening)
      .map((server) => close(server)),
  );
});

describe('ingest process', () => {
  it('answers not ready while the broker is unreachable and while it drains, and exits 0 after the drain', async () => {
    const [broker = 0, ingestPort = 0, health = 0] = await freePorts(3);
    const ingest = startIngest(baseEnv({ broker, ingest: ingestPort, health }));
    await ingest.waitForLog('publisher reconnect scheduled');

    const readyz = `http://127.0.0.1:${String(health)}/readyz`;
    const response = await fetch(readyz);
    // Soft assertions: every outcome of this one process run is reported, even when another fails.
    expect.soft(response.status).toBe(503);
    expect.soft(await response.json()).toEqual({ status: 'not_ready', reason: 'connecting' });

    // A device connected during the outage: its connection is never resumed, so ingest never reads
    // the device's reply to the close frame, and the drain ends at its budget (spec trade-off T28).
    const device = await connectTestDevice({ port: ingestPort });
    devices.push(device);
    await ingest.waitForLog('connection accepted');

    const signalledAt = performance.now();
    ingest.kill('SIGTERM');
    // The child sets its shutting-down flag in the same synchronous run that logs this line, so the
    // flag is set before the line reaches this process; the health server stays up for the drain.
    await ingest.waitForLog('shutting down');
    const duringDrain = await fetch(readyz);
    expect.soft(duringDrain.status).toBe(503);
    expect.soft(await duringDrain.json()).toEqual({ status: 'not_ready', reason: 'shutting_down' });
    const exit = await ingest.closed;
    const lifetimeMs = performance.now() - signalledAt;

    const lines = ingest.lines();
    expect.soft(lines[0]).toMatchObject({ msg: 'ingest starting', RABBITMQ_URL: '[redacted]' });
    expect.soft(JSON.stringify(lines) + ingest.diagnostics()).not.toContain(PLACEHOLDER);
    const afterSignal = lines.slice(lines.findIndex((line) => line.msg === 'shutting down'));
    expect
      .soft(afterSignal.map((line) => line.msg).filter((msg) => SHUTDOWN_LINES.includes(msg)))
      .toEqual(SHUTDOWN_LINES);
    expect
      .soft(lines.find((line) => line.msg === 'shutdown drain ended at its budget'))
      .toMatchObject({ openConnections: 1, unconfirmed: 0 });
    // Alive for the whole drain, then a clean exit.
    expect.soft(lifetimeMs).toBeGreaterThanOrEqual(SHUTDOWN_BUDGET_MS);
    expect.soft(exit).toEqual({ code: 0, signal: null });
  }, 15_000);

  it.each([
    { port: 'HEALTH_PORT', fatal: 'health server failed to listen', host: undefined },
    { port: 'INGEST_PORT', fatal: 'device server failed to listen', host: '127.0.0.1' },
  ] as const)(
    'exits 1 with one fatal line when $port is already in use',
    async ({ port, fatal, host }) => {
      const [broker = 0, ingestPort = 0, health = 0] = await freePorts(3);
      // Bound the way the service binds that port: the health server on every interface, the
      // device server on INGEST_HOST.
      const taken = await listen(net.createServer(), host);
      const env = { ...baseEnv({ broker, ingest: ingestPort, health }), [port]: String(taken) };
      const ingest = startIngest(env);

      const exit = await ingest.closed;

      const fatalLines = ingest.lines().filter((line) => line.level === 60);
      expect(fatalLines).toEqual([expect.objectContaining({ msg: fatal, port: taken })]);
      expect(exit).toEqual({ code: 1, signal: null });
    },
    15_000,
  );
});
