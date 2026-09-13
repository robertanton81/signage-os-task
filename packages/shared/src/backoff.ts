export type BackoffInput = {
  /** 0-based retry number. */
  attempt: number;
  /** Ceiling of the first retry, milliseconds. */
  baseMs: number;
  /** Largest ceiling, milliseconds. */
  maxMs: number;
  /** Returns a number in `[0, 1)`, like `Math.random`. */
  random: () => number;
};

/**
 * Full Jitter: uniform in `[0, min(maxMs, baseMs * 2 ** attempt))`.
 *
 * Full Jitter rather than Equal Jitter because it spreads a fleet of clients best when the server
 * they all lost comes back — it is what the AWS IoT Device SDK's `backoffAlgorithm` uses for a
 * fleet of devices reconnecting to one server. Named consequence: the first retry can be almost
 * immediate.
 *
 * Pure, and the random source is an argument: a whole delay schedule is unit-tested without
 * waiting for it, and the emulator passes its seeded generator, so a run still replays from its
 * seed. Each call consumes exactly one draw. Used by the emulator's device connection and by the
 * ingest publisher (ingest spec, decision 20).
 */
export function backoffDelay({ attempt, baseMs, maxMs, random }: BackoffInput): number {
  // No clamp on the exponent is needed: past about 2 ** 1024 the product becomes `Infinity`, and
  // `Math.min(maxMs, Infinity)` is still `maxMs`. An earlier version clamped it and claimed to
  // prevent a `NaN`, which it never could — dead code with a wrong reason attached.
  return random() * Math.min(maxMs, baseMs * 2 ** attempt);
}
