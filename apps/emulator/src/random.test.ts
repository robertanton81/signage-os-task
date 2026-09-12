import { describe, expect, it } from 'vitest';

import { createRandom, deviceSeed } from './random.js';

const SEED = 12_345;

describe('createRandom', () => {
  it('replays the same stream for the same seed', () => {
    const first = Array.from({ length: 100 }, () => createRandom(SEED).float());
    const a = createRandom(SEED);
    const b = createRandom(SEED);
    expect(Array.from({ length: 100 }, () => a.float())).toEqual(
      Array.from({ length: 100 }, () => b.float()),
    );
    // Each freshly seeded generator starts at the same first value.
    expect(new Set(first).size).toBe(1);
  });

  it('diverges for different seeds within the first few values', () => {
    const a = createRandom(SEED);
    const b = createRandom(SEED + 1);
    const aValues = Array.from({ length: 10 }, () => a.float());
    const bValues = Array.from({ length: 10 }, () => b.float());
    expect(aValues).not.toEqual(bValues);
  });

  it('keeps float() inside [0, 1)', () => {
    const random = createRandom(SEED);
    for (let i = 0; i < 10_000; i += 1) {
      const value = random.float();
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });

  it('keeps int() inside an inclusive range and reaches both endpoints', () => {
    const random = createRandom(SEED);
    const seen = new Set<number>();
    for (let i = 0; i < 10_000; i += 1) {
      const value = random.int(3, 7);
      expect(Number.isInteger(value)).toBe(true);
      expect(value).toBeGreaterThanOrEqual(3);
      expect(value).toBeLessThanOrEqual(7);
      seen.add(value);
    }
    expect(seen).toEqual(new Set([3, 4, 5, 6, 7]));
  });

  it('treats bool(0) and bool(1) as certainties', () => {
    const random = createRandom(SEED);
    for (let i = 0; i < 1_000; i += 1) {
      expect(random.bool(0)).toBe(false);
      expect(random.bool(1)).toBe(true);
    }
  });

  it('picks only elements of the input', () => {
    const random = createRandom(SEED);
    const values = ['a', 'b', 'c'] as const;
    const seen = new Set<string>();
    for (let i = 0; i < 1_000; i += 1) {
      const value = random.pick(values);
      expect(values).toContain(value);
      seen.add(value);
    }
    expect(seen.size).toBe(values.length);
  });

  it('keeps range() inside [min, max) and returns fractional values', () => {
    const random = createRandom(SEED);
    let negative = false;
    let positive = false;
    let fractional = false;
    for (let i = 0; i < 10_000; i += 1) {
      const value = random.range(-1.5, 1.5);
      expect(value).toBeGreaterThanOrEqual(-1.5);
      expect(value).toBeLessThan(1.5);
      negative ||= value < 0;
      positive ||= value > 0;
      // A `range` that delegated to `int` would never produce one of these.
      fractional ||= !Number.isInteger(value);
    }
    expect({ negative, positive, fractional }).toEqual({
      negative: true,
      positive: true,
      fractional: true,
    });
  });

  it('returns the bound itself for a degenerate range', () => {
    const random = createRandom(SEED);
    expect(random.range(2, 2)).toBe(2);
  });

  it('replays the same range() sequence for the same seed', () => {
    const a = createRandom(SEED);
    const b = createRandom(SEED);
    expect(Array.from({ length: 50 }, () => a.range(0, 10))).toEqual(
      Array.from({ length: 50 }, () => b.range(0, 10)),
    );
  });
});

describe('deviceSeed', () => {
  it('gives every device index its own seed', () => {
    const seeds = new Set(Array.from({ length: 100 }, (_unused, index) => deviceSeed(SEED, index)));
    expect(seeds.size).toBe(100);
  });

  it('gives different fleets different seeds for the same device index', () => {
    expect(deviceSeed(1, 0)).not.toBe(deviceSeed(2, 0));
  });
});
