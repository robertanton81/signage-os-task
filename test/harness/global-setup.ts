// TypeScript adds an augmented module to the program only when some file imports it; this
// type-only import keeps the `declare module 'vitest'` below valid before any test file exists.
import type {} from 'vitest';
import type { TestProject } from 'vitest/node';

import { SERVICES, compose, composeInherit, parseComposeConfig, type TestStack } from './stack.js';

declare module 'vitest' {
  export interface ProvidedContext {
    stack: TestStack;
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
  const running = (await compose(['ps', '--services', '--status', 'running'])).trim();
  const owned = running.split('\n').filter(Boolean).length < SERVICES.length;
  const teardown = async (): Promise<void> => {
    if (owned) {
      await composeInherit(['down', '-v']);
    }
  };
  try {
    await composeInherit(['up', '-d', '--wait', '--wait-timeout', '120']);
    project.provide('stack', parseComposeConfig(await compose(['config', '--format', 'json'])));
  } catch (error) {
    // A stack this run started must not outlive a failure of the steps after the `up`; the
    // original error is the one reported, and a teardown that fails too is named next to it.
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
