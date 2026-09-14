import { spawn, type ChildProcess } from 'node:child_process';
import net from 'node:net';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

const MAIN = fileURLToPath(new URL('./main.ts', import.meta.url));
const SOURCE_HOOKS = fileURLToPath(new URL('./test-source-hooks.ts', import.meta.url));

/** A credential that must never appear in the process output. Not a secret: a test value. */
const PLACEHOLDER = 'PLACEHOLDER_SECRET';
/** Short: nothing is in flight without a broker, so the drain never needs it. */
const SHUTDOWN_BUDGET_MS = 500;
/** The lines of a shutdown from backoff, in order. */
const SHUTDOWN_LINES = ['shutting down', 'consumer stopping', 'stopped'];

type LogLine = { msg: string; level: number; [field: string]: unknown };
type Exit = { code: number | null; signal: NodeJS.Signals | null };

type ProcessingProcess = {
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

function startProcessing(env: Record<string, string>): ProcessingProcess {
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
                `processing ended (code ${String(code)}) before logging "${msg}":\n${diagnostics}`,
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
  database: number;
  health: number;
}): Record<string, string> {
  return {
    // Nothing listens on the broker or the database port, so every connect attempt is refused.
    RABBITMQ_URL: `amqp://probe:${PLACEHOLDER}@127.0.0.1:${String(ports.broker)}`,
    MONGODB_URL: `mongodb://probe:${PLACEHOLDER}@127.0.0.1:${String(ports.database)}`,
    // Short, so the first store attempt fails within a second (server selection is what bounds it).
    MONGODB_TIMEOUT_MS: '300',
    HEALTH_PORT: String(ports.health),
    SHUTDOWN_TIMEOUT_MS: String(SHUTDOWN_BUDGET_MS),
    LOG_LEVEL: 'info',
  };
}

afterEach(async () => {
  // A test that fails before its child ends must not leave a processing process running.
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
  children.length = 0;
  await Promise.all(
    servers
      .splice(0)
      .filter((server) => server.listening)
      .map((server) => close(server)),
  );
});

describe('processing process', () => {
  it('answers not ready while the database and the broker are unreachable, and exits 0 on SIGTERM', async () => {
    const [broker = 0, database = 0, health = 0] = await freePorts(3);
    const processing = startProcessing(baseEnv({ broker, database, health }));
    await processing.waitForLog('store not ready');
    await processing.waitForLog('consumer reconnect scheduled');

    const response = await fetch(`http://127.0.0.1:${String(health)}/readyz`);
    // Soft assertions: every outcome of this one process run is reported, even when another fails.
    expect.soft(response.status).toBe(503);
    expect.soft(await response.json()).toEqual({ status: 'not_ready', reason: 'mongodb' });

    const signalledAt = performance.now();
    processing.kill('SIGTERM');
    const exit = await processing.closed;
    const lifetimeMs = performance.now() - signalledAt;

    const lines = processing.lines();
    expect.soft(lines[0]).toMatchObject({
      msg: 'processing starting',
      RABBITMQ_URL: '[redacted]',
      MONGODB_URL: '[redacted]',
    });
    expect.soft(JSON.stringify(lines) + processing.diagnostics()).not.toContain(PLACEHOLDER);
    expect.soft(lines.find((line) => line.msg === 'store not ready')).toMatchObject({
      attempt: 0,
      failure: { kind: 'server_selection' },
    });
    const scheduled = lines.find((line) => line.msg === 'consumer reconnect scheduled');
    expect.soft(scheduled).toMatchObject({ reason: 'connect_failed', attempt: 1 });
    // The delay is random by design; a NaN or a negative number from a broken wiring is not.
    expect.soft(scheduled?.['delayMs']).toBeGreaterThan(0);
    const afterSignal = lines.slice(lines.findIndex((line) => line.msg === 'shutting down'));
    expect
      .soft(afterSignal.map((line) => line.msg).filter((msg) => SHUTDOWN_LINES.includes(msg)))
      .toEqual(SHUTDOWN_LINES);
    // The startup loop was aborted: nothing about the store is logged after the signal.
    expect.soft(afterSignal.filter((line) => line.msg === 'store not ready')).toEqual([]);
    expect.soft(exit).toEqual({ code: 0, signal: null });
    expect.soft(lifetimeMs).toBeLessThan(2_000);
  }, 15_000);

  it('exits 1 with one fatal line when HEALTH_PORT is already in use', async () => {
    const [broker = 0, database = 0, health = 0] = await freePorts(3);
    // Bound the way the service binds it: on every interface.
    const taken = await listen(net.createServer());
    const env = { ...baseEnv({ broker, database, health }), HEALTH_PORT: String(taken) };
    const processing = startProcessing(env);

    const exit = await processing.closed;

    const fatalLines = processing.lines().filter((line) => line.level === 60);
    expect(fatalLines).toEqual([
      expect.objectContaining({ msg: 'health server failed to listen', port: taken }),
    ]);
    expect(exit).toEqual({ code: 1, signal: null });
  }, 15_000);
});
