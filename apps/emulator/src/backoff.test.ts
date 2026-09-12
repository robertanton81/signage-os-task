import { describe, expect, it } from 'vitest';

import { BACKOFF_BASE_MS, BACKOFF_MAX_MS, backoffDelay } from './backoff.js';
import type { Random } from './random.js';

/** A Random whose `float()` is fixed, so the delay is a pure function of the attempt. */
function fixedRandom(value: number): Random {
  return {
    float: () => value,
    int: () => 0,
    bool: () => false,
    pick: (values) => values[0],
    range: (min, max) => min + value * (max - min),
  };
}

// Just under 1, the largest value `float()` can return.
const ALMOST_ONE = fixedRandom(0.999_999_999);
const ZERO = fixedRandom(0);

describe('backoffDelay', () => {
  it('never exceeds the cap, at any attempt', () => {
    for (let attempt = 0; attempt <= 50; attempt += 1) {
      expect(backoffDelay(attempt, ALMOST_ONE)).toBeLessThanOrEqual(BACKOFF_MAX_MS);
    }
  });

  it('is never negative, and is zero at the bottom of the jitter window', () => {
    for (let attempt = 0; attempt <= 50; attempt += 1) {
      expect(backoffDelay(attempt, ZERO)).toBe(0);
    }
  });

  it('doubles its ceiling per attempt until the cap', () => {
    expect(backoffDelay(0, ALMOST_ONE)).toBeLessThan(BACKOFF_BASE_MS);
    expect(backoffDelay(1, ALMOST_ONE)).toBeLessThan(BACKOFF_BASE_MS * 2);
    expect(backoffDelay(1, ALMOST_ONE)).toBeGreaterThan(BACKOFF_BASE_MS);
    expect(backoffDelay(4, ALMOST_ONE)).toBeLessThan(BACKOFF_BASE_MS * 16);
    expect(backoffDelay(4, ALMOST_ONE)).toBeGreaterThan(BACKOFF_BASE_MS * 8);
  });

  it('holds at the cap once the ceiling passes it', () => {
    const atCap = backoffDelay(5, ALMOST_ONE);
    expect(atCap).toBeGreaterThan(BACKOFF_MAX_MS * 0.99);
    // Stays saturated however long the outage runs, including past the point where the doubling
    // overflows to Infinity — `Math.min(cap, Infinity)` is still the cap, never NaN.
    expect(backoffDelay(1_000, ALMOST_ONE)).toBeCloseTo(atCap, 5);
    expect(backoffDelay(5_000, ALMOST_ONE)).toBeCloseTo(atCap, 5);
    expect(Number.isFinite(backoffDelay(5_000, ALMOST_ONE))).toBe(true);
  });

  it('depends only on the injected random source', () => {
    expect(backoffDelay(3, ALMOST_ONE)).toBe(backoffDelay(3, ALMOST_ONE));
  });
});
