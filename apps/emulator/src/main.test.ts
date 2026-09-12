import { createLogger, type Logger } from '@telemetry/shared';
import { describe, expect, it } from 'vitest';

import { FAILURE_EXIT_CODE, SIGINT_EXIT_CODE, createLifecycleHandlers } from './main.js';

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

/** Records exits instead of ending the run, so one test can drive a handler twice. */
function harness(shutdown: () => Promise<void>) {
  const exits: number[] = [];
  const { logger, lines } = collectingLogger();
  const handlers = createLifecycleHandlers({
    logger,
    shutdown,
    exit: (code) => exits.push(code),
  });
  return { handlers, exits, log: () => lines().join('\n') };
}

describe('createLifecycleHandlers', () => {
  it('drains once on the first signal and exits 0', async () => {
    let drains = 0;
    const { handlers, exits, log } = harness(() => {
      drains += 1;
      return Promise.resolve();
    });

    handlers.onSignal('SIGTERM');
    await Promise.resolve();
    await Promise.resolve();

    expect(drains).toBe(1);
    expect(exits).toEqual([0]);
    expect(log()).toContain('shutting down');
    expect(log()).toContain('emulator stopped');
  });

  it('exits immediately on a second signal instead of draining again', async () => {
    let drains = 0;
    // A drain that never settles, so the second signal lands while the first is still running.
    const { handlers, exits } = harness(() => {
      drains += 1;
      return new Promise<void>(() => undefined);
    });

    handlers.onSignal('SIGTERM');
    handlers.onSignal('SIGINT');
    await Promise.resolve();

    expect(drains).toBe(1);
    expect(exits).toEqual([SIGINT_EXIT_CODE]);
  });

  it('logs the reason and exits non-zero on an unhandled rejection', () => {
    const { handlers, exits, log } = harness(() => Promise.resolve());

    handlers.onUnhandledRejection(new Error('boom from a forgotten promise'));

    expect(exits).toEqual([FAILURE_EXIT_CODE]);
    expect(log()).toContain('unhandled rejection');
    // The reason must reach the log, or the one line explaining a dead container is the one line
    // missing from its log stream — which is the whole point of installing the handler.
    expect(log()).toContain('boom from a forgotten promise');
  });

  it('logs the error and exits non-zero on an uncaught exception', () => {
    const { handlers, exits, log } = harness(() => Promise.resolve());

    handlers.onUncaughtException(new Error('boom from a callback'));

    expect(exits).toEqual([FAILURE_EXIT_CODE]);
    expect(log()).toContain('uncaught exception');
    expect(log()).toContain('boom from a callback');
  });

  it('exits non-zero when the drain itself rejects', async () => {
    const { handlers, exits, log } = harness(() => Promise.reject(new Error('drain blew up')));

    handlers.onSignal('SIGTERM');
    await Promise.resolve();
    await Promise.resolve();

    expect(exits).toEqual([FAILURE_EXIT_CODE]);
    expect(log()).toContain('shutdown failed');
    expect(log()).toContain('drain blew up');
  });
});
