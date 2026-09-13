import { describe, expect, it } from 'vitest';

import { FAILURE_EXIT_CODE, SIGINT_EXIT_CODE, createLifecycleHandlers } from './lifecycle.js';
import { createLogger } from './logger.js';

type LogLine = { msg?: string };

/** Records exits and parsed log lines instead of ending the run, so one test can drive a handler twice. */
function harness(shutdown: () => Promise<void>) {
  const exits: number[] = [];
  const raw: string[] = [];
  const logger = createLogger({
    service: 'test',
    level: 'trace',
    destination: {
      write: (line: string) => {
        raw.push(line);
      },
    },
  });
  const handlers = createLifecycleHandlers({
    logger,
    shutdown,
    exit: (code) => exits.push(code),
  });
  return {
    handlers,
    exits,
    messages: () => raw.map((line) => (JSON.parse(line) as LogLine).msg),
    log: () => raw.join('\n'),
  };
}

describe('createLifecycleHandlers', () => {
  it('drains once on the first signal and exits 0', async () => {
    let drains = 0;
    const { handlers, exits, messages } = harness(() => {
      drains += 1;
      return Promise.resolve();
    });

    handlers.onSignal('SIGTERM');
    await Promise.resolve();
    await Promise.resolve();

    expect(drains).toBe(1);
    expect(exits).toEqual([0]);
    expect(messages()).toEqual(['shutting down', 'stopped']);
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
    const { handlers, exits, messages, log } = harness(() => Promise.resolve());

    handlers.onUnhandledRejection(new Error('boom from a forgotten promise'));

    expect(exits).toEqual([FAILURE_EXIT_CODE]);
    expect(messages()).toEqual(['unhandled rejection']);
    // The reason must reach the log, or the one line explaining a dead container is the one line
    // missing from its log stream — which is the whole point of installing the handler.
    expect(log()).toContain('boom from a forgotten promise');
  });

  it('logs the error and exits non-zero on an uncaught exception', () => {
    const { handlers, exits, messages, log } = harness(() => Promise.resolve());

    handlers.onUncaughtException(new Error('boom from a callback'));

    expect(exits).toEqual([FAILURE_EXIT_CODE]);
    expect(messages()).toEqual(['uncaught exception']);
    expect(log()).toContain('boom from a callback');
  });

  it('exits non-zero when the drain itself rejects', async () => {
    const { handlers, exits, messages, log } = harness(() =>
      Promise.reject(new Error('drain blew up')),
    );

    handlers.onSignal('SIGTERM');
    await Promise.resolve();
    await Promise.resolve();

    expect(exits).toEqual([FAILURE_EXIT_CODE]);
    expect(messages()).toEqual(['shutting down', 'shutdown failed']);
    expect(log()).toContain('drain blew up');
  });
});
