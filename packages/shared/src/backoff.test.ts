import { describe, expect, it } from 'vitest';

import { backoffDelay } from './backoff.js';

// The reconnect schedule both services use: 500 ms doubling up to 10 s (consistency spec, decision 14).
const BASE_MS = 500;
const MAX_MS = 10_000;

/** Just under 1, the largest value a `[0, 1)` source can return. */
const ALMOST_ONE = (): number => 0.999_999_999;
const ZERO = (): number => 0;

function delay(attempt: number, random: () => number): number {
  return backoffDelay({ attempt, baseMs: BASE_MS, maxMs: MAX_MS, random });
}

describe('backoffDelay', () => {
  it('never exceeds the cap, at any attempt', () => {
    for (let attempt = 0; attempt <= 50; attempt += 1) {
      expect(delay(attempt, ALMOST_ONE)).toBeLessThanOrEqual(MAX_MS);
    }
  });

  it('is never negative, and is zero at the bottom of the jitter window', () => {
    for (let attempt = 0; attempt <= 50; attempt += 1) {
      expect(delay(attempt, ZERO)).toBe(0);
    }
  });

  it('doubles its ceiling per attempt until the cap', () => {
    expect(delay(0, ALMOST_ONE)).toBeLessThan(BASE_MS);
    expect(delay(1, ALMOST_ONE)).toBeLessThan(BASE_MS * 2);
    expect(delay(1, ALMOST_ONE)).toBeGreaterThan(BASE_MS);
    expect(delay(4, ALMOST_ONE)).toBeLessThan(BASE_MS * 16);
    expect(delay(4, ALMOST_ONE)).toBeGreaterThan(BASE_MS * 8);
  });

  it('holds at the cap once the ceiling passes it', () => {
    const atCap = delay(5, ALMOST_ONE);
    expect(atCap).toBeGreaterThan(MAX_MS * 0.99);
    // Stays saturated however long the outage runs, including past the point where the doubling
    // overflows to Infinity — `Math.min(cap, Infinity)` is still the cap, never NaN.
    expect(delay(1_000, ALMOST_ONE)).toBeCloseTo(atCap, 5);
    expect(delay(5_000, ALMOST_ONE)).toBeCloseTo(atCap, 5);
    expect(Number.isFinite(delay(5_000, ALMOST_ONE))).toBe(true);
  });

  it('is the injected random value times the ceiling, so one draw decides the delay', () => {
    // The emulator replays a whole run from one seed, so the helper must consume exactly one draw
    // and scale it linearly: 0.25 of the attempt-3 ceiling (4 000 ms), half of the capped ceiling.
    expect(delay(3, () => 0.25)).toBe(1_000);
    expect(delay(10, () => 0.5)).toBe(5_000);
  });
});
