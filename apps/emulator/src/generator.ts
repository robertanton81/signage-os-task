import type { MetricsPayload } from '@telemetry/shared';

import type { Random } from './random.js';

/**
 * Share of devices seeded as running hot. Without them the walk almost never reaches the overheat
 * threshold and a demo run produces no alert at all; with every device faulty the alert
 * collection is noise. A named constant rather than an environment variable: it is a property of
 * the simulated fleet, not something an operator tunes (design spec, decision 9).
 */
export const FAULTY_DEVICE_PROBABILITY = 0.1;

export const DEGRADED_CPU_PERCENT = 90;
export const DEGRADED_TEMPERATURE_C = 75;
/** Lower than the degraded thresholds on purpose: hysteresis, so a value sitting on the line
 * does not flap the status back and forth and produce a status message every tick. */
export const RECOVERED_CPU_PERCENT = 85;
export const RECOVERED_TEMPERATURE_C = 70;
export const OVERHEAT_TEMPERATURE_C = 85;

export const COUNTERS_EVERY_N_TICKS = 5;
export const INFO_DIAGNOSTIC_PROBABILITY = 0.02;
export const INFO_DIAGNOSTIC_CODES = ['E_CONFIG_RELOAD', 'E_NET_RETRY', 'E_CACHE_EVICT'] as const;

export const TEMPERATURE_MIN_C = 15;
export const TEMPERATURE_MAX_C = 95;

/** How strongly each step is pulled back toward the baseline. */
const PULL = 0.1;

const HEALTHY_TEMPERATURE_BASELINE = { min: 32, max: 48 } as const;
/**
 * Straddles `OVERHEAT_TEMPERATURE_C` on purpose. The walk's stationary spread is small — measured
 * standard deviation 1.98 °C, largest excursion 7.5 °C over 20 000 ticks — so a baseline that
 * merely *looks* hot does not actually cross the threshold: from 70–80 a faulty device crossed
 * 85 °C roughly once in 222 ticks at the very top of the band and never at the bottom, which
 * meant no alerts in a demo run. From 82–88 it crosses every 6 to 21 ticks depending on where in
 * the band it was drawn, which is one error diagnostic every few seconds per faulty device at the
 * default tick — visible without flooding the alert collection.
 */
const FAULTY_TEMPERATURE_BASELINE = { min: 82, max: 88 } as const;
const CPU_BASELINE = { min: 5, max: 40 } as const;
const RAM_BASELINE = { min: 20, max: 70 } as const;

const TEMPERATURE_STEP = 1.5;
const CPU_STEP = 8;
const RAM_STEP = 4;

export type DeviceState = 'online' | 'degraded';
export type DeviceProfile = { faulty: boolean; baseline: MetricsPayload };
/** The walk's state is exactly the payload it produces — no separate representation to drift. */
export type WalkState = MetricsPayload;

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

type Bounds = { min: number; max: number };

function clamp(value: number, bounds: Bounds): number {
  return Math.min(bounds.max, Math.max(bounds.min, value));
}

const TEMPERATURE_BOUNDS: Bounds = { min: TEMPERATURE_MIN_C, max: TEMPERATURE_MAX_C };
const PERCENT_BOUNDS: Bounds = { min: 0, max: 100 };

/**
 * One field's next value. A single parameter object rather than five positional arguments, which
 * is the repo's rule at three or more (shared-contract spec, decision 14) and what `max-params`
 * enforces.
 */
function nextValue(input: {
  current: number;
  baseline: number;
  step: number;
  bounds: Bounds;
  random: Random;
}): number {
  const { current, baseline, step, bounds, random } = input;
  const moved = current + PULL * (baseline - current) + random.range(-step, step);
  return round2(clamp(moved, bounds));
}

/** Drawn once per device, from its own seeded stream. */
export function createProfile(random: Random): DeviceProfile {
  const faulty = random.bool(FAULTY_DEVICE_PROBABILITY);
  const temperature = faulty ? FAULTY_TEMPERATURE_BASELINE : HEALTHY_TEMPERATURE_BASELINE;
  return {
    faulty,
    baseline: {
      temperatureC: round2(random.range(temperature.min, temperature.max)),
      cpuPercent: round2(random.range(CPU_BASELINE.min, CPU_BASELINE.max)),
      ramPercent: round2(random.range(RAM_BASELINE.min, RAM_BASELINE.max)),
    },
  };
}

export function initialWalk(profile: DeviceProfile): WalkState {
  return { ...profile.baseline };
}

/**
 * One step of a bounded random walk, pulled back toward the baseline.
 *
 * The pull term is what makes this useful rather than decorative: a free random walk drifts into
 * a clamp and sits there, and then every later reading looks the same, which would make a stale
 * overwrite invisible. With the pull, a value that jumps backwards is visibly wrong.
 *
 * Rounding happens here rather than on the way out, so the stored state and the emitted payload
 * are the same numbers and the walk cannot drift away from what was reported.
 */
export function stepWalk(
  state: WalkState,
  context: { profile: DeviceProfile; random: Random },
): WalkState {
  const { profile, random } = context;
  return {
    temperatureC: nextValue({
      current: state.temperatureC,
      baseline: profile.baseline.temperatureC,
      step: TEMPERATURE_STEP,
      bounds: TEMPERATURE_BOUNDS,
      random,
    }),
    cpuPercent: nextValue({
      current: state.cpuPercent,
      baseline: profile.baseline.cpuPercent,
      step: CPU_STEP,
      bounds: PERCENT_BOUNDS,
      random,
    }),
    ramPercent: nextValue({
      current: state.ramPercent,
      baseline: profile.baseline.ramPercent,
      step: RAM_STEP,
      bounds: PERCENT_BOUNDS,
      random,
    }),
  };
}

/**
 * The device's operational state, derived from its own metrics so that an alert has a visible
 * cause in the stored readings. `offline` is never derived — a device that has died does not send
 * anything, and a reader infers that from `lastEvent.receivedAt` instead.
 */
export function deriveState(walk: WalkState, previous: DeviceState): DeviceState {
  if (walk.cpuPercent > DEGRADED_CPU_PERCENT || walk.temperatureC > DEGRADED_TEMPERATURE_C) {
    return 'degraded';
  }
  if (
    previous === 'degraded' &&
    (walk.cpuPercent > RECOVERED_CPU_PERCENT || walk.temperatureC > RECOVERED_TEMPERATURE_C)
  ) {
    return 'degraded';
  }
  return 'online';
}
