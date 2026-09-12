import { CONTRACT_VERSION, type TelemetryMessage } from '@telemetry/shared';

import {
  COUNTERS_EVERY_N_TICKS,
  INFO_DIAGNOSTIC_CODES,
  INFO_DIAGNOSTIC_PROBABILITY,
  OVERHEAT_TEMPERATURE_C,
  createProfile,
  deriveState,
  initialWalk,
  stepWalk,
  type DeviceProfile,
  type DeviceState,
  type WalkState,
} from './generator.js';
import type { Random } from './random.js';

export type DeviceSessionOptions = {
  deviceId: string;
  random: Random;
  now: () => number;
};

const OPERATIONS_PER_TICK = { min: 0, max: 50 } as const;

const DIAGNOSTIC_MESSAGES: Record<string, string> = {
  E_OVERHEAT: 'temperature above the safe threshold',
  E_DEGRADED: 'device entered a degraded state',
  E_CONFIG_RELOAD: 'configuration reloaded',
  E_NET_RETRY: 'network request retried',
  E_CACHE_EVICT: 'cache entries evicted',
};

/**
 * One device's session: its identity, its order key, and the events it produces.
 *
 * Pure by construction — no timers, no sockets, no ambient clock, no `Math.random()`. Both the
 * clock and the random source are injected, so the unit tests drive hours of device life in
 * microseconds and replay any failure exactly (design spec, decisions 3 and 5).
 *
 * This is the ONLY place that allocates `sessionId` and `seq`, which is what makes invariant 1
 * ("older telemetry never overwrites newer known state") provable at the source: every message
 * this class returns has already consumed its `seq`, and nothing outside can mint one.
 */
export class DeviceSession {
  readonly #deviceId: string;
  readonly #random: Random;
  readonly #now: () => number;
  readonly #profile: DeviceProfile;

  #sessionId = 0;
  #nextSeq = 1;
  #sessionStartedAt = 0;
  #tickIndex = 0;
  #walk: WalkState;
  #state: DeviceState = 'online';
  #operationsTotal = 0;
  #overheating = false;

  constructor(options: DeviceSessionOptions) {
    this.#deviceId = options.deviceId;
    this.#random = options.random;
    this.#now = options.now;
    this.#profile = createProfile(options.random);
    this.#walk = initialWalk(this.#profile);
  }

  get sessionId(): number {
    return this.#sessionId;
  }

  get nextSeq(): number {
    return this.#nextSeq;
  }

  /**
   * Opens a new session and emits `status: online` at `seq` 1.
   *
   * `Math.max(now, previous + 1)` is the contract invariant from the consistency spec, decision
   * 28: a device must never reuse `(sessionId, seq)`, and two sessions inside one millisecond
   * would do exactly that if the clock alone decided. `#sessionId` starts at 0, so the first
   * session always takes the clock.
   */
  start(): TelemetryMessage[] {
    this.#sessionId = Math.max(this.#now(), this.#sessionId + 1);
    this.#sessionStartedAt = this.#now();
    this.#nextSeq = 1;
    this.#tickIndex = 0;
    this.#state = 'online';
    return [this.#status('online')];
  }

  /** A power cycle: the walk and the counters are lost, then a new session opens. */
  restart(): TelemetryMessage[] {
    this.#walk = initialWalk(this.#profile);
    this.#operationsTotal = 0;
    this.#overheating = false;
    return this.start();
  }

  /**
   * The events due at this tick, in a fixed order so the output is a deterministic function of
   * the injected clock and random source.
   */
  tick(): TelemetryMessage[] {
    this.#tickIndex += 1;
    this.#walk = stepWalk(this.#walk, { profile: this.#profile, random: this.#random });

    const messages: TelemetryMessage[] = [this.#metrics()];

    if (this.#tickIndex % COUNTERS_EVERY_N_TICKS === 0) {
      this.#operationsTotal += this.#random.int(OPERATIONS_PER_TICK.min, OPERATIONS_PER_TICK.max);
      messages.push(this.#counters());
    }

    const nextState = deriveState(this.#walk, this.#state);
    const stateChanged = nextState !== this.#state;
    this.#state = nextState;
    if (stateChanged) {
      messages.push(this.#status(nextState));
    }

    const diagnostic = this.#diagnostic(stateChanged);
    if (diagnostic !== undefined) {
      messages.push(diagnostic);
    }

    return messages;
  }

  /**
   * One `status` carrying the current state, regardless of whether anything changed. Called only
   * by the client's idle timer, so an otherwise silent connection still carries traffic
   * (design spec, decision 26).
   */
  heartbeat(): TelemetryMessage[] {
    return [this.#status(this.#state)];
  }

  /** A clean power-down. The only place `offline` is ever sent. */
  farewell(): TelemetryMessage[] {
    return [this.#status('offline')];
  }

  /**
   * An `error` on the transition INTO overheat, not on every tick while it holds. Alerts are
   * keyed per message, not per condition, so a device reporting the same code every tick would
   * create one alert per tick. Emitting on the edge keeps the alert count proportional to real
   * events; a genuinely repeating condition still creates one alert per event.
   */
  #diagnostic(stateChanged: boolean): TelemetryMessage | undefined {
    const overheating = this.#walk.temperatureC > OVERHEAT_TEMPERATURE_C;
    const wasOverheating = this.#overheating;
    this.#overheating = overheating;

    if (overheating && !wasOverheating) {
      return this.#diagnosticMessage('error', 'E_OVERHEAT');
    }
    if (stateChanged && this.#state === 'degraded') {
      return this.#diagnosticMessage('warning', 'E_DEGRADED');
    }
    if (this.#random.bool(INFO_DIAGNOSTIC_PROBABILITY)) {
      return this.#diagnosticMessage('info', this.#random.pick(INFO_DIAGNOSTIC_CODES));
    }
    return undefined;
  }

  /** The envelope every message shares. Consumes one `seq`, so it is called exactly once per message. */
  #envelope(): {
    v: typeof CONTRACT_VERSION;
    deviceId: string;
    sessionId: number;
    seq: number;
    occurredAt: number;
  } {
    const seq = this.#nextSeq;
    this.#nextSeq += 1;
    return {
      v: CONTRACT_VERSION,
      deviceId: this.#deviceId,
      sessionId: this.#sessionId,
      seq,
      occurredAt: this.#now(),
    };
  }

  #status(state: 'online' | 'degraded' | 'offline'): TelemetryMessage {
    return { ...this.#envelope(), type: 'status', payload: { state } };
  }

  #metrics(): TelemetryMessage {
    return { ...this.#envelope(), type: 'metrics', payload: { ...this.#walk } };
  }

  #counters(): TelemetryMessage {
    return {
      ...this.#envelope(),
      type: 'counters',
      payload: {
        operationsTotal: this.#operationsTotal,
        // Clamped: `countersPayloadSchema` requires a non-negative integer, and a clock corrected
        // backwards past the session start would otherwise produce a message ingest must reject —
        // losing a real event for a reason unrelated to it. A backwards clock costs monotonicity
        // of a diagnostic-only field instead (design spec, T24).
        uptimeMs: Math.max(0, this.#now() - this.#sessionStartedAt),
      },
    };
  }

  #diagnosticMessage(severity: 'info' | 'warning' | 'error', code: string): TelemetryMessage {
    return {
      ...this.#envelope(),
      type: 'diagnostic',
      // Short fixed literals: the emulator never puts an unbounded device-controlled string on
      // the wire, so `detail` in a rejection log can never be flooded from here.
      payload: { severity, code, message: DIAGNOSTIC_MESSAGES[code] ?? code },
    };
  }
}
