/**
 * A seeded pseudo-random source. Every draw the emulator makes — the per-device baselines, the
 * walk's noise, the chaos decisions, the reconnect jitter, the tick phase — comes from one of
 * these, so a whole run replays identically from `EMULATOR_SEED` (design spec, decision 4).
 *
 * Deliberately not `Math.random()` (a flaky integration test could never be replayed) and not
 * `crypto.randomInt` (not seedable, and cryptographic strength is meaningless for a temperature
 * reading).
 */
export type Random = {
  /** Uniform in [0, 1). */
  float(): number;
  /** Uniform integer in [min, max], both inclusive. */
  int(min: number, max: number): number;
  /** True with the given probability in [0, 1]. */
  bool(probability: number): boolean;
  /** Uniform element of a non-empty array. */
  pick<T>(values: readonly [T, ...T[]]): T;
  /** Uniform in [min, max). Continuous: the walk's noise is fractional, so `int` cannot serve. */
  range(min: number, max: number): number;
};

/**
 * mulberry32. Chosen over a dependency because it is six lines, and over a larger generator
 * because nothing here needs more than a well-distributed 32-bit stream. Every operation is on a
 * `>>> 0` integer, so the sequence is identical on every platform — which is what makes a seed a
 * reproduction recipe rather than a hint.
 */
export function createRandom(seed: number): Random {
  let state = seed >>> 0;

  const float = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };

  return {
    float,
    int: (min, max) => min + Math.floor(float() * (max - min + 1)),
    // `<` not `<=`: `bool(0)` must be certain, and `float()` can return exactly 0.
    bool: (probability) => float() < probability,
    pick: (values) => {
      const index = Math.floor(float() * values.length);
      // `at` plus a fallback, never a non-null assertion (lint forbids it): under
      // `noUncheckedIndexedAccess` a COMPUTED index into the rest element of `[T, ...T[]]` is
      // still `T | undefined`, even though the tuple type guarantees element 0 exists. The
      // fallback is unreachable for an in-range index and costs one `??`.
      return values.at(index) ?? values[0];
    },
    range: (min, max) => min + float() * (max - min),
  };
}

/**
 * One device's seed, derived from the fleet seed and the device's index. Mixing rather than
 * adding: `deviceSeed(1, 2)` and `deviceSeed(2, 1)` must not collide, or two fleets would share
 * a device's whole behaviour. The constants are the golden-ratio and xxHash mixers.
 */
export function deviceSeed(fleetSeed: number, deviceIndex: number): number {
  const mixed = Math.imul(fleetSeed ^ 0x9e3779b9, 0x85eb_ca6b);
  return (mixed + deviceIndex) >>> 0;
}
