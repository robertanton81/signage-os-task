import { describe, expect, it } from 'vitest';

import {
  createProfile,
  deriveState,
  initialWalk,
  stepWalk,
  DEGRADED_CPU_PERCENT,
  DEGRADED_TEMPERATURE_C,
  OVERHEAT_TEMPERATURE_C,
  RECOVERED_CPU_PERCENT,
  RECOVERED_TEMPERATURE_C,
  TEMPERATURE_MAX_C,
  TEMPERATURE_MIN_C,
  type WalkState,
} from './generator.js';
import { createRandom, deviceSeed } from './random.js';

const SEED = 4_242;

function walkFor(
  seed: number,
  steps: number,
): { profile: ReturnType<typeof createProfile>; samples: WalkState[] } {
  const random = createRandom(seed);
  const profile = createProfile(random);
  let state = initialWalk(profile);
  const samples: WalkState[] = [state];
  for (let i = 0; i < steps; i += 1) {
    state = stepWalk(state, { profile, random });
    samples.push(state);
  }
  return { profile, samples };
}

/** The first healthy and the first faulty device index under one fleet seed. */
function findProfiles(): { healthy: number; faulty: number } {
  let healthy = -1;
  let faulty = -1;
  for (let index = 0; index < 50; index += 1) {
    const profile = createProfile(createRandom(deviceSeed(SEED, index)));
    if (profile.faulty && faulty === -1) faulty = index;
    if (!profile.faulty && healthy === -1) healthy = index;
  }
  return { healthy, faulty };
}

describe('stepWalk', () => {
  it('keeps every value inside its clamp over 10 000 steps', () => {
    for (const index of [0, 1, 2, 3, 4]) {
      const { samples } = walkFor(deviceSeed(SEED, index), 10_000);
      for (const sample of samples) {
        expect(sample.temperatureC).toBeGreaterThanOrEqual(TEMPERATURE_MIN_C);
        expect(sample.temperatureC).toBeLessThanOrEqual(TEMPERATURE_MAX_C);
        expect(sample.cpuPercent).toBeGreaterThanOrEqual(0);
        expect(sample.cpuPercent).toBeLessThanOrEqual(100);
        expect(sample.ramPercent).toBeGreaterThanOrEqual(0);
        expect(sample.ramPercent).toBeLessThanOrEqual(100);
      }
    }
  });

  it('actually moves rather than repeating one value', () => {
    const { samples } = walkFor(SEED, 100);
    expect(new Set(samples.map((s) => s.temperatureC)).size).toBeGreaterThan(1);
    expect(new Set(samples.map((s) => s.cpuPercent)).size).toBeGreaterThan(1);
    expect(new Set(samples.map((s) => s.ramPercent)).size).toBeGreaterThan(1);
  });

  it('stays near its baseline, which is what the pull term is for', () => {
    const { profile, samples } = walkFor(SEED, 10_000);
    const mean = samples.reduce((sum, s) => sum + s.temperatureC, 0) / samples.length;
    expect(Math.abs(mean - profile.baseline.temperatureC)).toBeLessThan(5);
  });

  it('rounds every value to at most two decimals', () => {
    const { samples } = walkFor(SEED, 500);
    for (const sample of samples) {
      for (const value of [sample.temperatureC, sample.cpuPercent, sample.ramPercent]) {
        expect(Math.round(value * 100)).toBeCloseTo(value * 100, 6);
      }
    }
  });
});

describe('createProfile', () => {
  it('produces both healthy and faulty devices across a fleet', () => {
    const { healthy, faulty } = findProfiles();
    expect(healthy).toBeGreaterThanOrEqual(0);
    expect(faulty).toBeGreaterThanOrEqual(0);
  });

  it('lets a faulty device overheat and never lets a healthy one', () => {
    const { healthy, faulty } = findProfiles();
    const faultySamples = walkFor(deviceSeed(SEED, faulty), 10_000).samples;
    const healthySamples = walkFor(deviceSeed(SEED, healthy), 10_000).samples;
    expect(faultySamples.some((s) => s.temperatureC > OVERHEAT_TEMPERATURE_C)).toBe(true);
    expect(healthySamples.some((s) => s.temperatureC > DEGRADED_TEMPERATURE_C)).toBe(false);
  });

  it('makes a faulty device cross the overheat threshold repeatedly, not once', () => {
    // An error diagnostic is emitted on the TRANSITION into overheat, so a faulty device whose
    // baseline merely sits near the threshold without crossing it produces one alert and then
    // nothing. The walk's measured spread is only about 2 degrees, so this is the assertion that
    // pins the faulty baseline band to a range that actually straddles the threshold.
    const { faulty } = findProfiles();
    const samples = walkFor(deviceSeed(SEED, faulty), 10_000).samples;
    let crossings = 0;
    for (let i = 1; i < samples.length; i += 1) {
      const was = (samples[i - 1]?.temperatureC ?? 0) > OVERHEAT_TEMPERATURE_C;
      const is = (samples[i]?.temperatureC ?? 0) > OVERHEAT_TEMPERATURE_C;
      if (was !== is) crossings += 1;
    }
    expect(crossings).toBeGreaterThan(100);
  });
});

describe('deriveState', () => {
  const base: WalkState = { temperatureC: 40, cpuPercent: 10, ramPercent: 50 };

  it('degrades above the cpu threshold and recovers only below the lower one', () => {
    expect(deriveState({ ...base, cpuPercent: DEGRADED_CPU_PERCENT + 1 }, 'online')).toBe(
      'degraded',
    );
    expect(deriveState({ ...base, cpuPercent: RECOVERED_CPU_PERCENT + 2 }, 'degraded')).toBe(
      'degraded',
    );
    expect(deriveState({ ...base, cpuPercent: RECOVERED_CPU_PERCENT - 1 }, 'degraded')).toBe(
      'online',
    );
  });

  it('degrades above the temperature threshold and recovers only below the lower one', () => {
    expect(deriveState({ ...base, temperatureC: DEGRADED_TEMPERATURE_C + 1 }, 'online')).toBe(
      'degraded',
    );
    expect(deriveState({ ...base, temperatureC: RECOVERED_TEMPERATURE_C + 2 }, 'degraded')).toBe(
      'degraded',
    );
    expect(deriveState({ ...base, temperatureC: RECOVERED_TEMPERATURE_C - 1 }, 'degraded')).toBe(
      'online',
    );
  });

  it('stays online in the ordinary range', () => {
    expect(deriveState(base, 'online')).toBe('online');
  });
});
