import type { Random } from './random.js';

export const BACKOFF_BASE_MS = 500;
export const BACKOFF_MAX_MS = 10_000;

/**
 * Clamp on the exponent, applied before the multiply. A device that has been unable to reach
 * ingest for hours reaches a high attempt count, and `2 ** 1000` is `Infinity`: without this the
 * ceiling would stop being a number and the delay would become `NaN`.
 */
const MAX_EXPONENT = 31;

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
  const ceiling = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** Math.min(attempt, MAX_EXPONENT));
  return random.range(0, ceiling);
}
