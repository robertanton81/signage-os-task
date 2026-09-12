import type { Random } from './random.js';

export const BACKOFF_BASE_MS = 500;
export const BACKOFF_MAX_MS = 10_000;

/**
 * Full Jitter: uniform in `[0, min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** attempt))`.
 *
 * `attempt` is 0-based and resets on a successful connect. Full Jitter rather than Equal Jitter
 * because it is what the AWS IoT Device SDK's `backoffAlgorithm` uses for this exact case — a
 * fleet of devices reconnecting to one server — and it spreads a fleet best after an ingest
 * restart. Named consequence: the first retry can be almost immediate.
 *
 * Pure, and the random source is an argument, so the whole delay schedule is unit-tested without
 * waiting ten seconds for it.
 */
export function backoffDelay(attempt: number, random: Random): number {
  // No clamp on the exponent is needed: past about 2 ** 1024 the product becomes `Infinity`, and
  // `Math.min(BACKOFF_MAX_MS, Infinity)` is still `BACKOFF_MAX_MS`. An earlier version clamped it
  // and claimed to prevent a `NaN`, which it never could — dead code with a wrong reason attached.
  const ceiling = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** attempt);
  return random.range(0, ceiling);
}
