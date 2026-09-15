// TypeScript adds an augmented module to the program only when some file imports it; this
// type-only import keeps the `declare module 'vitest'` below valid before any test file exists.
import type {} from 'vitest';
import type { TestProject } from 'vitest/node';

import {
  SERVICES,
  compose,
  composeInherit,
  parseComposeConfig,
  servicesWithStatus,
  type TestStack,
} from './stack.js';

declare module 'vitest' {
  export interface ProvidedContext {
    stack: TestStack;
  }
}

/**
 * The deadlines of the two Compose commands (`runInherited`): Vitest bounds no global setup. The
 * `up`: on the first run Docker pulls both images (1.2 GB on disk together, measured) before the
 * 120 s health wait starts, which a slow connection stretches to minutes; 3 s with the images
 * present. The `down -v`: a container stop waits Docker's 10 s grace at most; 2 s measured.
 */
const STACK_UP_TIMEOUT_MS = 600_000;
const STACK_DOWN_TIMEOUT_MS = 120_000;
/** `logs` reads what Docker holds and returns; measured under a second, bounded like the rest. */
const STACK_LOGS_TIMEOUT_MS = 30_000;

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The containers' last lines, to the inherited terminal, before the teardown removes them: a
 * service that exits during the `--wait` is otherwise a bare `exited (1)` in the CI log, with the
 * reason gone with the container (RabbitMQ on the GitHub runner, 2026-09-15). Diagnostic only, so
 * a `logs` that fails is not allowed to hide the error that led here.
 */
async function printStackLogs(): Promise<void> {
  try {
    await composeInherit(['logs', '--no-color', '--tail', '200'], {
      timeoutMs: STACK_LOGS_TIMEOUT_MS,
    });
  } catch {
    // The original error is the one reported; a `logs` that failed adds nothing to it.
  }
}

/**
 * Starts the test stack before the first integration file and removes it after the last one
 * (integration spec, decision 5). Vitest calls this only when at least one integration test is
 * queued, so `pnpm test:unit` and the per-package scoped verify never touch Docker.
 *
 * Ownership rule: this run removes the stack only when it found it not already fully running
 * (none, or one service left behind by a crashed run). A developer who started the stack by hand
 * keeps it; a partial leftover counts as owned and goes away with what this run added.
 */
export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const running = await servicesWithStatus('running');
  const owned = running.length < SERVICES.length;
  const teardown = async (): Promise<void> => {
    if (owned) {
      await composeInherit(['down', '-v'], { timeoutMs: STACK_DOWN_TIMEOUT_MS });
    }
  };
  try {
    await composeInherit(['up', '-d', '--wait', '--wait-timeout', '120'], {
      timeoutMs: STACK_UP_TIMEOUT_MS,
    });
    project.provide('stack', parseComposeConfig(await compose(['config', '--format', 'json'])));
  } catch (error) {
    // A stack this run started must not outlive a failure of the steps after the `up`; the
    // original error is the one reported, and a teardown that fails too is named next to it.
    await printStackLogs();
    try {
      await teardown();
    } catch (teardownError) {
      throw new Error(`${messageOf(error)}; the teardown failed too: ${messageOf(teardownError)}`, {
        cause: teardownError,
      });
    }
    throw error;
  }
  return teardown;
}
