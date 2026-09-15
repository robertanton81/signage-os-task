import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { startTestSink } from './test-sink.js';

const MAIN = fileURLToPath(new URL('./main.ts', import.meta.url));
const SOURCE_HOOKS = fileURLToPath(new URL('./test-source-hooks.ts', import.meta.url));

/** Short enough to keep the test quick, yet far above the few milliseconds a shutdown that skipped its own drain would take. */
const SHUTDOWN_BUDGET_MS = 500;
const LOSS_WARNING = 'shutdown timed out with messages still queued';
/** A shutdown that could not deliver: drain step 4, the final summary, the lifecycle's last line. */
const SHUTDOWN_LINES = ['shutting down', LOSS_WARNING, 'emulator fleet summary', 'stopped'];

type LogLine = { msg: string; [field: string]: unknown };
type Exit = { code: number | null; signal: NodeJS.Signals | null };

type EmulatorProcess = {
  /** Every JSON line the child wrote to stdout, in order. */
  lines: () => LogLine[];
  /** Resolves once a line with this `msg` arrives; rejects with the diagnostics if the child ends first. */
  waitForLog: (msg: string) => Promise<void>;
  /** Resolves on 'close': the process has ended and its stdout has been read to the end. */
  closed: Promise<Exit>;
  kill: (signal: NodeJS.Signals) => void;
};

const children: ChildProcess[] = [];

function startEmulator(env: Record<string, string>): EmulatorProcess {
  // The real entry point, from its sources (see `test-source-hooks.ts` for the flag). A passed
  // `env` replaces the parent's environment (Node child_process docs), so the child sees only the
  // variables set here, nothing from the test runner; every other one has a default.
  const child = spawn(
    process.execPath,
    ['--experimental-transform-types', '--import', SOURCE_HOOKS, MAIN],
    { env, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  children.push(child);

  const lines: LogLine[] = [];
  const listeners = new Set<() => void>();
  let pending = '';
  // What explains a failed start or a strange run: the child's stderr, a stdout line that is not
  // JSON, and a spawn error. `waitForLog` puts it into its rejection.
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
        // A throw here would escape the stream handler as an uncaught exception and hide the
        // cause. The logger writes JSON only, so such a line is itself the diagnosis.
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
  // Without a listener, a failed spawn (EAGAIN, EMFILE) would throw as an uncaught exception.
  // Node emits 'close' after it as well, so `waitForLog` rejects with this text.
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
                `the emulator ended (code ${String(code)}) before logging "${msg}":\n${diagnostics}`,
              ),
            );
          }
        });
      }),
    closed,
    kill: (signal) => {
      child.kill(signal);
    },
  };
}

/** A port that refuses connections: bound by a sink, then released. */
async function refusedPort(): Promise<number> {
  const temporary = await startTestSink();
  await temporary.close();
  return temporary.port;
}

afterEach(() => {
  // A test that fails before its child ends must not leave an emulator running.
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
  children.length = 0;
});

describe('emulator process', () => {
  it('reports what it could not deliver before it exits, when ingest stays unreachable', async () => {
    // A separate process on purpose: what keeps Node running is exactly what is under test here,
    // and vitest's own runner keeps a worker alive through its own handles — which would mask a
    // real process exiting right after SIGTERM with no loss warning, no summary, exit code 0.
    const port = await refusedPort();
    const emulator = startEmulator({
      INGEST_HOSTS: `127.0.0.1:${String(port)}`,
      EMULATOR_DEVICE_COUNT: '1',
      // Stated, not left to the default: the seed fixes the device's random draws, reconnect delays
      // included.
      EMULATOR_SEED: '1',
      SHUTDOWN_TIMEOUT_MS: String(SHUTDOWN_BUDGET_MS),
      LOG_LEVEL: 'info',
    });
    // Every connect is refused, so from here the device waits in backoff: no socket is open, and
    // its only timer is the unreferenced reconnect timer.
    await emulator.waitForLog('device socket closed, reconnecting');

    const signalledAt = performance.now();
    emulator.kill('SIGTERM');
    const exit = await emulator.closed;
    const lifetimeMs = performance.now() - signalledAt;

    const lines = emulator.lines();
    const afterSignal = lines.slice(lines.findIndex((line) => line.msg === 'shutting down'));
    expect(
      afterSignal.map((line) => line.msg).filter((msg) => SHUTDOWN_LINES.includes(msg)),
    ).toEqual(SHUTDOWN_LINES);
    // The warning names the device and what it still held: at least the session-start status and
    // the farewell.
    const warning = lines.find((line) => line.msg === LOSS_WARNING);
    expect(warning).toMatchObject({ deviceId: 'dev-0001' });
    expect(warning?.remaining).toBeGreaterThanOrEqual(2);
    expect(lifetimeMs).toBeGreaterThanOrEqual(SHUTDOWN_BUDGET_MS);
    expect(exit).toEqual({ code: 0, signal: null });
  }, 15_000);
});
