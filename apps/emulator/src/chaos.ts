import { TIMER_MAX_MS, type TelemetryMessage } from '@telemetry/shared';

import type { Random } from './random.js';

export const CHAOS_MODES = ['duplicate', 'out-of-order', 'disconnect', 'restart'] as const;

/** A connection chaos delay is drawn uniformly in `[(1 - spread) × interval, (1 + spread) × interval]`. */
export const CHAOS_INTERVAL_SPREAD = 0.5;

/**
 * Largest `EMULATOR_CHAOS_INTERVAL_MS` whose longest possible draw still fits a Node timer: above
 * TIMER_MAX_MS a `setTimeout` fires after 1 ms (shared `TIMER_MAX_MS`), and the draw, not the
 * configured value, is what becomes the delay.
 */
export const CHAOS_INTERVAL_MAX_MS = Math.floor(TIMER_MAX_MS / (1 + CHAOS_INTERVAL_SPREAD));
export type ChaosMode = (typeof CHAOS_MODES)[number];
/** Derived rather than written out, so it cannot drift from CHAOS_MODES. */
export type ConnectionChaosMode = Extract<ChaosMode, 'disconnect' | 'restart'>;

const CONNECTION_CHAOS_MODES = ['disconnect', 'restart'] as const satisfies readonly ChaosMode[];

/**
 * A parser that reports rather than throws.
 *
 * This shape is not stylistic. These parsers run inside a zod `.transform()`, and a `throw` there
 * escapes `safeParse` entirely instead of becoming an issue — it would bypass `ConfigError`, lose
 * the variable name, and could print the rejected value. Returning a result lets the schema call
 * `ctx.addIssue`, which carries the variable name as the issue path.
 */
export type ParseResult<T> = { ok: true; value: T } | { ok: false; message: string };

function isChaosMode(value: string): value is ChaosMode {
  return CHAOS_MODES.some((mode) => mode === value);
}

/** Trims each entry, drops empties, collapses repeats. An unknown name fails the whole parse. */
export function parseChaosModes(raw: string): ParseResult<ChaosMode[]> {
  const modes = new Set<ChaosMode>();
  for (const entry of raw.split(',').map((part) => part.trim())) {
    if (entry === '') continue;
    if (!isChaosMode(entry)) {
      // A typo must fail loudly: running with chaos silently disabled while the operator believes
      // it is on wastes a whole debugging session. The message names the valid modes but never
      // repeats what was received.
      return {
        ok: false,
        message: `must be a comma-separated subset of: ${CHAOS_MODES.join(', ')}`,
      };
    }
    modes.add(entry);
  }
  return { ok: true, value: [...modes] };
}

export type ChaosPolicyOptions = {
  modes: readonly ChaosMode[];
  percent: number;
  intervalMs: number;
  random: Random;
};

/**
 * Chaos as a WIRE-LEVEL policy, applied to a message on its way from the generator to the outbox.
 *
 * This placement is the load-bearing decision of the emulator's design. Letting a chaos mode
 * reuse or decrement a `seq` would break the contract invariant the whole storage design rests on
 * (consistency spec, decision 28), and every duplicate would become ambiguous: the pipeline could
 * not tell "the same event arrived twice" from "two different events claim one identity", and the
 * second case has no correct answer. Here, a duplicate is the same event sent twice and a swap is
 * the same two events written in the other order — exactly the hazards at-least-once delivery
 * produces in reality.
 */
export class ChaosPolicy {
  readonly #modes: ReadonlySet<ChaosMode>;
  readonly #probability: number;
  readonly #intervalMs: number;
  readonly #random: Random;
  #held: TelemetryMessage[] | null = null;

  constructor(options: ChaosPolicyOptions) {
    this.#modes = new Set(options.modes);
    this.#probability = options.percent / 100;
    this.#intervalMs = options.intervalMs;
    this.#random = options.random;
  }

  /**
   * What to enqueue now, in order.
   *
   * A message already held is always released here, behind `emit` — so the reordering depth is
   * always exactly one, and since this runs on every tick, a held message can never be stranded.
   * `flushHeld` exists only for the two cases with no next tick: a deliberate disconnect, and
   * shutdown.
   */
  apply(message: TelemetryMessage): TelemetryMessage[] {
    const emit = this.#fires('duplicate') ? [message, message] : [message];

    const held = this.#held;
    if (held !== null) {
      this.#held = null;
      return [...emit, ...held];
    }

    if (this.#fires('out-of-order')) {
      this.#held = emit;
      return [];
    }

    return emit;
  }

  /** Releases the hold slot. Callers push the result straight to the outbox, never back through `apply`. */
  flushHeld(): TelemetryMessage[] {
    const held = this.#held ?? [];
    this.#held = null;
    return held;
  }

  /** Drops the hold slot: a power cycle loses whatever was in RAM. */
  clearHeld(): void {
    this.#held = null;
  }

  /**
   * When the next connection-level chaos event fires, and which one. Null when neither
   * `disconnect` nor `restart` is enabled. The delay is drawn uniformly in [0.5x, 1.5x] of the
   * configured interval, from the device's own seeded stream, so the schedule replays with the
   * seed and a test can drive it without waiting a minute.
   */
  nextConnectionChaos(): { mode: ConnectionChaosMode; delayMs: number } | null {
    const enabled = CONNECTION_CHAOS_MODES.filter((mode) => this.#modes.has(mode));
    const [first, ...rest] = enabled;
    if (first === undefined) return null;
    return {
      mode: this.#random.pick([first, ...rest]),
      delayMs: this.#random.range(
        this.#intervalMs * (1 - CHAOS_INTERVAL_SPREAD),
        this.#intervalMs * (1 + CHAOS_INTERVAL_SPREAD),
      ),
    };
  }

  #fires(mode: ChaosMode): boolean {
    return this.#modes.has(mode) && this.#random.bool(this.#probability);
  }
}
