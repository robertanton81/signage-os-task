# Device Emulator Implementation Plan

**Goal:** Build `apps/emulator` so that `EMULATOR_DEVICE_COUNT` emulated devices each hold a long-lived socket to ingest, produce all four telemetry event types in a believable rhythm with a never-reused `(sessionId, seq)`, reconnect on loss, and can inject the four chaos modes on demand.

**Approach:** Thirteen tasks in dependency order, each one module plus its tests plus one commit. The first nine build the **pure core** (no I/O, no globals, no ambient clock) and are unit-tested directly; the next three build the **impure shell** and are tested against a real `net.createServer` sink on an ephemeral port — never a mocked socket. The last task ticks `TODO.md` and appends the spec's trade-off rows to the consistency spec.

This plan gives, per task, the exact file path, the exact exported signatures, every constant, the behaviour rule and the enumerated test cases. Signatures are written out in full because later tasks depend on them and a mismatch there is what breaks a multi-task plan; function bodies are not transcribed, because the design spec already fixes every rule they implement and a transcript would be a second source of truth to keep in sync.

**Design spec:** `docs/specs/2026-09-12-emulator-design.md` (committed `a1f3736`, passed two `design-reviewer` rounds). Binding above it: `docs/specs/2026-09-11-telemetry-consistency-design.md` and `docs/specs/2026-09-11-shared-contract-design.md`.
**TODO items:** `3. Emulátor zařízení` — all seven items.
**Branch:** `main`, direct, small atomic commits (the repo's existing practice; the commit history is part of the assessment).
**Scope:** `apps/emulator/**` and `.env.example`. **`packages/shared` is not modified** — every API this plan uses already exists there and was verified against the source: `encodeFrame`, `messageIdentity` (the dropped-entry `warn` line in Task 10 and the `debug` line per message), `createLogger` (whose `CreateLoggerOptions` includes the `destination` the log-asserting tests need), `messageLogger`, `loadConfig`, `ConfigError`, `envInt`, `logLevelEnv`, `shutdownEnv`, `assertNever`, `DEVICE_ID_PATTERN`, `DEVICE_ID_MAX_LENGTH`, `CONTRACT_VERSION`, `telemetryMessageSchema`, `TelemetryMessage`, `TelemetryMessageOf`, `MetricsPayload`, and `Logger` (imported from `@telemetry/shared`, never from `pino` — the annotation note in `logger.ts` explains why).

## Research (source links)

Everything this plan needs was verified in the design spec's Research section; the links are repeated here so the plan stands alone.

- [`socket.write(data[, encoding][, callback])`](https://nodejs.org/api/net.html#socketwritedata-encoding-callback) — "Returns `true` if the entire data was flushed successfully to the kernel buffer. Returns `false` if all or part of the data was queued in user memory. `'drain'` will be emitted when the buffer is again free." Basis of the pump in Task 10.
- [`net.Socket` event `'drain'`](https://github.com/nodejs/node/blob/main/doc/api/net.md?plain=1#L1137#event-drain) — "Emitted when the write buffer becomes empty."
- [`dnsPromises.lookup(hostname[, options])`](https://github.com/nodejs/node/blob/main/doc/api/dns.md?plain=1#L1081#dnspromises-lookup-hostname-options) — with `all: true` resolves to "an array of objects with the properties `address` and `family`"; `err.code` is `ENOTFOUND` "not only when the host name does not exist but also when the lookup fails in other ways such as no available file descriptors", which is why Task 9 treats every lookup failure as transient.
- [AWS IoT Device SDK `backoffAlgorithm`](https://github.com/aws/aws-iot-device-sdk-embedded-c/blob/main/README.md?plain=1#L156#backoffalgorithm) — Full Jitter is the reference strategy for a device reconnecting to a server. Basis of Task 3.
- zod 4.6.2: `ZodDefault<T>` exposes only `unwrap()` / `removeDefault()` (`node_modules/.pnpm/zod@4.6.2/node_modules/zod/v4/classic/schemas.d.ts:661-667`), while `.min()` / `.max()` are declared on the number schema (same file, `:338-344`). This is why `EMULATOR_CHAOS_PERCENT` is written out instead of using `envInt` (Task 8).
- `packages/shared/src/config.ts:29` — `envInt` returns `z.coerce.number().int().min(min).default(defaultValue)`.

### Two behaviours measured in this session, because getting them wrong breaks a task

**A `throw` inside a zod `.transform()` escapes `safeParse` — it does not become an issue.** Probed against the installed zod 4.6.2: a transform that throws leaves `safeParse` as a raw `Error` (`escaped: true`), because `$ZodTransform.parse` (`node_modules/.pnpm/zod@4.6.2/node_modules/zod/v4/core/schemas.js:2029-2046`) and `_safeParse` (`core/parse.js:41-48`) wrap the call in no `try`/`catch`, and neither does `loadConfig` (`packages/shared/src/config.ts:62`). It would therefore bypass `ConfigError` entirely and could print the offending value. The working form, also probed, is `ctx.addIssue({ code: 'custom', message })` followed by `return z.NEVER`, which produces an issue carrying the **variable name as its path** (`{"path":["H"],"message":"port out of range"}`) and so surfaces through `ConfigError` as `H: port out of range`. Task 8 is written against the probed form; the parsers therefore return a result object and never throw.

**`net.Server.close()` does not end open connections, and `closeAllConnections()` does not exist on `net.Server`.** Probed: with `getConnections` reporting 1, `server.close(cb)` left `cb` uncalled after 400 ms, the client stayed `writable`, and a write sent after `close()` was still delivered. (`closeAllConnections` is an `http.Server` method; calling it on a `net.Server` threw `TypeError: s2.closeAllConnections is not a function`.) Task 9's `TestSink.close()` must therefore destroy the sockets it has accepted itself, or every socket test that does not explicitly stop its client hangs until the vitest timeout.

### Two conventions this plan resolves once

**Logging a device without a message identity.** `eslint.config.js` forbids any `.child()` call, and `messageLogger` requires a _complete_ `MessageIdentity` (`deviceId`, `sessionId`, `seq`). Lifecycle lines (connect, disconnect, backoff, chaos, drain) have no `seq`. They therefore pass `{ deviceId, … }` as pino's **merging object** — `logger.info({ deviceId, address }, 'connected')` — which is covered by `formatters.log` redaction in `packages/shared/src/logger.ts`, unlike child bindings. Per-message lines (debug level only) use `messageLogger`.

**Argument style.** `max-params` is 2 and the shared-contract spec's decision 14 requires a single named object at three or more arguments, or at two or more of the same type. Every constructor below therefore takes one options object.

## File Changes

| Action | Path                                                    | Purpose                                                                     |
| ------ | ------------------------------------------------------- | --------------------------------------------------------------------------- |
| Modify | `apps/emulator/package.json`                            | Add `zod` (own config schema) and `vitest` from the catalog                 |
| Modify | `.env.example`                                          | Add `EMULATOR_SEED`, `EMULATOR_CHAOS_PERCENT`, `EMULATOR_CHAOS_INTERVAL_MS` |
| Create | `apps/emulator/src/random.ts`                           | Seeded mulberry32 PRNG                                                      |
| Create | `apps/emulator/src/random.test.ts`                      |                                                                             |
| Create | `apps/emulator/src/backoff.ts`                          | Full Jitter delay                                                           |
| Create | `apps/emulator/src/backoff.test.ts`                     |                                                                             |
| Create | `apps/emulator/src/generator.ts`                        | Per-device baselines and the bounded random walk                            |
| Create | `apps/emulator/src/generator.test.ts`                   |                                                                             |
| Create | `apps/emulator/src/session.ts`                          | `DeviceSession`: identity, `sessionId` minting, `seq`, tick                 |
| Create | `apps/emulator/src/session.test.ts`                     |                                                                             |
| Create | `apps/emulator/src/outbox.ts`                           | Bounded FIFO, diagnostic-sparing drop policy                                |
| Create | `apps/emulator/src/outbox.test.ts`                      |                                                                             |
| Create | `apps/emulator/src/chaos.ts`                            | Mode parsing, `ChaosPolicy`, `nextConnectionChaos`                          |
| Create | `apps/emulator/src/chaos.test.ts`                       |                                                                             |
| Create | `apps/emulator/src/config.ts`                           | The emulator's zod schema and parsers                                       |
| Create | `apps/emulator/src/config.test.ts`                      |                                                                             |
| Create | `apps/emulator/src/connection.ts`                       | DNS, socket lifecycle, backoff state machine                                |
| Create | `apps/emulator/src/connection.test.ts`                  | Against a real `net` sink                                                   |
| Create | `apps/emulator/src/device.ts`                           | `DeviceClient`: session + chaos + outbox + connection + timers              |
| Create | `apps/emulator/src/device.test.ts`                      | Against a real `net` sink                                                   |
| Create | `apps/emulator/src/fleet.ts`                            | `Fleet`: N clients, summary line, shutdown drain                            |
| Create | `apps/emulator/src/fleet.test.ts`                       | Against a real `net` sink                                                   |
| Create | `apps/emulator/src/test-sink.ts`                        | Shared test helper: a real TCP sink that collects NDJSON lines              |
| Modify | `apps/emulator/src/main.ts`                             | Replace the stub with the entrypoint                                        |
| Modify | `TODO.md`                                               | Tick step 3                                                                 |
| Modify | `docs/specs/2026-09-11-telemetry-consistency-design.md` | Append trade-offs T19–T25                                                   |

`apps/emulator/src/test-sink.ts` carries no `.test.ts` suffix on purpose: the `unit` vitest project includes `src/**/*.test.ts`, so a helper named `*.test.ts` with no `test()` call in it would be collected as an empty suite. It does compile into `dist/` because `apps/emulator/tsconfig.json` includes all of `src` — accepted: it is never imported by `main.ts`, and excluding it would mean a second `include` pattern and a divergence between what `tsc -b` type-checks and what vitest runs.

## Tasks

### Task 1: Package dependencies and documented configuration [mechanical]

**Files:** Modify `apps/emulator/package.json`, `.env.example`
**Invariant:** none touched.
**Verify:** `pnpm install && pnpm --filter @telemetry/emulator typecheck && pnpm --filter @telemetry/emulator lint`

- [ ] In `apps/emulator/package.json`, add `"zod": "catalog:"` to the existing `dependencies` (which already declares `@telemetry/shared`) and add `"devDependencies": { "vitest": "catalog:" }`. Keep `"private": true` and the existing scripts unchanged.
- [ ] Run `pnpm install` (never `npm`/`yarn`); confirm `pnpm-lock.yaml` changes only by adding the emulator's two entries.
- [ ] Append three variables to the `# --- emulator ---` block of `.env.example`, each with the one-line comment style the file already uses:
      `EMULATOR_SEED=` ("PRNG seed; the same seed replays the same fleet, faults and chaos decisions (default 1)"),
      `EMULATOR_CHAOS_PERCENT=` ("Per-message chance of duplicate / out-of-order when those modes are on, 0–100 (default 5)"),
      `EMULATOR_CHAOS_INTERVAL_MS=` ("Mean time between disconnect / restart chaos events per device, drawn in [0.5x, 1.5x] (default 60000)").
- [ ] `pnpm format:check` passes (or `pnpm format` then re-check).
- [ ] Commit: `Add the emulator's own dependencies and chaos configuration`

### Task 2: Seeded PRNG [mechanical]

**Files:** Create `apps/emulator/src/random.ts`, `apps/emulator/src/random.test.ts`
**Invariant:** none touched.
**Verify:** `pnpm --filter @telemetry/emulator test && pnpm --filter @telemetry/emulator typecheck && pnpm --filter @telemetry/emulator lint`

Exports:

```ts
export type Random = {
  /** Uniform in [0, 1). */
  float(): number;
  /** Uniform in [min, max], both inclusive, integers. */
  int(min: number, max: number): number;
  /** True with the given probability in [0, 1]. */
  bool(probability: number): boolean;
  /** Uniform element of a non-empty array. */
  pick<T>(values: readonly [T, ...T[]]): T;
  /** Uniform in [min, max). Continuous — the walk's noise is fractional, so `int` cannot serve. */
  range(min: number, max: number): number;
};

export function createRandom(seed: number): Random;
/** Mixes the fleet seed with a device index so devices differ but the run is reproducible. */
export function deviceSeed(fleetSeed: number, deviceIndex: number): number;
```

Implementation notes: mulberry32 — state `s = (seed >>> 0)`; each `float()` does `s = (s + 0x6d2b79f5) >>> 0`, then `t = Math.imul(s ^ (s >>> 15), 1 | s)`, `t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t`, returns `((t ^ (t >>> 14)) >>> 0) / 4294967296`. `deviceSeed` mixes with `Math.imul(fleetSeed ^ 0x9e3779b9, 0x85ebca6b) + deviceIndex` coerced through `>>> 0`.

`pick` needs care under `noUncheckedIndexedAccess`: the non-empty tuple type `readonly [T, ...T[]]` only makes the **literal** `values[0]` read safe, while a **computed** index into the rest element still types as `T | undefined`. Since `@typescript-eslint/no-non-null-assertion` is an error, write it as `values.at(index) ?? values[0]` — the fallback is unreachable given the tuple type and costs one `??`.

- [ ] Write failing tests: (1) two generators with the same seed produce identical first 100 floats; (2) two different seeds diverge within the first 10 values; (3) 10 000 `float()` values are all in `[0, 1)`; (4) 10 000 `int(3, 7)` values are all integers within `[3, 7]` and every endpoint occurs at least once; (5) `bool(0)` is never true and `bool(1)` is always true over 1 000 draws; (6) `pick` only ever returns an element of the input; (7) `deviceSeed` gives different seeds for indices 0..99 with one fleet seed; (8) 10 000 `range(-1.5, 1.5)` values are all `>= -1.5` and `< 1.5`, at least one is negative, at least one positive, and at least one is not an integer — a `range` that silently delegated to `int` would fail the last assertion; (9) `range(2, 2)` returns exactly 2; (10) the same seed replays the same `range` sequence.
- [ ] Verify tests fail
- [ ] Implement `random.ts`
- [ ] Verify tests pass
- [ ] Commit: `Add the emulator's seeded random source`

### Task 3: Full Jitter backoff [mechanical]

**Files:** Create `apps/emulator/src/backoff.ts`, `apps/emulator/src/backoff.test.ts`
**Invariant:** none touched.
**Verify:** `pnpm --filter @telemetry/emulator test && pnpm --filter @telemetry/emulator typecheck && pnpm --filter @telemetry/emulator lint`

```ts
export const BACKOFF_BASE_MS = 500;
export const BACKOFF_MAX_MS = 10_000;

/** Full Jitter: uniform in [0, min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** attempt)). */
export function backoffDelay(attempt: number, random: Random): number;
```

`attempt` is 0-based. The exponent is clamped (`Math.min(attempt, 31)`) before the shift so a long outage cannot overflow into `Infinity` or a negative number.

- [ ] Write failing tests: (1) for attempts 0..50 with a `Random` stub returning `float() = 0.999…`, the delay never exceeds `BACKOFF_MAX_MS`; (2) with `float() = 0`, every delay is 0; (3) the ceiling doubles per attempt until the cap — assert attempt 0 < 500, attempt 1 < 1 000, attempt 4 < 8 000, attempt 5 and 50 both < 10 000 using `float()` just under 1; (4) the result is a function of the injected random only — the same attempt with the same stub gives the same number twice.
- [ ] Verify tests fail
- [ ] Implement `backoff.ts`
- [ ] Verify tests pass
- [ ] Commit: `Add Full Jitter reconnect backoff`

### Task 4: Payload generator and the value walk [mechanical]

**Files:** Create `apps/emulator/src/generator.ts`, `apps/emulator/src/generator.test.ts`
**Invariant:** none touched (this task produces payloads, not identity).
**Verify:** `pnpm --filter @telemetry/emulator test && pnpm --filter @telemetry/emulator typecheck && pnpm --filter @telemetry/emulator lint`

```ts
export const FAULTY_DEVICE_PROBABILITY = 0.1;
export const DEGRADED_CPU_PERCENT = 90;
export const DEGRADED_TEMPERATURE_C = 75;
export const RECOVERED_CPU_PERCENT = 85;
export const RECOVERED_TEMPERATURE_C = 70;
export const OVERHEAT_TEMPERATURE_C = 85;
export const COUNTERS_EVERY_N_TICKS = 5;
export const INFO_DIAGNOSTIC_PROBABILITY = 0.02;
export const INFO_DIAGNOSTIC_CODES = ['E_CONFIG_RELOAD', 'E_NET_RETRY', 'E_CACHE_EVICT'] as const;

export type DeviceProfile = { faulty: boolean; baseline: MetricsPayload };
export type WalkState = MetricsPayload;

/** Drawn once per device: baselines, and whether this device runs hot. */
export function createProfile(random: Random): DeviceProfile;
/** The walk's starting point: the baseline itself. */
export function initialWalk(profile: DeviceProfile): WalkState;
/** One step: pulled 10% toward the baseline, plus uniform noise, clamped, rounded to 2 decimals. */
export function stepWalk(
  state: WalkState,
  context: { profile: DeviceProfile; random: Random },
): WalkState;
/** `degraded` above the degraded thresholds, `online` below the recovered ones, otherwise unchanged. */
export function deriveState(
  walk: WalkState,
  previous: 'online' | 'degraded',
): 'online' | 'degraded';
```

Baselines: `temperatureC` uniform 32–48 (healthy) or 70–80 (faulty); `cpuPercent` uniform 5–40; `ramPercent` uniform 20–70. Steps: temperature ±1.5, cpu ±8, ram ±4. Clamps: temperature 15–95, cpu and ram 0–100. Rounding to two decimals happens inside `stepWalk` so the walk state and the emitted payload are the same numbers (a payload rounded only on the way out would drift from the state it came from).

- [ ] Write failing tests: (1) over 10 000 steps with a real seeded `Random`, every field stays inside its clamp; (2) the walk actually moves — the set of distinct `temperatureC` values over 100 steps has more than one element; (3) the walk stays near its baseline — the mean of 10 000 `temperatureC` samples is within ±5 of the baseline, proving the pull term works; (4) with a fixed fleet seed, at least one device index in 0..49 is faulty and at least one is not; (5) a faulty profile crosses `OVERHEAT_TEMPERATURE_C` within 10 000 steps and a healthy one never does; (6) `deriveState` returns `degraded` at cpu 91, stays `degraded` at cpu 87 (hysteresis), returns `online` at cpu 84, and the same for temperature; (7) every value is rounded to at most two decimals.
- [ ] Verify tests fail
- [ ] Implement `generator.ts`
- [ ] Verify tests pass
- [ ] Commit: `Add the emulator's bounded value walk`

### Task 5: DeviceSession — identity, order key and the tick [mechanical]

**Files:** Create `apps/emulator/src/session.ts`, `apps/emulator/src/session.test.ts`
**Invariant:** **Invariant 1 (logical order wins).** The emulator is the source of the order key; this is the only module that allocates `sessionId` and `seq`. Proven by the `seq` and `sessionId` cases below, which are the strictest tests in the plan.
**Verify:** `pnpm --filter @telemetry/emulator test && pnpm --filter @telemetry/emulator typecheck && pnpm --filter @telemetry/emulator lint`

```ts
export type DeviceSessionOptions = { deviceId: string; random: Random; now: () => number };

export class DeviceSession {
  constructor(options: DeviceSessionOptions);
  /** Mints the next sessionId, resets seq, emits `status: online` at seq 1. */
  start(): TelemetryMessage[];
  /** The events due at this tick, in fixed order: metrics, counters, status, diagnostic. */
  tick(): TelemetryMessage[];
  /** One `status` carrying the current derived state. Called only by the client's idle timer. */
  heartbeat(): TelemetryMessage[];
  /** One `status: offline`. Called once, at shutdown. */
  farewell(): TelemetryMessage[];
  /** Resets the walk, the counters and the tick index, then calls start(). */
  restart(): TelemetryMessage[];
  get sessionId(): number;
  get nextSeq(): number;
}
```

Rules, all from the design spec:

- `sessionId` minting happens **only** inside `start()`: `this.#sessionId = Math.max(this.#now(), this.#sessionId + 1)`, with `#sessionId` initialised to 0. `restart()` must not mint separately.
- `tick()` produces, in this order: `metrics` every tick; `counters` on every fifth tick — concretely, `tick()` increments `#tickIndex` first (starting from 0) and emits `counters` when `#tickIndex % COUNTERS_EVERY_N_TICKS === 0`, so counters appear on the **5th, 10th, 15th** `tick()` call and never on the session-start `online` message; `status` **only** when `deriveState` differs from the last state sent; `diagnostic` on the transition into overheat (`severity: 'error'`, `code: 'E_OVERHEAT'`), else on the transition into `degraded` (`severity: 'warning'`, `code: 'E_DEGRADED'`), else with probability `INFO_DIAGNOSTIC_PROBABILITY` an `info` from `INFO_DIAGNOSTIC_CODES`. At most one diagnostic per tick.
- `counters`: `operationsTotal += random.int(0, 50)`, starting at 0 per session; `uptimeMs = Math.max(0, now() - sessionStartedAt)`. The clamp is load-bearing — `countersPayloadSchema` requires `z.int().min(0)`.
- Every message carries `v: CONTRACT_VERSION`, `deviceId`, `sessionId`, the next `seq`, and `occurredAt: this.#now()`.
- Diagnostic `message` strings are short fixed literals, one per code.

- [ ] Write failing tests, with an injected clock starting at `1_700_000_000_000` and advancing 1 000 ms per call:
      (1) **across 10 000 `tick()` calls plus a `heartbeat()`, a `farewell()` and two `restart()`s, the set of `(sessionId, seq)` pairs has exactly as many members as messages produced** — no repeat, ever;
      (2) within one session `seq` starts at 1 and increases by exactly 1 per message, with no gaps;
      (3) `sessionId` strictly increases across three restarts **with a clock frozen at one value**, proving the `+1` branch;
      (4) `sessionId` is at least `now()` when the clock has advanced past the previous session;
      (5) every message produced by every method passes `telemetryMessageSchema.safeParse`;
      (6) `operationsTotal` never decreases within a session and resets to a value below the previous total after `restart()`;
      (7) `uptimeMs` is 0, never negative, when the clock jumps to before `sessionStartedAt`;
      (8) `tick()` emits a `status` only when the derived state changed — assert no `status` across a run of ticks that stay `online`, and one `status` on the tick where it flips;
      (9) `heartbeat()` always returns exactly one `status` even when nothing changed;
      (10) `offline` appears only in `farewell()` output, never from `tick()` or `heartbeat()`;
      (11) `counters` appears on the 5th, 10th and 15th `tick()` call and on no other, and never in `start()` output.
- [ ] Verify tests fail
- [ ] Implement `session.ts`
- [ ] Verify tests pass
- [ ] Commit: `Add the emulator device session and its order key`

### Task 6: Bounded outbox [mechanical]

**Files:** Create `apps/emulator/src/outbox.ts`, `apps/emulator/src/outbox.test.ts`
**Invariant:** none directly; it is the only place that drops a message, and its `warn` log is what keeps that loss visible (design spec, failure table).
**Verify:** `pnpm --filter @telemetry/emulator test && pnpm --filter @telemetry/emulator typecheck && pnpm --filter @telemetry/emulator lint`

```ts
export type OutboxEntry = { message: TelemetryMessage; frame: Buffer };

export class Outbox {
  constructor(maxEntries: number);
  /** Appends; returns the entry evicted to make room, or null. */
  push(message: TelemetryMessage): OutboxEntry | null;
  /** Removes and returns the head, or null when empty. */
  shift(): OutboxEntry | null;
  clear(): void;
  get length(): number;
}
```

`push` encodes with `encodeFrame` from `@telemetry/shared` at insert time, so the outbox holds exactly the bytes that will be written. Eviction: scan from the head for the first entry whose `message.type !== 'diagnostic'` and remove it; if every entry is a diagnostic, remove the head.

- [ ] Write failing tests: (1) FIFO order out matches order in when under capacity; (2) at capacity, pushing evicts and returns the oldest non-diagnostic, and the diagnostics stay; (3) when the outbox holds only diagnostics, the head is evicted; (4) `length` never exceeds the maximum; (5) `push` returns `null` while under capacity; (6) the returned `frame` ends with `\n` and its JSON parses back to the message; (7) `clear` empties it.
- [ ] Verify tests fail
- [ ] Implement `outbox.ts`
- [ ] Verify tests pass
- [ ] Commit: `Add the emulator's bounded outbox`

### Task 7: Chaos modes [mechanical]

**Files:** Create `apps/emulator/src/chaos.ts`, `apps/emulator/src/chaos.test.ts`
**Invariant:** **Invariant 1 (logical order wins) and invariant 2 (duplicates have no effect).** This task is where both could be broken: chaos must never alter an order key. Proven by the "neither mode changes a `seq` or a `sessionId`" test below.
**Verify:** `pnpm --filter @telemetry/emulator test && pnpm --filter @telemetry/emulator typecheck && pnpm --filter @telemetry/emulator lint`

```ts
export const CHAOS_MODES = ['duplicate', 'out-of-order', 'disconnect', 'restart'] as const;
export type ChaosMode = (typeof CHAOS_MODES)[number];
/** Derived, not hand-written, so it cannot drift from CHAOS_MODES. */
export type ConnectionChaosMode = Extract<ChaosMode, 'disconnect' | 'restart'>;

/** A parser that never throws: see the zod finding in Research. */
export type ParseResult<T> = { ok: true; value: T } | { ok: false; message: string };

/** Trims each entry, drops empties, collapses duplicates. `ok: false` on an unknown name. */
export function parseChaosModes(raw: string): ParseResult<ChaosMode[]>;

export type ChaosPolicyOptions = {
  modes: readonly ChaosMode[];
  percent: number;
  intervalMs: number;
  random: Random;
};

export class ChaosPolicy {
  constructor(options: ChaosPolicyOptions);
  /** What to enqueue now, in order. Holds at most one apply() result back. */
  apply(message: TelemetryMessage): TelemetryMessage[];
  /** Releases the hold slot. Called before a deliberate disconnect and at shutdown. */
  flushHeld(): TelemetryMessage[];
  /** Drops the hold slot. Called on a restart — a power cycle loses RAM. */
  clearHeld(): void;
  /** Null when neither connection-level mode is enabled. */
  nextConnectionChaos(): { mode: ConnectionChaosMode; delayMs: number } | null;
}
```

`apply` evaluates in exactly this order (design spec, "The pure core"): build `emit = duplicateFired ? [m, m] : [m]`; if the slot is full, return `[...emit, ...held]` and empty the slot; else if `out-of-order` fired, store `emit` and return `[]`; else return `emit`. `nextConnectionChaos` draws `delayMs` uniformly in `[0.5 × intervalMs, 1.5 × intervalMs]` and `mode` uniformly among the enabled connection-level modes.

- [ ] Write failing tests: (1) `parseChaosModes('duplicate, restart ,')` returns `ok: true` with both, trimmed; (2) `parseChaosModes('')` returns `ok: true` with `[]`; (3) `parseChaosModes('out_of_order')` returns `ok: false` and the message names the four valid modes **and does not echo the rejected input** (a device-controlled value must never reach a log line through the config error); (4) duplicates in the input collapse; (5) with `percent: 100` and only `duplicate`, `apply` returns the same message twice and both have the identical `sessionId` and `seq`; (6) with `percent: 100` and only `out-of-order`, the first `apply` returns `[]` and the second returns `[second, first]`; (7) **over 1 000 messages with every mode on at `percent: 100`, the multiset of `(sessionId, seq)` pairs emitted equals the multiset pushed in, once `flushHeld` has run** — nothing invented, nothing renumbered, nothing lost; (8) the hold slot never holds more than one `apply` result — after 1 000 calls at `percent: 100`, `flushHeld()` returns at most two messages; (9) `clearHeld` discards the slot and a following `flushHeld` returns `[]`; (10) `nextConnectionChaos()` returns `null` when only per-message modes are on, and otherwise a `delayMs` inside `[0.5×, 1.5×]` across 1 000 draws.
- [ ] Verify tests fail
- [ ] Implement `chaos.ts`
- [ ] Verify tests pass
- [ ] Commit: `Add the emulator's chaos modes as a wire-level policy`

### Task 8: Configuration [mechanical]

**Files:** Create `apps/emulator/src/config.ts`, `apps/emulator/src/config.test.ts`
**Invariant:** none touched, but the device-id cross-check is what stops the emulator producing ids that ingest would reject.
**Verify:** `pnpm --filter @telemetry/emulator test && pnpm --filter @telemetry/emulator typecheck && pnpm --filter @telemetry/emulator lint`

```ts
export type IngestHost = { host: string; port: number };
export type EmulatorConfig = z.output<typeof emulatorEnvSchema>;

export const DEVICE_INDEX_PAD = 4;
/** `<prefix>-0001`. The one place the id format lives. */
export function formatDeviceId(prefix: string, index: number): string;
export function parseIngestHosts(raw: string): ParseResult<IngestHost[]>;
export const emulatorEnvSchema = z.object({ … }).superRefine(…);   // no explicit annotation
export function loadEmulatorConfig(env?: NodeJS.ProcessEnv): EmulatorConfig;
```

`emulatorEnvSchema` must carry **no** explicit type annotation. `EmulatorConfig` is `z.output<typeof emulatorEnvSchema>`, so annotating the schema as `z.ZodType<EmulatorConfig>` would make the alias reference itself and TypeScript would reject it with "Type alias circularly references itself". Inference flows one way only — the same reason `telemetryMessageSchema` in `packages/shared/src/message.ts` has no annotation either.

Schema keys: `...logLevelEnv`, `...shutdownEnv`, `EMULATOR_DEVICE_COUNT: envInt(1, 10)`, `EMULATOR_DEVICE_ID_PREFIX: z.string().regex(/^[A-Za-z0-9_]+$/).default('dev')`, `EMULATOR_EVENT_INTERVAL_MS: envInt(1, 1_000)`, `EMULATOR_HEARTBEAT_MS: envInt(1, 30_000)`, `EMULATOR_OUTBOX_MAX: envInt(1, 1_000)`, `EMULATOR_SEED: envInt(0, 1)`, `EMULATOR_CHAOS_PERCENT: z.coerce.number().int().min(0).max(100).default(5)`, `EMULATOR_CHAOS_INTERVAL_MS: envInt(1_000, 60_000)`, plus the two parsed keys below. Composed with `z.object`, never `.strict()` — a service runs with hundreds of unrelated variables set.

The two parsed keys use the **issue channel, never a throw** (see Research; a throwing transform escapes `safeParse` and bypasses `ConfigError` entirely):

```ts
EMULATOR_CHAOS: z.string().default('').transform((raw, ctx) => {
  const parsed = parseChaosModes(raw);
  if (!parsed.ok) { ctx.addIssue({ code: 'custom', message: parsed.message }); return z.NEVER; }
  return parsed.value;
}),
INGEST_HOSTS: z.string().default('ingest:4000').transform((raw, ctx) => { /* same shape */ }),
```

Probed: this produces an issue whose `path` is the variable name, so `loadConfig` renders `INGEST_HOSTS: port out of range` and `ConfigError.problems` names the variable.

`.superRefine` on the whole object formats the **last** device id (`formatDeviceId(prefix, count)`) and calls `ctx.addIssue({ code: 'custom', path: ['EMULATOR_DEVICE_ID_PREFIX'], message })` when it fails `DEVICE_ID_PATTERN` or exceeds `DEVICE_ID_MAX_LENGTH` — the explicit `path` is what makes `ConfigError` name a variable the operator can act on. `parseIngestHosts` matches each trimmed entry against `/^(\[[0-9A-Fa-f:]+\]|[^:\s]+):(\d{1,5})$/`, strips brackets from the host, and rejects a port outside 1–65535. No message built on either path includes the received value.

Every failing case below asserts `expect(() => loadEmulatorConfig(env)).toThrow(ConfigError)` — asserting on the _type_ is what would have caught the throwing-transform bug, since a raw `Error` escaping `safeParse` also makes a naive `toThrow()` pass.

- [ ] Write failing tests: (1) an empty env yields every documented default; (2) `EMULATOR_DEVICE_ID_PREFIX` of 62 characters with `EMULATOR_DEVICE_COUNT=10` fails and the error text contains `EMULATOR_DEVICE_ID_PREFIX`; (3) the same prefix at length 55 passes; (4) a prefix containing `-` fails; (5) `INGEST_HOSTS=' a:1 , b:2 '` parses to two entries with trimmed hosts; (6) `INGEST_HOSTS='[::1]:4000'` parses to host `::1`; (7) ports `0` and `65536` fail; (8) `EMULATOR_CHAOS='nope'` fails naming the variable; (9) `EMULATOR_CHAOS_PERCENT='101'` fails and `'100'` passes; (10) whitespace-only values fall back to defaults (`loadConfig` trims); (11) no error message contains the offending value — assert the thrown message does not include a sentinel string passed in as a bad prefix.
- [ ] Verify tests fail
- [ ] Implement `config.ts`
- [ ] Verify tests pass
- [ ] Commit: `Add the emulator configuration schema`

### Task 9: Connection state machine [integration]

**Files:** Create `apps/emulator/src/connection.ts`, `apps/emulator/src/test-sink.ts`, `apps/emulator/src/connection.test.ts`
**Invariant:** none directly; it must not reorder or lose what it is handed (proven by the frame-order test).
**Verify:** `pnpm --filter @telemetry/emulator test && pnpm --filter @telemetry/emulator typecheck && pnpm --filter @telemetry/emulator lint`

`test-sink.ts` exports a helper used by Tasks 9–11:

```ts
export type TestSink = {
  port: number;
  /** Every complete NDJSON line received, across all connections. */
  lines(): string[];
  /** Resolves when `lines().length >= count`; rejects on the test timeout. */
  waitForLines(count: number): Promise<string[]>;
  /** Number of connections accepted so far. */
  connectionCount(): number;
  /** Destroys every open connection without closing the server. */
  dropConnections(): void;
  /** Destroys every accepted socket, THEN closes the server. See the note below. */
  close(): Promise<void>;
};
export function startTestSink(): Promise<TestSink>;
```

`waitForLines` is how these tests avoid sleeps: it resolves on the data event that crosses the threshold.

`close()` must destroy the sockets it accepted **before** awaiting the server's close callback. Measured this session: with one live connection, `server.close(cb)` left `cb` uncalled after 400 ms and the socket stayed writable, so a sink that only calls `close()` hangs every test whose client is still connected — which is most of them. `net.Server` has no `closeAllConnections()` (that is `http.Server`; calling it throws `TypeError`), so the sink keeps its own `Set<net.Socket>`, adds on `'connection'`, removes on `'close'`, and destroys the set in `close()`. The same set backs `dropConnections()`.

Each test gets its **own** sink on port 0, so the kernel assigns a free port and files running in parallel cannot collide.

```ts
export type ConnectionState =
  | { name: 'idle' }
  | { name: 'resolving' }
  | { name: 'connecting'; socket: net.Socket }
  | { name: 'connected'; socket: net.Socket; writable: boolean }
  | { name: 'backoff'; attempt: number; timer: NodeJS.Timeout }
  | { name: 'stopped' };

export type DeviceConnectionOptions = {
  deviceId: string;
  hosts: readonly IngestHost[];
  random: Random;
  logger: Logger;
  onWritable: () => void;
};

export class DeviceConnection {
  constructor(options: DeviceConnectionOptions);
  start(): void;
  /** The socket's own return value; false also when not connected. */
  write(frame: Buffer): boolean;
  /** Destroys the socket and goes to backoff — the `disconnect` chaos mode. */
  dropConnection(): void;
  stop(): Promise<void>;
  get state(): ConnectionState;
  get isConnected(): boolean;
}
```

Branch on `state.name` with a `switch` and an `assertNever(state)` default, using `assertNever` from `@telemetry/shared`. `@typescript-eslint/switch-exhaustiveness-check` is an error in this repo, so a `switch` makes a future seventh state a compile failure; an `if`/`else` chain would silently fall through. The same applies to the `ChaosMode` branches in Task 7 and the `TelemetryEventType` branches in Task 5.

Transitions are the design spec's table. `resolving` calls `dnsPromises.lookup(host, { all: true })` for every entry, pools every returned address with its entry's port, and picks one with `random.int`. A host that fails to resolve is logged at `warn` and skipped; if every entry fails, the state goes to `backoff`. The socket gets `setNoDelay(true)` and `setKeepAlive(true, 30_000)`. `'connect'` resets `attempt` to 0, logs at `info` with `{ deviceId, address, port }`, and calls `onWritable`. `'error'` and `'close'` go to `backoff` with `backoffDelay(attempt, random)`. `'drain'` calls `onWritable`. `stop()` clears any timer, removes listeners, and ends the socket.

- [ ] Write failing tests, each against a real `startTestSink()`:
      (1) after `start()`, writes land at the sink as complete lines in the order written;
      (2) `sink.dropConnections()` is followed by a second accepted connection and later frames still arrive — reconnect works end to end;
      (3) `dropConnection()` moves the state to `backoff` and a reconnect follows;
      (4) `write()` returns `false` while not connected and the frame is not sent;
      (5) `stop()` leaves `state.name === 'stopped'` and the vitest process does not hang — assert `connection.state` and that a subsequent `write` returns false;
      (6) a host that does not resolve (`'this-host-does-not-exist.invalid:1'`) plus a good host still connects, proving the pool skips the failing entry.
      Set the sink's port through `hosts: [{ host: '127.0.0.1', port: sink.port }]` so no DNS is needed for the happy path.
- [ ] Verify tests fail
- [ ] Implement `test-sink.ts` and `connection.ts`
- [ ] Verify tests pass
- [ ] Commit: `Add the emulator device connection and its reconnect state machine`

### Task 10: DeviceClient [integration]

**Files:** Create `apps/emulator/src/device.ts`, `apps/emulator/src/device.test.ts`
**Invariant:** **Invariant 1.** The client is what carries the session's order key to the wire; the pump must not reorder it. Proven by the strictly-increasing-`seq`-at-the-sink test.
**Verify:** `pnpm --filter @telemetry/emulator test && pnpm --filter @telemetry/emulator typecheck && pnpm --filter @telemetry/emulator lint`

```ts
export type DeviceClientOptions = {
  deviceId: string;
  config: EmulatorConfig;
  random: Random;
  logger: Logger;
};

export type DeviceStats = {
  generated: number;
  written: number;
  dropped: number;
  reconnects: number;
};

export class DeviceClient {
  constructor(options: DeviceClientOptions);
  start(): void;
  /** Stops every timer, sets the stopped flag, stops generating. Does not drain. */
  stopGenerating(): void;
  /** Flushes the chaos hold slot, then pushes the farewell — both bypassing chaos. */
  prepareShutdown(): void;
  /** Drains the outbox into the socket as far as backpressure allows. Synchronous. */
  pump(): void;
  stop(): Promise<void>;
  get outboxLength(): number;
  get stats(): DeviceStats;
  get isConnected(): boolean;
}
```

Behaviour:

- `start()` builds the `DeviceSession`, `ChaosPolicy` (**with the same `Random` instance**) and `Outbox`, enqueues `session.start()`, starts the connection, arms the tick timer at a random phase in `[0, EMULATOR_EVENT_INTERVAL_MS)`, arms the heartbeat timer, and arms the connection-chaos timer when `nextConnectionChaos()` is non-null.
- The tick timer is a chained `setTimeout`, re-armed at the end of each tick with the full interval.
- **Two enqueue paths, not one.** `#generate(messages)` is the generation path: for each message `chaos.apply(m)`, then `#push` on every result. `#push(messages)` is the direct path: `outbox.push` each, log any eviction at `warn` with `{ deviceId }` and the dropped identity, update `stats`, and re-arm the heartbeat timer **only when `#stopped` is false**.
- The split is load-bearing, not tidiness. Anything already released by chaos — `flushHeld()` output and the farewell — must go through `#push`. Routing it back through `chaos.apply` lets the hold slot capture it again, and at `EMULATOR_CHAOS_PERCENT: 100` that is deterministic: the farewell would be stored in the slot, `apply` would return `[]`, and nothing would ever call `flushHeld()` again because every timer is stopped by then. The message would be lost silently — `outboxLength` reports 0 while the farewell sits inside `ChaosPolicy`, so even the drain's own `warn` in Task 11 would not see it. This also matches the design spec's wording for the disconnect case: "pushes `chaos.flushHeld()` **into the outbox**".
- The `#stopped` flag is the second half of the same problem. `stopGenerating()` sets it and clears every timer; without the flag, `prepareShutdown()`'s push would re-arm the heartbeat timer that step 1 of the drain just cleared, and with `SHUTDOWN_TIMEOUT_MS` (default 10 000) far above `EMULATOR_HEARTBEAT_MS` the timer would fire mid-drain and enqueue a `status` **after** the farewell — breaking both decision 20's "farewell is last" and `fleet.test.ts` case 2.
- The heartbeat timer fires `session.heartbeat()` through `#generate`; because `#push` re-arms it on every enqueue, it only fires after a genuine idle gap.
- The pump: while `outbox.length > 0` and `connection.write(head.frame)` returns `true`, shift. Stop on the first `false`; `onWritable` calls `pump` again. It is synchronous and returns nothing — `outboxLength` is how anyone observes progress.
- `prepareShutdown()`: `#push(chaos.flushHeld())`, then `#push(session.farewell())`. Both bypass `chaos.apply` for the reason above, so the farewell is always the last message in the outbox.
- Connection chaos: on `disconnect`, `#push(chaos.flushHeld())` then `connection.dropConnection()`; on `restart`, `chaos.clearHeld()`, `outbox.clear()`, `connection.dropConnection()`, `#generate(session.restart())`. Both log at `info` with `{ deviceId, mode }` and re-arm from `nextConnectionChaos()`.
- Per-message logging is `messageLogger(logger, m).debug(…)`; every other line passes `{ deviceId, … }` as the merging object.

- [ ] Write failing tests, against a real sink, with `EMULATOR_EVENT_INTERVAL_MS: 20`:
      (1) after `waitForLines(10)`, every line parses with `telemetryMessageSchema` and `seq` is strictly increasing by exactly 1 with no repeats;
      (2) the first line is `status` with `payload.state === 'online'` at `seq` 1;
      (3) **heartbeat, idle profile:** with `EMULATOR_EVENT_INTERVAL_MS: 400` and `EMULATOR_HEARTBEAT_MS: 30`, at least three `status` messages arrive within 300 ms — before the second tick could fire — so the heartbeat demonstrably fires in the idle gap;
      (4) **heartbeat, busy profile:** with `EMULATOR_EVENT_INTERVAL_MS: 20` and `EMULATOR_HEARTBEAT_MS: 100`, run for at least 600 ms (about 30 ticks and **six** heartbeat periods) on a seed whose device stays healthy, and assert exactly **one** `status` arrives — the session-start `online`. The test also asserts no metrics sample crossed a degraded threshold, so "one status" can only mean the heartbeat was suppressed. This is the falsifiable form: an implementation that dropped the re-arm and used a plain periodic timer would emit about seven. The earlier draft of this case used a 5 000 ms heartbeat over a 400 ms window, which would have passed even with the mechanism deleted, because the period simply had not elapsed. **Pin the seed** as a named constant in the test file, chosen during implementation so the device is non-faulty and stays below the thresholds for the window: the temperature walk cannot reach 75 °C from a healthy baseline (the pull term bounds the deviation at ten times the step, so 48 + 15 = 63 is the ceiling), but the CPU walk's bound is 40 + 80, so crossing 90 is improbable rather than impossible and the second assertion is what makes an unlucky seed fail loudly instead of passing for the wrong reason;
      (5) after `sink.dropConnections()`, messages generated while disconnected arrive once the client reconnects, still in `seq` order;
      (6) `stop()` ends with no open handles — assert `isConnected` is false.
- [ ] Verify tests fail
- [ ] Implement `device.ts`
- [ ] Verify tests pass
- [ ] Commit: `Add the emulator device client`

### Task 11: Fleet and the shutdown drain [integration]

**Files:** Create `apps/emulator/src/fleet.ts`, `apps/emulator/src/fleet.test.ts`
**Invariant:** **Invariant 4 (parallel across devices).** Each client is independent — no shared mutable state beyond the logger — proven by the distinct-device-ids test.
**Verify:** `pnpm --filter @telemetry/emulator test && pnpm --filter @telemetry/emulator typecheck && pnpm --filter @telemetry/emulator lint`

```ts
export const SUMMARY_INTERVAL_MS = 10_000;

/** `summaryIntervalMs` defaults to SUMMARY_INTERVAL_MS; only the tests override it. */
export type FleetOptions = { config: EmulatorConfig; logger: Logger; summaryIntervalMs?: number };

export class Fleet {
  constructor(options: FleetOptions);
  start(): void;
  /** The five-step drain. Resolves when every socket is closed. */
  shutdown(): Promise<void>;
  get devices(): readonly DeviceClient[];
}
```

`start()` creates `config.EMULATOR_DEVICE_COUNT` clients with `formatDeviceId(prefix, i + 1)` and `createRandom(deviceSeed(config.EMULATOR_SEED, i))`, starts each, and arms the summary interval (`unref()`ed so it never holds the process open). The summary logs one `info` line with the fleet totals from `DeviceStats`.

`shutdown()` runs the design spec's five numbered steps: **clear the fleet's own summary interval** and stop every timer on every client; `prepareShutdown()` on each (hold slot flushed, then farewell); pump and wait for every outbox to empty or `SHUTDOWN_TIMEOUT_MS`; **log `warn` per device still holding messages**, with `{ deviceId, remaining, state }`; then `stop()` every client. The wait is a promise that settles on whichever comes first — never a fixed sleep.

**How step 3 observes "empty".** `pump()` is synchronous and returns nothing; the background draining is driven by `DeviceConnection`'s `onWritable` callback, which calls `pump()` again on `'connect'` and `'drain'`. Fleet therefore polls: every 10 ms it calls `pump()` on each device and checks `outboxLength`, resolving as soon as every device reports 0, and giving up at `SHUTDOWN_TIMEOUT_MS`. A 10 ms poll over a drain that is normally a few milliseconds is not a sleep-driven test — it is the drain loop itself, and it is bounded on both ends.

Clearing the summary interval is explicit because `unref()` only stops it from holding the **process** open. `fleet.test.ts` builds and shuts down several fleets inside one vitest worker, and step 7 reuses `Fleet` directly, so an uncleared interval would keep logging stale `DeviceStats` from stopped clients for the life of that worker.

- [ ] Write failing tests, against a real sink:
      (1) with `EMULATOR_DEVICE_COUNT: 3`, the sink sees three connections and three distinct `deviceId` values, each with its own `seq` sequence starting at 1;
      (2) `shutdown()` delivers everything queued and the **last** line of every device is `status` with `state: 'offline'`;
      (3) **the regression test for the drain order:** with `EMULATOR_CHAOS: 'out-of-order'` at `percent: 100`, a message held at shutdown still arrives — assert the multiset of `seq` values received per device is exactly `1..n` with no gap;
      (4) **the best-effort case:** with `hosts` pointing at a closed port, `shutdown()` resolves within `SHUTDOWN_TIMEOUT_MS: 200` rather than hanging, and a `warn` line is emitted per device — assert with a `destination` stub passed into `createLogger` that collects lines;
      (5) two devices' messages never share a `deviceId`/`seq` pair;
      (6) after `shutdown()`, the summary interval no longer fires — assert with a collecting `destination` that no summary line appears in the 50 ms following shutdown when the `summaryIntervalMs` option is set to 10 ms for the test;
      (7) **no message follows the farewell:** with `EMULATOR_HEARTBEAT_MS: 20` and `SHUTDOWN_TIMEOUT_MS: 300`, so the heartbeat period is well inside the drain window, `shutdown()` still ends every device with `status: offline` and nothing after it — the regression test for the `#stopped` flag.
- [ ] Verify tests fail
- [ ] Implement `fleet.ts`
- [ ] Verify tests pass
- [ ] Commit: `Add the emulator fleet and its shutdown drain`

### Task 12: Entrypoint [integration]

**Files:** Modify `apps/emulator/src/main.ts`
**Invariant:** none touched.
**Verify:** `pnpm --filter @telemetry/emulator test && pnpm --filter @telemetry/emulator typecheck && pnpm --filter @telemetry/emulator lint && pnpm --filter @telemetry/emulator build`

`main.ts` keeps `export const SERVICE_NAME = 'emulator'` and adds: `loadEmulatorConfig()` (not wrapped in try/catch — an invalid configuration must end the process); `createLogger({ service: SERVICE_NAME, level: config.LOG_LEVEL })`; one `info` line with the effective configuration; `new Fleet({ config, logger })` and `start()`; `SIGTERM` and `SIGINT` handlers that call `shutdown()` once and then `process.exit(0)`, with a second signal exiting immediately with 130. The module must only run this when executed directly, so the tests in Tasks 9–11 can import siblings without starting a fleet — guard with `if (process.argv[1] === fileURLToPath(import.meta.url))`.

- [ ] Implement `main.ts`
- [ ] Manually verify: `pnpm --filter @telemetry/emulator build && node apps/emulator/dist/main.js` with no ingest running logs the config line, then per-device `warn` lines about failed connections, and **does not exit**; `Ctrl+C` shuts down cleanly.
- [ ] Manually verify against a sink: `node -e "require('net').createServer(s=>s.pipe(process.stdout)).listen(4000)"` in one shell, then `INGEST_HOSTS=127.0.0.1:4000 EMULATOR_DEVICE_COUNT=2 node apps/emulator/dist/main.js` in another; NDJSON lines appear.
- [ ] Commit: `Wire the emulator entrypoint and signal handling`

### Task 13: Ledger and trade-offs [mechanical]

**Files:** Modify `TODO.md`, `docs/specs/2026-09-11-telemetry-consistency-design.md`
**Invariant:** none touched.
**Verify:** `pnpm format:check`

- [ ] Tick all seven boxes under `## 3. Emulátor zařízení` and add a one-line note above them naming this plan and the commit range, in the style step 2 already uses.
- [ ] Append rows T19–T25 from the design spec's "Trade-offs added to the running list" to the consistency spec's running trade-off table (TODO item 0.8), preserving its column order.
- [ ] `pnpm format:check` passes.
- [ ] Commit: `Mark the emulator step done and record its trade-offs`

## Verification Criteria

| #   | Criterion                                                                                                | How to verify                                                                                                                                                                    |
| --- | -------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | A device never reuses `(sessionId, seq)`, under any chaos mode                                           | `session.test.ts` case 1 (10 000 ticks + restarts, pair set size equals message count) and `chaos.test.ts` case 7 (multiset in equals multiset out)                              |
| 2   | `sessionId` strictly increases across restarts, including two inside one millisecond                     | `session.test.ts` cases 3 and 4, with a frozen injected clock                                                                                                                    |
| 3   | Chaos produces duplicates and out-of-order pairs without altering an order key                           | `chaos.test.ts` cases 5, 6, 7                                                                                                                                                    |
| 4   | Every message the emulator can produce satisfies the shared contract                                     | `session.test.ts` case 5 (`telemetryMessageSchema.safeParse` on every method's output) and `device.test.ts` case 1 (at the sink, over a real socket)                             |
| 5   | A configurable number of devices each hold their own connection                                          | `fleet.test.ts` case 1 — three connections, three distinct device ids                                                                                                            |
| 6   | Event frequency is configurable                                                                          | `device.test.ts` runs at `EMULATOR_EVENT_INTERVAL_MS: 20`; `config.test.ts` case 1 pins the default of 1 000                                                                     |
| 7   | A device reconnects after connection loss and loses nothing that fits in the outbox                      | `connection.test.ts` case 2 and `device.test.ts` case 5                                                                                                                          |
| 8   | The heartbeat fires on an idle connection and never on a busy one                                        | `device.test.ts` cases 3 and 4 — both profiles                                                                                                                                   |
| 9   | Graceful shutdown drains the outboxes and ends each device with `status: offline`, with nothing after it | `fleet.test.ts` cases 2 and 7 (the second with a heartbeat period well inside the drain window, so a re-armed timer would show)                                                  |
| 10  | A message held by `out-of-order` at shutdown is still delivered, and the farewell is never itself held   | `fleet.test.ts` case 3 — `seq` values received per device are exactly `1..n`, which fails if the farewell (the highest `seq`) is captured by the chaos hold slot                 |
| 11  | Shutdown is bounded and visible when it cannot deliver                                                   | `fleet.test.ts` case 4 — resolves inside the budget against a closed port and emits a `warn` per device                                                                          |
| 12  | An invalid configuration fails at startup as a `ConfigError` naming the variable and never the value     | `config.test.ts` cases 2, 7, 8, 9, 11 — each asserts the thrown error is a `ConfigError` (not a raw `Error` escaping a transform) and that `problems` contains the variable name |
| 13  | A device id that would violate the contract is rejected before any message is produced                   | `config.test.ts` cases 2 and 3                                                                                                                                                   |
| 14  | The emulator survives ingest being absent and never exits                                                | Task 12 manual check: no ingest running, process stays up and logs reconnect attempts                                                                                            |
| 15  | The whole run is reproducible from `EMULATOR_SEED`                                                       | `random.test.ts` cases 1 and 7; `generator.test.ts` case 4                                                                                                                       |
| 16  | No `console.*` anywhere; every message line carries the device id and the message identity               | `pnpm --filter @telemetry/emulator lint` (the `no-console` and `no-restricted-syntax` rules) plus a `grep -rn 'console\.' apps/emulator/src` returning nothing                   |

## Test Plan

- Per task: `pnpm --filter @telemetry/emulator test && pnpm --filter @telemetry/emulator typecheck && pnpm --filter @telemetry/emulator lint`.
- **No Docker is needed for this plan.** Tasks 9–11 use a real TCP server inside the test process (`startTestSink`), not a mocked socket and not RabbitMQ or MongoDB. The `integration` vitest project (`test/integration/**`) stays empty until step 7; these files live in `src/` and run in the `unit` project.
- Every socket test waits on `waitForLines(n)`, never on a sleep. The vitest default timeout bounds them.
- Full pre-flight before reporting done: `pnpm lint && pnpm typecheck && pnpm test && pnpm format:check`.
- Expected test count after Task 13: roughly 75 new cases on top of the existing 202.

## Checkpoint Recovery

If interrupted mid-implementation, resume by:

1. Read this plan.
2. `git log --oneline` — each task ends with exactly one commit whose subject is quoted in the task.
3. Pick up from the first task whose commit is missing. Tasks run in numeric order: Task 2 (`Random`) is imported by Tasks 3, 4, 5 and 7; Task 4's constants are used by Task 5; Task 7's `ParseResult` and `parseChaosModes` are used by Task 8; Tasks 9–12 depend on everything before them. Only Task 6 (`Outbox`) is genuinely independent of its neighbours.
