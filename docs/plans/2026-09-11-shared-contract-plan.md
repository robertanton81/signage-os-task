> **STATUS: SHIPPED 2026-09-12.** Landed as 10 commits `0ab2763..e47f946` on `main`. The unchecked `- [ ]` boxes below are historical — work is done. **Do not re-execute this plan.** If you're modifying the message contract, the storage document types, the broker/collection names, the logger or the config loader, work directly in `packages/shared/src/`.
>
> **Plan-vs-reality corrections discovered during execution:**
>
> **Library/version drift:** `zod@4.6.2` and `pino@10.3.1` installed exactly as pinned; no version drift. One missing dependency had to be added: `packages/shared/package.json` now declares `"devDependencies": { "vitest": "catalog:" }`. Before that, all seven `*.test.ts` files and `contract.test-d.ts` imported `vitest` and resolved only because `packages/shared` sits under the repo root — pnpm's isolated `node_modules` never granted it.
>
> **Plan code prescriptions that needed adjustment:**
>
> - `loadConfig<S extends z.ZodType>(schema, env): z.output<S>` looks like it should fail (returning `result.data` where the constraint is `ZodType<unknown>`) but **compiles fine**: zod 4.6.2 declares `safeParse(data): ZodSafeParseResult<core.output<this>>` with a polymorphic `this`. Do not "fix" it with a cast.
> - `Object.hasOwn` cannot replace the `in` operator in `extractRawIdentity`. TypeScript 6.0.3's `lib.es2022.object.d.ts` declares `hasOwn(o: object, v: PropertyKey): boolean` — a plain boolean, not a type predicate — so it does not narrow `unknown` and produces six TS2339 errors. `in` stays; a comment in `identity.ts` records this.
> - `SectionMeta` must stay a plain object type. Rewriting it as `Pick<TelemetryMessage, 'sessionId' | 'seq' | 'occurredAt'> & { receivedAt: number }` breaks the one `contract.test-d.ts` assertion that guards `SectionMeta`'s shape (the assertion inlines the four fields on purpose, so both sides must not move together).
> - In `contract.test-d.ts`, `expectTypeOf<DeviceStateDocument>().toEqualTypeOf<{ _id: string } & { [K in TelemetryEventType]?: DeviceStateSection<K> }>()` does **not** compile — `toEqualTypeOf` does not equate that intersection with the declared type. The explicit per-field object literal does, and catches the same swap.
> - An app that exports an inferred logger binding fails with **TS2883** (TS 6's successor to TS2742): "The inferred type of 'x' cannot be named without a reference to 'Logger' from '.../pino/pino.js'". Verified by probe in `apps/ingest`. Fix: annotate as `Logger` imported from `@telemetry/shared`, never add `pino` to an app's dependencies.
> - A failed `expectTypeOf` assertion surfaces as `TS2554: Expected 1 arguments, but got 0`, not as a readable message. When `tsc -b` reports that on a `.test-d.ts` line, the type assertion failed.
>
> **Corrections applied during review (commits `3c8fa87`, `07c52f7`, `6830bf2`, `7eef541`, `ae98b05`, `95bc841`, `45f918b`, `40db6a9`):**
>
> - **`message.test.ts`: the invalid-input table grew from 23 rows to 33.** The plan's Task 2 header claimed the table proved `sessionId >= 1`; it did not — `sessionId` had only a wrong-type case. Added `sessionId` 0 and fractional, the `DIAGNOSTIC_CODE_MAX_LENGTH` upper bound, unknown-key rejection for the metrics/counters/diagnostic payloads (only `status` was covered, so three of four `z.strictObject`s were unproven), plus the missing sibling constraints on `cpuPercent`/`ramPercent`/`operationsTotal`/`uptimeMs`.
> - **`framing.ts`: silent data loss fixed.** `push()` threw `FrameTooLongError` after already decoding valid frames from the same chunk, and those frames were unrecoverable — reproduced with `FrameDecoder(8).push('ok\nXXXXXXXXXXXXX')`, which lost `'ok'`. `FrameTooLongError` now carries `readonly frames: readonly string[]`. Tests added for the exact-limit boundary, decoder reuse after both throw sites, cross-instance isolation, the caller-buffer aliasing hazard, and a three-chunk split.
> - **`decode.ts`: `detail` is capped at 512 characters.** zod's `unrecognized_keys` message quotes offending key names verbatim, so one 64 KiB frame of junk keys produced a ~64 KiB log line. Measured against 4.6.2: `unrecognized_keys` echoes the key, `invalid_value` does **not** echo the received value. Docstring now states that the caller must bound `text`.
> - **`documents.ts` + `contract.test-d.ts`: a payload/watermark name collision was undetectable.** The update pipeline spreads `...payload` last, so a payload field named `sessionId`/`seq`/`occurredAt`/`receivedAt` would silently overwrite the watermark and break invariant 1. Added a `SectionMetaCollision` mapped-type guard (the naive `keyof PayloadOf<TelemetryEventType> & keyof SectionMeta` is vacuously `never` and would pass regardless). Also added full-shape assertions for `DeviceStateDocument` and `AlertDocument` — swapping two section types compiled cleanly before.
> - **`logger.ts`: `messageLogger` split.** It accepted a partial identity on the valid-message path, so the convention "every log line about a message carries the identity" could be broken silently. Now `messageLogger(logger, identity: MessageIdentity)` for validated messages and `rejectedMessageLogger(logger, identity: RawIdentity)` for decode failures. Added `redact` for `RABBITMQ_URL`/`MONGODB_URL`, which carry passwords.
> - **`config.ts`: whitespace-only values now count as unset.** `SHUTDOWN_TIMEOUT_MS=" "` silently produced `0` (because `Number(' ')` is `0` and the field's minimum is `0`), leaving a service with no drain window. The filter now uses `value.trim() !== ''`; an explicit `"0"` is still honoured. `envInt` also throws at construction time when its default is below its own minimum.
> - Test files split throughout so each test has one reason to fail; several tests that only re-proved zod or pino behaviour were removed or strengthened.
>
> **Deferrals worth tracking (these feed the README's "known limits" and "what we'd do with more time"):**
>
> - `FrameDecoder` re-copies and re-scans the pending tail on every chunk: O(N·k) for a frame arriving in k chunks, worst case ~65536² byte operations. Bounded by `MAX_FRAME_BYTES`, so not exploitable into unbounded growth. Fix if it ever matters: start `indexOf` at `#pending.length`.
> - `decode.ts` truncates by UTF-16 code unit, so an astral character landing at offset 512 can be split. Cosmetic; never throws.
> - Nothing can distinguish `result.data` from the raw parsed value in `decodeTelemetryMessage` until the schema gains a `.transform()`.
> - `envInt` uses `z.coerce.number()`, so `0x10`, `1e3` and `+5` are accepted. Every accepted form still yields a sane in-range integer.
> - **Steps 3–5 must:** catch `ConfigError` at each service entry point and exit; `await logger.flush()` before `process.exit()`; annotate exported logger bindings as `Logger` from `@telemetry/shared`; strip userinfo from a connection string before logging any driver error (pino's `redact` matches object paths, not substrings inside a string); and re-bound the message body on the AMQP consume path, since `MAX_FRAME_BYTES` only guards the socket path.
> - `occurredAt` is `z.int()` with no lower bound, so a corrupt device clock can send `0` or a negative value. It is diagnostic only and never decides order (consistency spec, decision 4).
> - `message.test.ts` uses `toContainEqual` rather than an exact one-element array. Do not tighten it: `'an empty deviceId'` legitimately produces two issues (`too_small` + `invalid_format`), since the empty string fails both `.min(1)` and the device-id regex.
> - `DeviceStateSection` flattens `SectionMeta` with the payload rather than nesting the payload; nesting was considered and rejected to keep query paths one level shorter. The collision guard above is what makes the flattening safe.
>
> **Plan history below is preserved as-written for context. Treat the live code as authoritative.**

# Shared Contract Package Implementation Plan

**Goal:** Turn `packages/shared` into the message contract, the storage document types, the broker and database naming, and the shared configuration and logging helpers that steps 3–5 build on.
**Approach:** One zod schema is the single source of truth for the message and its TypeScript type; three pure helpers (`messageIdentity`, `orderKey`, `isNewer`), a newline-delimited frame codec and a non-throwing decoder are the only logic; the RabbitMQ and MongoDB names are `as const` constants; a pino factory and a zod-based environment loader are the cross-cutting helpers. The package performs no I/O and depends on no client library, so every later package and test imports it without a broker or a database.
**Design spec:** `docs/specs/2026-09-11-shared-contract-design.md` (this step's decisions) and `docs/specs/2026-09-11-telemetry-consistency-design.md` (the contract itself, binding).
**TODO items:** 2. Sdílený balíček (kontrakt zpráv a domény) — all seven items.
**Branch:** `main` (commits go straight to `main`, decided 2026-09-11).
**Scope:** `packages/shared`, `pnpm-workspace.yaml` (catalog), `pnpm-lock.yaml`, `.env.example`, and three appended rows in `docs/specs/2026-09-11-telemetry-consistency-design.md`. No file under `apps/` changes.

## Research (source links)

Every library call below traces to one of these; the shared-contract spec's Research section holds the quotes.

- [Zod — Defining schemas](https://zod.dev/api) — zod@4.6.2: `z.strictObject`, `z.discriminatedUnion('type', [...])`, `z.literal`, `z.enum` on an `as const` tuple, `z.int()` (safe integers), `z.number()` (finite only), `z.string().min/max/regex`, `z.coerce.number()`, `.default()` (short-circuits: the default is returned as-is, so it is written in the output type), `z.union`, `z.ZodType` as a generic bound.
- [Zod — Basic usage](https://zod.dev/basics) — `.safeParse()` → `{ success, data | error }`; `error.issues[]` with `code`, `path`, `message`; `z.infer`, `z.output`.
- [Zod — Formatting errors](https://zod.dev/error-formatting) — `unrecognized_keys` issues carry the path of the object that had the extra key.
- [Zod 4 changelog — `z.number()`](https://zod.dev/v4/changelog#znumber) — infinite values rejected; `.int()` safe range only.
- Local probe 2026-09-11 and 2026-09-12 (scratch project with this repository's compiler options, TypeScript 6.0.3, Node 24.21.0): all 23 rows of Task 2's invalid-input table were run through zod 4.6.2 and produced exactly the asserted issue code and path (the full list, including `z.int()` → `invalid_type` for a fractional number and `z.enum` → `invalid_value`, is quoted in the shared-contract spec's Research); `import { z } from 'zod'` and `import { pino, type Logger } from 'pino'` compile under `nodenext` + `verbatimModuleSyntax`; a declaration build names all exported types (no TS2742); Task 6's `contract.test-d.ts` compiles as written against vitest 4.1.11 and a deliberately wrong assertion fails `tsc`.
- [pino — API](https://github.com/pinojs/pino/blob/main/docs/api.md) — pino@10.3.1: `pino(options, destination?)`; `level` incl. `'silent'`; `base` replaces `{ pid, hostname }`; `timestamp: pino.stdTimeFunctions.isoTime`; `destination` = any object with `write(msg: string)`; `logger.child(bindings)`; `logger.isLevelEnabled(level)`; child bindings must not be an externally supplied object (fields are copied one by one); a binding whose value is `undefined` is omitted from the line (local probe, 10.3.1).
- pino 10.3.1 `pino.d.ts` — named export `pino`, types `Logger`, `DestinationStream`; `stdTimeFunctions.isoTime`.
- [Node.js CLI — `--env-file-if-exists`](https://nodejs.org/api/cli.html#env-file-if-exists-file) — stable since v24.10.0; why no dotenv.
- [Vitest 4.1.11 — `expectTypeOf`](https://github.com/vitest-dev/vitest/blob/v4.1.11/docs/api/expect-typeof.md) — runtime no-op; `toEqualTypeOf` ("check if the types are fully equal"), `toBeNever` ("checks, if provided type is a `never` type"). Used only in `contract.test-d.ts`, which `tsc -b` checks and the `*.test.ts` include pattern does not execute.
- [Vitest 4.1.11 — test projects and CLI](https://github.com/vitest-dev/vitest/blob/v4.1.11/docs/guide/projects.md) (tooling spec) — `pnpm --filter @telemetry/shared test` runs `vitest run --root ../.. packages/shared`; `it.each` is standard Vitest API.
- [RabbitMQ — Queues, property equivalence](https://www.rabbitmq.com/docs/queues#property-equivalence) — `406 PRECONDITION_FAILED` on a redeclaration with different attributes; why the queue arguments are shared constants.
- [pnpm catalogs](https://pnpm.io/catalogs) — `catalog:` protocol for the two runtime dependencies.
- Node.js `Buffer` — `Buffer.indexOf(value, byteOffset)`, `Buffer.concat`, `buffer.subarray`, `buffer.toString(encoding, start, end)`, `Buffer.from(buffer)` copies ([Node 24 Buffer API](https://nodejs.org/docs/latest-v24.x/api/buffer.html)).

## File Changes

| Action | Path                                                    | Purpose                                                                                                              |
| ------ | ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Modify | `pnpm-workspace.yaml`                                   | Catalog entries `zod: 4.6.2`, `pino: 10.3.1`                                                                         |
| Modify | `packages/shared/package.json`                          | `dependencies` on `zod` and `pino` via `catalog:`                                                                    |
| Modify | `pnpm-lock.yaml`                                        | Updated by `pnpm install`                                                                                            |
| Create | `packages/shared/src/message.ts`                        | The zod schema, derived types, contract constants                                                                    |
| Create | `packages/shared/src/fixtures.ts`                       | One valid example message per type for this package's tests (not exported; the package has no subpath export for it) |
| Create | `packages/shared/src/message.test.ts`                   | Valid examples round-trip; 23 concrete invalid inputs with expected issue code and path                              |
| Create | `packages/shared/src/identity.ts`                       | `messageIdentity`, `orderKey`, `isNewer`, `extractRawIdentity`                                                       |
| Create | `packages/shared/src/identity.test.ts`                  | Identity string, order key, six ordered `isNewer` cases, raw identity extraction                                     |
| Create | `packages/shared/src/framing.ts`                        | `encodeFrame`, `FrameDecoder`, `FrameTooLongError`, `MAX_FRAME_BYTES`                                                |
| Create | `packages/shared/src/framing.test.ts`                   | Chunk splitting, multi-byte split, blank lines, CRLF, size limit and recovery, round-trip                            |
| Create | `packages/shared/src/decode.ts`                         | `decodeTelemetryMessage(text)` → `DecodeResult`                                                                      |
| Create | `packages/shared/src/decode.test.ts`                    | Valid, invalid JSON, schema violation with identity, never throws                                                    |
| Create | `packages/shared/src/documents.ts`                      | `DeviceStateDocument`, `EventDocument`, `AlertDocument`, `DeviceStateSection`                                        |
| Create | `packages/shared/src/contract.test-d.ts`                | Type-level assertions (checked by `tsc -b`)                                                                          |
| Create | `packages/shared/src/topology.ts`                       | RabbitMQ names, queue arguments, header and content-type constants                                                   |
| Create | `packages/shared/src/collections.ts`                    | MongoDB collection names, dedup index, `DUPLICATE_KEY_ERROR_CODE`                                                    |
| Create | `packages/shared/src/logger.ts`                         | `createLogger`, `messageLogger`, `LOG_LEVELS`, `Logger` type                                                         |
| Create | `packages/shared/src/logger.test.ts`                    | JSON line shape, identity fields on child lines, level filtering                                                     |
| Create | `packages/shared/src/config.ts`                         | `loadConfig`, `ConfigError`, `envInt`, the four env fragments                                                        |
| Create | `packages/shared/src/config.test.ts`                    | Defaults, empty = unset, integer and write-concern parsing, named errors, all at once                                |
| Modify | `packages/shared/src/index.ts`                          | Barrel (grows in every task)                                                                                         |
| Modify | `.env.example`                                          | The final 19 variables with comments and defaults, empty values                                                      |
| Modify | `docs/specs/2026-09-11-telemetry-consistency-design.md` | Append trade-off rows T11–T13 to the running list                                                                    |

## Tasks

### Task 1: Add the runtime dependencies [mechanical]

**Files:** Modify `pnpm-workspace.yaml`, `packages/shared/package.json`; `pnpm-lock.yaml` is regenerated
**Invariant:** none touched
**Verify:** `pnpm install --frozen-lockfile && pnpm ls --filter @telemetry/shared --depth 0`

- [ ] In `pnpm-workspace.yaml`, add two lines to the `catalog:` map, keeping alphabetical order:

  ```yaml
  catalog:
    '@eslint/js': 10.0.1
    '@types/node': 24.13.3
    eslint: 10.10.0
    eslint-config-prettier: 10.1.8
    pino: 10.3.1
    prettier: 3.9.6
    typescript: 6.0.3
    typescript-eslint: 8.70.0
    vitest: 4.1.11
    zod: 4.6.2
  ```

- [ ] In `packages/shared/package.json`, add after `"scripts"`:

  ```json
  "dependencies": {
    "pino": "catalog:",
    "zod": "catalog:"
  }
  ```

- [ ] Run `pnpm install` (not frozen: the lockfile must gain the two packages). Then run the verify command; the output must list `pino 10.3.1` and `zod 4.6.2` and nothing else new.
- [ ] Commit `pnpm-workspace.yaml`, `packages/shared/package.json`, `pnpm-lock.yaml` — subject: `Add zod and pino to the shared package`

### Task 2: Message contract schema and fixtures [integration]

**Files:** Create `packages/shared/src/message.ts`, `packages/shared/src/fixtures.ts`, `packages/shared/src/message.test.ts`; Modify `packages/shared/src/index.ts`
**Invariant:** 1 and 2 (inputs) — the schema guarantees every message carries `deviceId`, `sessionId ≥ 1`, `seq ≥ 1` as integers, which the order rule and the dedup key rely on; proved by the invalid-input table in `message.test.ts`.
**Verify:** `pnpm --filter @telemetry/shared test && pnpm --filter @telemetry/shared typecheck && pnpm --filter @telemetry/shared lint`

- [ ] Write `packages/shared/src/fixtures.ts`:

  ```ts
  import type { TelemetryEventType, TelemetryMessageOf } from './message.js';

  const envelope = {
    v: 1,
    deviceId: 'dev-0001',
    sessionId: 1_700_000_000_000,
    seq: 1,
    occurredAt: 1_700_000_000_500,
  } as const;

  /** One valid message per event type for this package's tests. Not exported: later packages build their own fixtures. */
  export const exampleMessages: { [T in TelemetryEventType]: TelemetryMessageOf<T> } = {
    status: { ...envelope, type: 'status', payload: { state: 'online' } },
    metrics: {
      ...envelope,
      type: 'metrics',
      payload: { temperatureC: 41.5, cpuPercent: 12.25, ramPercent: 63 },
    },
    counters: {
      ...envelope,
      type: 'counters',
      payload: { operationsTotal: 120, uptimeMs: 3_600_000 },
    },
    diagnostic: {
      ...envelope,
      type: 'diagnostic',
      payload: { severity: 'error', code: 'E_OVERHEAT', message: 'temperature above threshold' },
    },
  };

  /** A valid status message with envelope overrides, for tests that only care about identity and order. */
  export function makeStatusMessage(
    overrides: Partial<Omit<TelemetryMessageOf<'status'>, 'type' | 'payload'>> = {},
  ): TelemetryMessageOf<'status'> {
    return { ...exampleMessages.status, ...overrides };
  }
  ```

- [ ] Write the failing test `packages/shared/src/message.test.ts`:

  ```ts
  import { describe, expect, it } from 'vitest';

  import { exampleMessages } from './fixtures.js';
  import {
    DIAGNOSTIC_MESSAGE_MAX_LENGTH,
    TELEMETRY_EVENT_TYPES,
    telemetryMessageSchema,
  } from './message.js';

  describe('telemetryMessageSchema', () => {
    it.each(TELEMETRY_EVENT_TYPES)(
      'accepts a valid %s message and returns an equal copy',
      (type) => {
        const input = exampleMessages[type];
        const result = telemetryMessageSchema.safeParse(input);
        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.data).toEqual(input);
          expect(result.data).not.toBe(input);
        }
      },
    );

    it('accepts a diagnostic message that starts with a dollar sign', () => {
      // Processing stores it under $literal; the contract must not reject it (consistency spec, decision 8).
      const input = {
        ...exampleMessages.diagnostic,
        payload: { ...exampleMessages.diagnostic.payload, message: '$set is not a field path' },
      };
      expect(telemetryMessageSchema.safeParse(input).success).toBe(true);
    });

    const { status, metrics, counters, diagnostic } = exampleMessages;
    const { type: _omittedType, ...statusWithoutType } = status;
    const { occurredAt: _omittedOccurredAt, ...statusWithoutOccurredAt } = status;
    const { ramPercent: _omittedRam, ...metricsPayloadWithoutRam } = metrics.payload;

    const invalid: { name: string; input: unknown; code: string; path: PropertyKey[] }[] = [
      {
        name: 'an unknown type',
        input: { ...status, type: 'bogus' },
        code: 'invalid_union',
        path: ['type'],
      },
      { name: 'a missing type', input: statusWithoutType, code: 'invalid_union', path: ['type'] },
      {
        name: 'contract version 2',
        input: { ...status, v: 2 },
        code: 'invalid_value',
        path: ['v'],
      },
      {
        name: 'a deviceId with a space',
        input: { ...status, deviceId: 'dev 01' },
        code: 'invalid_format',
        path: ['deviceId'],
      },
      {
        name: 'a 65-character deviceId',
        input: { ...status, deviceId: 'd'.repeat(65) },
        code: 'too_big',
        path: ['deviceId'],
      },
      {
        name: 'an empty deviceId',
        input: { ...status, deviceId: '' },
        code: 'too_small',
        path: ['deviceId'],
      },
      { name: 'seq 0', input: { ...status, seq: 0 }, code: 'too_small', path: ['seq'] },
      {
        name: 'a fractional seq',
        input: { ...status, seq: 1.5 },
        code: 'invalid_type',
        path: ['seq'],
      },
      {
        name: 'a string sessionId',
        input: { ...status, sessionId: '1' },
        code: 'invalid_type',
        path: ['sessionId'],
      },
      {
        name: 'a missing occurredAt',
        input: statusWithoutOccurredAt,
        code: 'invalid_type',
        path: ['occurredAt'],
      },
      {
        name: 'an unknown envelope key',
        input: { ...status, extra: 1 },
        code: 'unrecognized_keys',
        path: [],
      },
      {
        name: 'an unknown payload key',
        input: { ...status, payload: { state: 'online', extra: 1 } },
        code: 'unrecognized_keys',
        path: ['payload'],
      },
      {
        name: 'metrics without ramPercent',
        input: { ...metrics, payload: metricsPayloadWithoutRam },
        code: 'invalid_type',
        path: ['payload', 'ramPercent'],
      },
      {
        name: 'a NaN temperature',
        input: { ...metrics, payload: { ...metrics.payload, temperatureC: Number.NaN } },
        code: 'invalid_type',
        path: ['payload', 'temperatureC'],
      },
      {
        name: 'an infinite temperature',
        input: {
          ...metrics,
          payload: { ...metrics.payload, temperatureC: Number.POSITIVE_INFINITY },
        },
        code: 'invalid_type',
        path: ['payload', 'temperatureC'],
      },
      {
        name: 'a negative operationsTotal',
        input: { ...counters, payload: { ...counters.payload, operationsTotal: -1 } },
        code: 'too_small',
        path: ['payload', 'operationsTotal'],
      },
      {
        name: 'a fractional uptimeMs',
        input: { ...counters, payload: { ...counters.payload, uptimeMs: 0.5 } },
        code: 'invalid_type',
        path: ['payload', 'uptimeMs'],
      },
      {
        name: 'an unknown status state',
        input: { ...status, payload: { state: 'rebooting' } },
        code: 'invalid_value',
        path: ['payload', 'state'],
      },
      {
        name: 'an unknown severity',
        input: { ...diagnostic, payload: { ...diagnostic.payload, severity: 'fatal' } },
        code: 'invalid_value',
        path: ['payload', 'severity'],
      },
      {
        name: 'an empty diagnostic code',
        input: { ...diagnostic, payload: { ...diagnostic.payload, code: '' } },
        code: 'too_small',
        path: ['payload', 'code'],
      },
      {
        name: 'a diagnostic message over the limit',
        input: {
          ...diagnostic,
          payload: {
            ...diagnostic.payload,
            message: 'x'.repeat(DIAGNOSTIC_MESSAGE_MAX_LENGTH + 1),
          },
        },
        code: 'too_big',
        path: ['payload', 'message'],
      },
      { name: 'a non-object', input: 'text', code: 'invalid_type', path: [] },
      { name: 'null', input: null, code: 'invalid_type', path: [] },
    ];

    it.each(invalid)('rejects $name with $code at $path', ({ input, code, path }) => {
      const result = telemetryMessageSchema.safeParse(input);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues).toContainEqual(expect.objectContaining({ code, path }));
      }
    });
  });
  ```

  Formatting: Prettier will wrap the long table rows; keep one object per row.

- [ ] Run the verify command; the test file must fail because `./message.js` does not exist yet.
- [ ] Write `packages/shared/src/message.ts`:

  ```ts
  import { z } from 'zod';

  /** Contract version carried by every message as `v`. Bump on an incompatible change. */
  export const CONTRACT_VERSION = 1;

  export const DEVICE_ID_PATTERN = /^[A-Za-z0-9_-]+$/;
  export const DEVICE_ID_MAX_LENGTH = 64;
  export const DIAGNOSTIC_CODE_MAX_LENGTH = 64;
  export const DIAGNOSTIC_MESSAGE_MAX_LENGTH = 1024;

  export const TELEMETRY_EVENT_TYPES = ['status', 'metrics', 'counters', 'diagnostic'] as const;
  export type TelemetryEventType = (typeof TELEMETRY_EVENT_TYPES)[number];

  // Envelope: device identity, message identity and order (consistency spec, decisions 1–4).
  // `occurredAt` is the device clock and is diagnostic only; `(sessionId, seq)` decides order.
  const envelopeShape = {
    v: z.literal(CONTRACT_VERSION),
    deviceId: z.string().min(1).max(DEVICE_ID_MAX_LENGTH).regex(DEVICE_ID_PATTERN),
    sessionId: z.int().min(1),
    seq: z.int().min(1),
    occurredAt: z.int(),
  };

  // Payloads carry absolute values (decision 5); counters are cumulative per session (decision 6).
  export const statusPayloadSchema = z.strictObject({
    state: z.enum(['online', 'degraded', 'offline']),
  });

  export const metricsPayloadSchema = z.strictObject({
    temperatureC: z.number(),
    cpuPercent: z.number(),
    ramPercent: z.number(),
  });

  export const countersPayloadSchema = z.strictObject({
    operationsTotal: z.int().min(0),
    uptimeMs: z.int().min(0),
  });

  export const diagnosticPayloadSchema = z.strictObject({
    severity: z.enum(['info', 'warning', 'error']),
    code: z.string().min(1).max(DIAGNOSTIC_CODE_MAX_LENGTH),
    message: z.string().max(DIAGNOSTIC_MESSAGE_MAX_LENGTH),
  });

  /** The whole message. Strict everywhere: unknown keys are rejected at any level. */
  export const telemetryMessageSchema = z.discriminatedUnion('type', [
    z.strictObject({ ...envelopeShape, type: z.literal('status'), payload: statusPayloadSchema }),
    z.strictObject({ ...envelopeShape, type: z.literal('metrics'), payload: metricsPayloadSchema }),
    z.strictObject({
      ...envelopeShape,
      type: z.literal('counters'),
      payload: countersPayloadSchema,
    }),
    z.strictObject({
      ...envelopeShape,
      type: z.literal('diagnostic'),
      payload: diagnosticPayloadSchema,
    }),
  ]);

  export type TelemetryMessage = z.infer<typeof telemetryMessageSchema>;
  export type TelemetryMessageOf<T extends TelemetryEventType> = Extract<
    TelemetryMessage,
    { type: T }
  >;
  export type PayloadOf<T extends TelemetryEventType> = TelemetryMessageOf<T>['payload'];
  export type StatusPayload = z.infer<typeof statusPayloadSchema>;
  export type MetricsPayload = z.infer<typeof metricsPayloadSchema>;
  export type CountersPayload = z.infer<typeof countersPayloadSchema>;
  export type DiagnosticPayload = z.infer<typeof diagnosticPayloadSchema>;
  ```

- [ ] Replace `packages/shared/src/index.ts` with:

  ```ts
  export { assertNever } from './assert-never.js';
  export * from './message.js';
  ```

- [ ] Run the verify command; all tests pass (2 existing + 4 + 1 + 23 new).
- [ ] Commit `packages/shared/src/message.ts`, `packages/shared/src/fixtures.ts`, `packages/shared/src/message.test.ts`, `packages/shared/src/index.ts` — subject: `Define the telemetry message schema and its types`

### Task 3: Identity, order key and freshness helpers [mechanical]

**Files:** Create `packages/shared/src/identity.ts`, `packages/shared/src/identity.test.ts`; Modify `packages/shared/src/index.ts`
**Invariant:** 1 — `isNewer` is the single definition of "newer" that the processing update pipeline is derived from (consistency spec, decision 8); 2 — `messageIdentity` is the deterministic dedup identity (decision 3). Proved by `identity.test.ts` (six ordered cases; identity string).
**Verify:** `pnpm --filter @telemetry/shared test && pnpm --filter @telemetry/shared typecheck && pnpm --filter @telemetry/shared lint`

- [ ] Write the failing test `packages/shared/src/identity.test.ts`:

  ```ts
  import { describe, expect, it } from 'vitest';

  import { makeStatusMessage } from './fixtures.js';
  import { extractRawIdentity, isNewer, messageIdentity, orderKey } from './identity.js';

  describe('messageIdentity', () => {
    it('joins device, session and sequence with colons', () => {
      const message = makeStatusMessage({
        deviceId: 'dev-0042',
        sessionId: 1_700_000_000_000,
        seq: 7,
      });
      expect(messageIdentity(message)).toBe('dev-0042:1700000000000:7');
    });
  });

  describe('orderKey', () => {
    it('is the session and sequence pair', () => {
      expect(orderKey({ sessionId: 5, seq: 3 })).toEqual([5, 3]);
    });
  });

  describe('isNewer', () => {
    it.each([
      {
        name: 'a newer session',
        candidate: { sessionId: 2, seq: 1 },
        stored: { sessionId: 1, seq: 9 },
        expected: true,
      },
      {
        name: 'the same session and a higher seq',
        candidate: { sessionId: 1, seq: 10 },
        stored: { sessionId: 1, seq: 9 },
        expected: true,
      },
      {
        name: 'the same key (a duplicate)',
        candidate: { sessionId: 1, seq: 9 },
        stored: { sessionId: 1, seq: 9 },
        expected: false,
      },
      {
        name: 'the same session and a lower seq',
        candidate: { sessionId: 1, seq: 8 },
        stored: { sessionId: 1, seq: 9 },
        expected: false,
      },
      {
        name: 'an older session with a higher seq',
        candidate: { sessionId: 1, seq: 99 },
        stored: { sessionId: 2, seq: 1 },
        expected: false,
      },
      {
        name: 'a newer session with a lower seq',
        candidate: { sessionId: 3, seq: 1 },
        stored: { sessionId: 2, seq: 50 },
        expected: true,
      },
    ])('$name → $expected', ({ candidate, stored, expected }) => {
      expect(isNewer(candidate, stored)).toBe(expected);
    });
  });

  describe('extractRawIdentity', () => {
    it('returns the three identity fields when they have the right types', () => {
      expect(extractRawIdentity({ deviceId: 'dev-1', sessionId: 2, seq: 3, type: 'x' })).toEqual({
        deviceId: 'dev-1',
        sessionId: 2,
        seq: 3,
      });
    });

    it('omits fields that are missing or of the wrong type', () => {
      expect(extractRawIdentity({ deviceId: 42, seq: '3' })).toEqual({});
      expect(extractRawIdentity({ deviceId: 'dev-1' })).toEqual({ deviceId: 'dev-1' });
    });

    it('returns an empty object for non-objects', () => {
      expect(extractRawIdentity('text')).toEqual({});
      expect(extractRawIdentity(null)).toEqual({});
      expect(extractRawIdentity(undefined)).toEqual({});
    });
  });
  ```

- [ ] Run the verify command; the test file must fail because `./identity.js` does not exist yet.
- [ ] Write `packages/shared/src/identity.ts`:

  ```ts
  /** The dedup key of a message (consistency spec, decision 3). */
  export type MessageIdentity = { deviceId: string; sessionId: number; seq: number };

  /** The order key of a message, compared lexicographically (decision 1). */
  export type OrderKey = { sessionId: number; seq: number };

  /** Identity fields found on an unvalidated value, for log lines about rejected input. */
  export type RawIdentity = Partial<MessageIdentity>;

  /** `deviceId:sessionId:seq` — the log field, the AMQP messageId and the `_id` of an alert. */
  export function messageIdentity(message: MessageIdentity): string {
    return `${message.deviceId}:${message.sessionId}:${message.seq}`;
  }

  export function orderKey(message: OrderKey): readonly [sessionId: number, seq: number] {
    return [message.sessionId, message.seq];
  }

  /**
   * The single definition of "newer" (decision 8). Equal keys are duplicates and are not newer.
   * The MongoDB update pipeline in processing is derived from this function and tested against it.
   */
  export function isNewer(candidate: OrderKey, stored: OrderKey): boolean {
    return (
      candidate.sessionId > stored.sessionId ||
      (candidate.sessionId === stored.sessionId && candidate.seq > stored.seq)
    );
  }

  export function extractRawIdentity(value: unknown): RawIdentity {
    if (typeof value !== 'object' || value === null) {
      return {};
    }
    const identity: RawIdentity = {};
    if ('deviceId' in value && typeof value.deviceId === 'string') {
      identity.deviceId = value.deviceId;
    }
    if ('sessionId' in value && typeof value.sessionId === 'number') {
      identity.sessionId = value.sessionId;
    }
    if ('seq' in value && typeof value.seq === 'number') {
      identity.seq = value.seq;
    }
    return identity;
  }
  ```

- [ ] Add `export * from './identity.js';` to `packages/shared/src/index.ts`.
- [ ] Run the verify command; all tests pass.
- [ ] Commit `packages/shared/src/identity.ts`, `packages/shared/src/identity.test.ts`, `packages/shared/src/index.ts` — subject: `Add message identity, order key and freshness helpers`

### Task 4: Newline-delimited frame codec [integration]

**Files:** Create `packages/shared/src/framing.ts`, `packages/shared/src/framing.test.ts`; Modify `packages/shared/src/index.ts`
**Invariant:** 6 — decoder state is per connection and dies with it; nothing per device. Proved by `framing.test.ts` (reset after overflow); isolation between connections follows from the private instance field, not from a test.
**Verify:** `pnpm --filter @telemetry/shared test && pnpm --filter @telemetry/shared typecheck && pnpm --filter @telemetry/shared lint`

- [ ] Write the failing test `packages/shared/src/framing.test.ts`:

  ```ts
  import { describe, expect, it } from 'vitest';

  import { exampleMessages } from './fixtures.js';
  import { FrameDecoder, FrameTooLongError, MAX_FRAME_BYTES, encodeFrame } from './framing.js';

  describe('encodeFrame', () => {
    it('serialises the message as one JSON line', () => {
      const message = exampleMessages.status;
      expect(encodeFrame(message).toString('utf8')).toBe(`${JSON.stringify(message)}\n`);
    });
  });

  describe('FrameDecoder', () => {
    it('returns each complete line and keeps the unfinished tail', () => {
      const decoder = new FrameDecoder();
      expect(decoder.push(Buffer.from('{"a":1}\n{"b":'))).toEqual(['{"a":1}']);
      expect(decoder.pendingBytes).toBe(5);
      expect(decoder.push(Buffer.from('2}\n'))).toEqual(['{"b":2}']);
      expect(decoder.pendingBytes).toBe(0);
    });

    it('returns several frames from one chunk in order', () => {
      const decoder = new FrameDecoder();
      expect(decoder.push(Buffer.from('1\n2\n3\n'))).toEqual(['1', '2', '3']);
    });

    it('reassembles a frame split inside a multi-byte character', () => {
      const bytes = Buffer.from('{"m":"čau"}\n', 'utf8');
      const cut = bytes.indexOf(0xc4) + 1; // between the two bytes of "č"
      const decoder = new FrameDecoder();
      const frames = [
        ...decoder.push(bytes.subarray(0, cut)),
        ...decoder.push(bytes.subarray(cut)),
      ];
      expect(frames).toEqual(['{"m":"čau"}']);
    });

    it('skips empty and whitespace-only lines and leaves a trailing carriage return in place', () => {
      const decoder = new FrameDecoder();
      const frames = decoder.push(Buffer.from('\n  \n{"a":1}\r\n'));
      expect(frames).toEqual(['{"a":1}\r']);
      expect(JSON.parse(frames[0] ?? '') as unknown).toEqual({ a: 1 });
    });

    it('throws FrameTooLongError when the unfinished tail exceeds the limit and resets', () => {
      const decoder = new FrameDecoder(8);
      expect(() => decoder.push(Buffer.from('123456789'))).toThrow(FrameTooLongError);
      expect(decoder.pendingBytes).toBe(0);
      expect(decoder.push(Buffer.from('{"a":1}\n'))).toEqual(['{"a":1}']);
    });

    it('throws FrameTooLongError with the sizes when a completed line exceeds the limit', () => {
      const decoder = new FrameDecoder(8);
      let caught: unknown;
      try {
        decoder.push(Buffer.from('123456789\n'));
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(FrameTooLongError);
      expect(caught).toMatchObject({ bytes: 9, limit: 8 });
    });

    it('uses a 64 KiB default limit', () => {
      expect(MAX_FRAME_BYTES).toBe(65_536);
    });

    it('round-trips every example message', () => {
      const decoder = new FrameDecoder();
      const chunk = Buffer.concat(Object.values(exampleMessages).map(encodeFrame));
      const decoded = decoder.push(chunk).map((line) => JSON.parse(line) as unknown);
      expect(decoded).toEqual(Object.values(exampleMessages));
    });
  });
  ```

- [ ] Run the verify command; the test file must fail because `./framing.js` does not exist yet.
- [ ] Write `packages/shared/src/framing.ts`:

  ```ts
  import type { TelemetryMessage } from './message.js';

  /** Upper bound of one frame in bytes, newline excluded. A valid message is a few hundred bytes. */
  export const MAX_FRAME_BYTES = 64 * 1024;

  const NEWLINE = 0x0a;

  export class FrameTooLongError extends Error {
    override readonly name = 'FrameTooLongError';

    constructor(
      readonly bytes: number,
      readonly limit: number,
    ) {
      super(`frame of ${bytes} bytes exceeds the limit of ${limit} bytes`);
    }
  }

  /** One message per line: UTF-8 JSON followed by `\n` (shared-contract spec, decision 1). */
  export function encodeFrame(message: TelemetryMessage): Buffer {
    return Buffer.from(`${JSON.stringify(message)}\n`, 'utf8');
  }

  /**
   * Splits a byte stream into complete lines. Keeps the unfinished tail between calls, so one
   * instance belongs to one connection. Whitespace-only lines are ignored.
   */
  export class FrameDecoder {
    #pending: Buffer = Buffer.alloc(0);
    readonly #maxFrameBytes: number;

    constructor(maxFrameBytes: number = MAX_FRAME_BYTES) {
      this.#maxFrameBytes = maxFrameBytes;
    }

    /** Bytes of the unfinished line currently buffered (logged when a connection closes). */
    get pendingBytes(): number {
      return this.#pending.length;
    }

    /**
     * Returns every complete frame in the stream so far, without its newline.
     * Throws FrameTooLongError when a line or the buffered tail exceeds the limit; the buffer is
     * cleared first so the caller may close the connection or keep reading.
     */
    push(chunk: Buffer): string[] {
      const data = this.#pending.length === 0 ? chunk : Buffer.concat([this.#pending, chunk]);
      const frames: string[] = [];
      let start = 0;
      for (;;) {
        const end = data.indexOf(NEWLINE, start);
        if (end === -1) {
          break;
        }
        if (end - start > this.#maxFrameBytes) {
          this.#pending = Buffer.alloc(0);
          throw new FrameTooLongError(end - start, this.#maxFrameBytes);
        }
        const line = data.toString('utf8', start, end);
        if (line.trim().length > 0) {
          frames.push(line);
        }
        start = end + 1;
      }
      const tail = data.subarray(start);
      if (tail.length > this.#maxFrameBytes) {
        this.#pending = Buffer.alloc(0);
        throw new FrameTooLongError(tail.length, this.#maxFrameBytes);
      }
      // Copy: the caller may reuse its chunk buffer after push returns.
      this.#pending = Buffer.from(tail);
      return frames;
    }
  }
  ```

- [ ] Add `export * from './framing.js';` to `packages/shared/src/index.ts`.
- [ ] Run the verify command; all tests pass.
- [ ] Commit `packages/shared/src/framing.ts`, `packages/shared/src/framing.test.ts`, `packages/shared/src/index.ts` — subject: `Add the newline-delimited frame codec`

### Task 5: Non-throwing decoder [mechanical]

**Files:** Create `packages/shared/src/decode.ts`, `packages/shared/src/decode.test.ts`; Modify `packages/shared/src/index.ts`
**Invariant:** none touched (input handling; `CLAUDE.md` "malformed input is rejected and logged, never crashes a service" — proved by `decode.test.ts`).
**Verify:** `pnpm --filter @telemetry/shared test && pnpm --filter @telemetry/shared typecheck && pnpm --filter @telemetry/shared lint`

- [ ] Write the failing test `packages/shared/src/decode.test.ts`:

  ```ts
  import { describe, expect, it } from 'vitest';

  import { decodeTelemetryMessage } from './decode.js';
  import { exampleMessages } from './fixtures.js';

  describe('decodeTelemetryMessage', () => {
    it('returns the validated message for a valid frame', () => {
      const result = decodeTelemetryMessage(JSON.stringify(exampleMessages.metrics));
      expect(result).toEqual({ ok: true, message: exampleMessages.metrics });
    });

    it('reports invalid JSON with the parser message and no identity', () => {
      const result = decodeTelemetryMessage('{"deviceId":');
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe('invalid_json');
        expect(result.detail).toContain('JSON');
        expect(result.identity).toEqual({});
      }
    });

    it('reports a schema violation with the offending path and the identity fields', () => {
      const input = {
        ...exampleMessages.metrics,
        payload: { ...exampleMessages.metrics.payload, temperatureC: 'hot' },
      };
      const result = decodeTelemetryMessage(JSON.stringify(input));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe('invalid_schema');
        expect(result.detail).toMatch(/^payload\.temperatureC: /);
        expect(result.identity).toEqual({
          deviceId: input.deviceId,
          sessionId: input.sessionId,
          seq: input.seq,
        });
      }
    });

    it('marks root-level issues as (root) and lists every issue', () => {
      const result = decodeTelemetryMessage('"text"');
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.detail).toMatch(/^\(root\): /);
      }
      const twoIssues = decodeTelemetryMessage(
        JSON.stringify({ ...exampleMessages.status, seq: 0, v: 2 }),
      );
      expect(twoIssues.ok).toBe(false);
      if (!twoIssues.ok) {
        expect(twoIssues.detail).toContain('v: ');
        expect(twoIssues.detail).toContain('seq: ');
        expect(twoIssues.detail).toContain('; ');
      }
    });

    it('keeps only identity fields of the right type', () => {
      const result = decodeTelemetryMessage(
        JSON.stringify({ deviceId: 7, sessionId: 1, seq: 'x' }),
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.identity).toEqual({ sessionId: 1 });
      }
    });

    it('never throws, even for an empty frame', () => {
      expect(() => decodeTelemetryMessage('')).not.toThrow();
      expect(decodeTelemetryMessage('').ok).toBe(false);
    });
  });
  ```

- [ ] Run the verify command; the test file must fail because `./decode.js` does not exist yet.
- [ ] Write `packages/shared/src/decode.ts`:

  ```ts
  import { extractRawIdentity, type RawIdentity } from './identity.js';
  import { telemetryMessageSchema, type TelemetryMessage } from './message.js';

  export type DecodeFailureReason = 'invalid_json' | 'invalid_schema';

  export type DecodeResult =
    | { ok: true; message: TelemetryMessage }
    | { ok: false; reason: DecodeFailureReason; detail: string; identity: RawIdentity };

  type IssueLike = { readonly path: readonly PropertyKey[]; readonly message: string };

  /**
   * Turns the text of one frame into a validated message or a structured rejection. Never throws:
   * invalid input is a normal path that the caller logs (with `identity`) and drops.
   */
  export function decodeTelemetryMessage(text: string): DecodeResult {
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      return { ok: false, reason: 'invalid_json', detail, identity: {} };
    }
    const result = telemetryMessageSchema.safeParse(value);
    if (result.success) {
      return { ok: true, message: result.data };
    }
    return {
      ok: false,
      reason: 'invalid_schema',
      detail: formatIssues(result.error.issues),
      identity: extractRawIdentity(value),
    };
  }

  function formatIssues(issues: readonly IssueLike[]): string {
    return issues
      .map(
        (issue) =>
          `${issue.path.length === 0 ? '(root)' : issue.path.map(String).join('.')}: ${issue.message}`,
      )
      .join('; ');
  }
  ```

- [ ] Add `export * from './decode.js';` to `packages/shared/src/index.ts`.
- [ ] Run the verify command; all tests pass.
- [ ] Commit `packages/shared/src/decode.ts`, `packages/shared/src/decode.test.ts`, `packages/shared/src/index.ts` — subject: `Add the non-throwing telemetry frame decoder`

### Task 6: Storage document types [mechanical]

**Files:** Create `packages/shared/src/documents.ts`, `packages/shared/src/contract.test-d.ts`; Modify `packages/shared/src/index.ts`
**Invariant:** 3 — `DeviceStateDocument` is the one-document-per-device shape with a watermark per section that the conditional single-document update needs (consistency spec, decision 7). Proved at the type level by `contract.test-d.ts` (checked by `tsc -b`); the runtime proof is the step 5/7 integration tests.
**Verify:** `pnpm --filter @telemetry/shared test && pnpm --filter @telemetry/shared typecheck && pnpm --filter @telemetry/shared lint`

- [ ] Write `packages/shared/src/contract.test-d.ts` (type-level only; `tsc -b` fails on a wrong type, Vitest does not execute it):

  ```ts
  // Type-level assertions. Checked by `pnpm --filter @telemetry/shared typecheck` (tsc -b compiles
  // the whole src tree); the Vitest unit project only runs *.test.ts, so nothing here executes.
  import { expectTypeOf } from 'vitest';

  import type {
    AlertDocument,
    DeviceStateDocument,
    DeviceStateSection,
    EventDocument,
  } from './documents.js';
  import type { CountersPayload, TelemetryEventType, TelemetryMessage } from './message.js';

  // The event-type list and the schema union agree.
  expectTypeOf<TelemetryMessage['type']>().toEqualTypeOf<TelemetryEventType>();

  // Every event type has exactly one optional section in the state document, and nothing else.
  expectTypeOf<Exclude<keyof DeviceStateDocument, '_id'>>().toEqualTypeOf<TelemetryEventType>();
  expectTypeOf<DeviceStateDocument['metrics']>().toEqualTypeOf<
    DeviceStateSection<'metrics'> | undefined
  >();
  expectTypeOf<DeviceStateSection<'counters'>>().toEqualTypeOf<
    { sessionId: number; seq: number; occurredAt: number; receivedAt: number } & CountersPayload
  >();

  // The event document narrows its payload by type and has no _id (the driver adds the ObjectId).
  expectTypeOf<
    Extract<EventDocument, { type: 'counters' }>['payload']
  >().toEqualTypeOf<CountersPayload>();
  expectTypeOf<Extract<keyof EventDocument, '_id'>>().toBeNever();

  // Alerts are keyed by the message identity string.
  expectTypeOf<AlertDocument['_id']>().toEqualTypeOf<string>();
  ```

- [ ] Run `pnpm --filter @telemetry/shared typecheck`; it must fail because `./documents.js` does not exist yet.
- [ ] Write `packages/shared/src/documents.ts`:

  ```ts
  import type { PayloadOf, TelemetryEventType } from './message.js';

  /** Watermark and provenance stored with every section (consistency spec, decision 7). */
  export type SectionMeta = {
    sessionId: number;
    seq: number;
    occurredAt: number;
    receivedAt: number;
  };

  /** The newest unique event of one type, with its own `(sessionId, seq)` watermark. */
  export type DeviceStateSection<T extends TelemetryEventType> = SectionMeta & PayloadOf<T>;

  /**
   * One document per device in `device_state`; `_id` is the device id. A section is absent until
   * the first event of its type arrives. There is deliberately no top-level `updatedAt`.
   */
  export type DeviceStateDocument = {
    _id: string;
    status?: DeviceStateSection<'status'>;
    metrics?: DeviceStateSection<'metrics'>;
    counters?: DeviceStateSection<'counters'>;
    diagnostic?: DeviceStateSection<'diagnostic'>;
  };

  /**
   * One document per unique event in `events`. `_id` is left to the driver (an ObjectId);
   * `(deviceId, sessionId, seq)` is the unique dedup key (EVENTS_IDENTITY_INDEX).
   */
  export type EventDocument = {
    [T in TelemetryEventType]: {
      deviceId: string;
      sessionId: number;
      seq: number;
      type: T;
      occurredAt: number;
      receivedAt: number;
      processedAt: number;
      payload: PayloadOf<T>;
    };
  }[TelemetryEventType];

  /** One document per error diagnostic in `alerts`; `_id` is the message identity string. */
  export type AlertDocument = {
    _id: string;
    deviceId: string;
    sessionId: number;
    seq: number;
    code: string;
    message: string;
    occurredAt: number;
    createdAt: number;
  };
  ```

- [ ] Add `export * from './documents.js';` to `packages/shared/src/index.ts`.
- [ ] Run the verify command; typecheck, lint and the existing tests pass.
- [ ] Commit `packages/shared/src/documents.ts`, `packages/shared/src/contract.test-d.ts`, `packages/shared/src/index.ts` — subject: `Add the MongoDB document types for events, device state and alerts`

### Task 7: RabbitMQ and MongoDB naming [mechanical]

**Files:** Create `packages/shared/src/topology.ts`, `packages/shared/src/collections.ts`; Modify `packages/shared/src/index.ts`
**Invariant:** 2 — `EVENTS_IDENTITY_INDEX` is the unique dedup index and `DUPLICATE_KEY_ERROR_CODE` the signal the handler treats as "already stored" (consistency spec, decision 9). No unit test: constants are proved against the real database and broker in steps 5 and 7.
**Verify:** `pnpm --filter @telemetry/shared typecheck && pnpm --filter @telemetry/shared lint && pnpm --filter @telemetry/shared test`

- [ ] Write `packages/shared/src/topology.ts`:

  ```ts
  /**
   * RabbitMQ objects (consistency spec, "Queue topology"). Ingest and processing both declare
   * them at startup; a redeclaration with different attributes fails with 406 PRECONDITION_FAILED,
   * so the arguments live here once.
   */
  export const TELEMETRY_EXCHANGE = 'telemetry';
  export const TELEMETRY_ROUTING_KEY = 'event';
  export const TELEMETRY_QUEUE = 'telemetry.events';
  export const DEAD_LETTER_EXCHANGE = 'telemetry.dlx';
  export const DEAD_LETTER_QUEUE = 'telemetry.dead';

  /** Quorum queue, dead-lettered after the fifth delivery attempt (decisions 13 and 19). */
  export const TELEMETRY_QUEUE_ARGUMENTS = {
    'x-queue-type': 'quorum',
    'x-delivery-limit': 5,
    'x-dead-letter-exchange': DEAD_LETTER_EXCHANGE,
  } as const;

  export const DEAD_LETTER_QUEUE_ARGUMENTS = {
    'x-queue-type': 'quorum',
  } as const;

  /** Header set by ingest: integer milliseconds when the message was received (stored as `receivedAt`). */
  export const RECEIVED_AT_HEADER = 'x-received-at';

  export const MESSAGE_CONTENT_TYPE = 'application/json';
  ```

- [ ] Write `packages/shared/src/collections.ts`:

  ```ts
  /** MongoDB names and index definitions (consistency spec, "MongoDB collections and indexes"). */
  export const EVENTS_COLLECTION = 'events';
  export const DEVICE_STATE_COLLECTION = 'device_state';
  export const ALERTS_COLLECTION = 'alerts';

  /** The dedup key (decision 9a), unique. Its prefixes serve per-device and per-session reads. */
  export const EVENTS_IDENTITY_INDEX = { deviceId: 1, sessionId: 1, seq: 1 } as const;
  export const EVENTS_IDENTITY_INDEX_NAME = 'identity_unique';

  /** Server error code of a unique-index violation (`DuplicateKey`); the driver has no named constant. */
  export const DUPLICATE_KEY_ERROR_CODE = 11000;
  ```

- [ ] Add `export * from './topology.js';` and `export * from './collections.js';` to `packages/shared/src/index.ts`.
- [ ] Run the verify command.
- [ ] Commit `packages/shared/src/topology.ts`, `packages/shared/src/collections.ts`, `packages/shared/src/index.ts` — subject: `Add the RabbitMQ topology and MongoDB collection names`

### Task 8: Structured logger [mechanical]

**Files:** Create `packages/shared/src/logger.ts`, `packages/shared/src/logger.test.ts`; Modify `packages/shared/src/index.ts`
**Invariant:** none touched (`CLAUDE.md` logging convention: every log line about a message carries the device id and the message identity — proved by `logger.test.ts`).
**Verify:** `pnpm --filter @telemetry/shared test && pnpm --filter @telemetry/shared typecheck && pnpm --filter @telemetry/shared lint`

- [ ] Write the failing test `packages/shared/src/logger.test.ts`:

  ```ts
  import { describe, expect, it } from 'vitest';

  import { LOG_LEVELS, createLogger, messageLogger } from './logger.js';

  function capture(): { lines: string[]; write(msg: string): void } {
    const lines: string[] = [];
    return {
      lines,
      write(msg: string) {
        lines.push(msg);
      },
    };
  }

  function parseLine(line: string | undefined): Record<string, unknown> {
    return JSON.parse(line ?? '{}') as Record<string, unknown>;
  }

  describe('createLogger', () => {
    it('writes one JSON line with service, hostname, ISO time, level and message', () => {
      const destination = capture();
      const logger = createLogger({ service: 'ingest', level: 'info', destination });
      logger.info({ outcome: 'applied' }, 'stored');
      expect(destination.lines).toHaveLength(1);
      const line = parseLine(destination.lines[0]);
      expect(line).toMatchObject({
        level: 30,
        service: 'ingest',
        msg: 'stored',
        outcome: 'applied',
      });
      expect(typeof line['hostname']).toBe('string');
      expect(line['time']).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
      expect(line).not.toHaveProperty('pid');
    });

    it('drops lines below the configured level', () => {
      const destination = capture();
      const logger = createLogger({ service: 'test', level: 'warn', destination });
      logger.info('hidden');
      logger.debug('hidden');
      logger.warn('shown');
      expect(destination.lines).toHaveLength(1);
      expect(parseLine(destination.lines[0])).toMatchObject({ level: 40, msg: 'shown' });
    });

    it('writes nothing when silent', () => {
      const destination = capture();
      const logger = createLogger({ service: 'test', level: 'silent', destination });
      logger.error('hidden');
      logger.fatal('hidden');
      expect(destination.lines).toHaveLength(0);
    });

    it('lists the accepted levels', () => {
      expect(LOG_LEVELS).toEqual(['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent']);
    });
  });

  describe('messageLogger', () => {
    it('carries deviceId, sessionId and seq as separate fields on every line', () => {
      const destination = capture();
      const logger = createLogger({ service: 'processing', level: 'debug', destination });
      const scoped = messageLogger(logger, {
        deviceId: 'dev-0001',
        sessionId: 1_700_000_000_000,
        seq: 42,
      });
      scoped.warn('older than stored');
      scoped.debug({ outcome: 'stale' }, 'done');
      expect(destination.lines).toHaveLength(2);
      for (const raw of destination.lines) {
        expect(parseLine(raw)).toMatchObject({
          deviceId: 'dev-0001',
          sessionId: 1_700_000_000_000,
          seq: 42,
        });
      }
    });

    it('accepts a partial identity for rejected input', () => {
      const destination = capture();
      const logger = createLogger({ service: 'ingest', level: 'info', destination });
      messageLogger(logger, { deviceId: 'dev-0002' }).warn('rejected');
      const line = parseLine(destination.lines[0]);
      expect(line).toMatchObject({ deviceId: 'dev-0002', msg: 'rejected' });
      expect(line).not.toHaveProperty('sessionId');
      expect(line).not.toHaveProperty('seq');
    });
  });
  ```

- [ ] Run the verify command; the test file must fail because `./logger.js` does not exist yet.
- [ ] Write `packages/shared/src/logger.ts`:

  ```ts
  import { hostname } from 'node:os';

  import { pino, type DestinationStream, type Logger } from 'pino';

  import type { RawIdentity } from './identity.js';

  export type { Logger };

  export const LOG_LEVELS = ['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent'] as const;
  export type LogLevel = (typeof LOG_LEVELS)[number];

  export type CreateLoggerOptions = {
    service: string;
    level: LogLevel;
    /** Where lines go; defaults to stdout. Tests pass an object with `write(msg)`. */
    destination?: DestinationStream;
  };

  /**
   * JSON lines. Every line carries `service` and `hostname` (one per Compose replica) and an
   * ISO-8601 `time`; `pid` is left out because it is meaningless inside a container.
   */
  export function createLogger({ service, level, destination }: CreateLoggerOptions): Logger {
    return pino(
      {
        level,
        base: { service, hostname: hostname() },
        timestamp: pino.stdTimeFunctions.isoTime,
      },
      destination,
    );
  }

  /**
   * A child logger whose every line carries the message identity as separate fields
   * (consistency spec, decision 21). Accepts a partial identity so rejected input can be logged
   * with whatever fields it had. Fields are copied one by one: bindings never take an external object.
   */
  export function messageLogger(logger: Logger, identity: RawIdentity): Logger {
    return logger.child({
      deviceId: identity.deviceId,
      sessionId: identity.sessionId,
      seq: identity.seq,
    });
  }
  ```

- [ ] Add `export * from './logger.js';` to `packages/shared/src/index.ts`.
- [ ] Run the verify command; all tests pass. (pino omits a child binding whose value is `undefined`, verified by a local probe on 10.3.1; the partial-identity test proves it.)
- [ ] Commit `packages/shared/src/logger.ts`, `packages/shared/src/logger.test.ts`, `packages/shared/src/index.ts` — subject: `Add the shared structured logger`

### Task 9: Configuration loader and shared env fragments [integration]

**Files:** Create `packages/shared/src/config.ts`, `packages/shared/src/config.test.ts`; Modify `packages/shared/src/index.ts`
**Invariant:** none touched (`CLAUDE.md` configuration convention: a missing or invalid variable fails fast with a message naming it — proved by `config.test.ts`).
**Verify:** `pnpm --filter @telemetry/shared test && pnpm --filter @telemetry/shared typecheck && pnpm --filter @telemetry/shared lint`

- [ ] Write the failing test `packages/shared/src/config.test.ts`:

  ```ts
  import { describe, expect, it } from 'vitest';
  import { z } from 'zod';

  import {
    ConfigError,
    envInt,
    loadConfig,
    logLevelEnv,
    mongodbEnv,
    rabbitmqEnv,
    shutdownEnv,
  } from './config.js';

  const schema = z.object({ ...logLevelEnv, ...shutdownEnv, ...rabbitmqEnv, ...mongodbEnv });
  const required = { RABBITMQ_URL: 'amqp://rabbitmq:5672', MONGODB_URL: 'mongodb://mongodb:27017' };

  function problemsOf(fn: () => unknown): string[] {
    try {
      fn();
    } catch (error) {
      if (error instanceof ConfigError) {
        return [...error.problems];
      }
      throw error;
    }
    throw new Error('expected a ConfigError');
  }

  describe('loadConfig', () => {
    it('applies defaults to unset and empty variables', () => {
      const config = loadConfig(schema, { ...required, LOG_LEVEL: '', AMQP_HEARTBEAT_S: '' });
      expect(config).toEqual({
        LOG_LEVEL: 'info',
        SHUTDOWN_TIMEOUT_MS: 10_000,
        RABBITMQ_URL: required.RABBITMQ_URL,
        AMQP_HEARTBEAT_S: 10,
        MONGODB_URL: required.MONGODB_URL,
        MONGODB_DB: 'telemetry',
        MONGODB_WRITE_W: 1,
        MONGODB_TIMEOUT_MS: 5_000,
      });
    });

    it('parses integers and the write concern from strings', () => {
      const config = loadConfig(schema, {
        ...required,
        LOG_LEVEL: 'debug',
        AMQP_HEARTBEAT_S: '20',
        MONGODB_WRITE_W: 'majority',
        MONGODB_TIMEOUT_MS: '250',
      });
      expect(config).toMatchObject({
        LOG_LEVEL: 'debug',
        AMQP_HEARTBEAT_S: 20,
        MONGODB_WRITE_W: 'majority',
        MONGODB_TIMEOUT_MS: 250,
      });
      expect(loadConfig(schema, { ...required, MONGODB_WRITE_W: '2' }).MONGODB_WRITE_W).toBe(2);
    });

    it('names a missing required variable', () => {
      const problems = problemsOf(() => loadConfig(schema, { MONGODB_URL: required.MONGODB_URL }));
      expect(problems).toEqual([expect.stringMatching(/^RABBITMQ_URL: /)]);
      expect(() => loadConfig(schema, { MONGODB_URL: required.MONGODB_URL })).toThrow(
        /RABBITMQ_URL/,
      );
    });

    it('names an invalid value', () => {
      expect(
        problemsOf(() => loadConfig(schema, { ...required, AMQP_HEARTBEAT_S: 'abc' })),
      ).toEqual([expect.stringMatching(/^AMQP_HEARTBEAT_S: /)]);
      expect(problemsOf(() => loadConfig(schema, { ...required, AMQP_HEARTBEAT_S: '0' }))).toEqual([
        expect.stringMatching(/^AMQP_HEARTBEAT_S: /),
      ]);
      expect(problemsOf(() => loadConfig(schema, { ...required, MONGODB_WRITE_W: 'abc' }))).toEqual(
        [expect.stringMatching(/^MONGODB_WRITE_W: /)],
      );
      expect(problemsOf(() => loadConfig(schema, { ...required, LOG_LEVEL: 'loud' }))).toEqual([
        expect.stringMatching(/^LOG_LEVEL: /),
      ]);
    });

    it('reports every problem at once', () => {
      const problems = problemsOf(() => loadConfig(schema, { AMQP_HEARTBEAT_S: 'x' }));
      expect(problems).toHaveLength(3);
      expect(problems.join('\n')).toMatch(/RABBITMQ_URL/);
      expect(problems.join('\n')).toMatch(/MONGODB_URL/);
      expect(problems.join('\n')).toMatch(/AMQP_HEARTBEAT_S/);
    });

    it('ignores variables the schema does not declare', () => {
      const config = loadConfig(schema, { ...required, PATH: '/usr/bin', HOME: '/root' });
      expect(config).not.toHaveProperty('PATH');
      expect(config).not.toHaveProperty('HOME');
    });
  });

  describe('envInt', () => {
    it('builds an integer schema with a lower bound and a default', () => {
      const fragment = z.object({ N: envInt(2, 7) });
      expect(loadConfig(fragment, {}).N).toBe(7);
      expect(loadConfig(fragment, { N: '2' }).N).toBe(2);
      expect(problemsOf(() => loadConfig(fragment, { N: '1' }))).toEqual([
        expect.stringMatching(/^N: /),
      ]);
      expect(problemsOf(() => loadConfig(fragment, { N: '2.5' }))).toEqual([
        expect.stringMatching(/^N: /),
      ]);
    });
  });
  ```

- [ ] Run the verify command; the test file must fail because `./config.js` does not exist yet.
- [ ] Write `packages/shared/src/config.ts`:

  ```ts
  import { z } from 'zod';

  import { LOG_LEVELS } from './logger.js';

  /** Thrown by loadConfig; `problems` holds one `NAME: problem` entry per failing variable. */
  export class ConfigError extends Error {
    override readonly name = 'ConfigError';

    constructor(readonly problems: readonly string[]) {
      super(`Invalid configuration: ${problems.join('; ')}`);
    }
  }

  /**
   * Integer variable with a lower bound and a default. The default short-circuits parsing in zod 4,
   * so it is a number (the output type), not a string.
   */
  export function envInt(min: number, defaultValue: number) {
    return z.coerce.number().int().min(min).default(defaultValue);
  }

  /**
   * Validates `env` against `schema` once at startup. A variable set to the empty string counts as
   * unset, so a `.env` copied from `.env.example` gets the defaults. Throws ConfigError naming every
   * missing or invalid variable; the service must let that end the process.
   */
  export function loadConfig<S extends z.ZodType>(
    schema: S,
    env: NodeJS.ProcessEnv = process.env,
  ): z.output<S> {
    const present = Object.fromEntries(
      Object.entries(env).filter(([, value]) => value !== undefined && value !== ''),
    );
    const result = schema.safeParse(present);
    if (result.success) {
      return result.data;
    }
    throw new ConfigError(
      result.error.issues.map(
        (issue) =>
          `${issue.path.length === 0 ? '(root)' : issue.path.map(String).join('.')}: ${issue.message}`,
      ),
    );
  }

  // Fragments shared by more than one service. Each app composes its own schema from these plus
  // its own keys (shared-contract spec, decision 5); every name is documented in .env.example.

  export const logLevelEnv = {
    LOG_LEVEL: z.enum(LOG_LEVELS).default('info'),
  };

  export const shutdownEnv = {
    SHUTDOWN_TIMEOUT_MS: envInt(0, 10_000),
  };

  export const rabbitmqEnv = {
    RABBITMQ_URL: z.string().min(1),
    AMQP_HEARTBEAT_S: envInt(1, 10),
  };

  export const mongodbEnv = {
    MONGODB_URL: z.string().min(1),
    MONGODB_DB: z.string().min(1).default('telemetry'),
    /** `1` on the standalone development database; `majority` on a replica set (decision 20). */
    MONGODB_WRITE_W: z.union([z.literal('majority'), z.coerce.number().int().min(1)]).default(1),
    MONGODB_TIMEOUT_MS: envInt(1, 5_000),
  };
  ```

- [ ] Add `export * from './config.js';` to `packages/shared/src/index.ts`. The final barrel is:

  ```ts
  export { assertNever } from './assert-never.js';
  export * from './message.js';
  export * from './identity.js';
  export * from './framing.js';
  export * from './decode.js';
  export * from './documents.js';
  export * from './topology.js';
  export * from './collections.js';
  export * from './logger.js';
  export * from './config.js';
  ```

- [ ] Run the verify command; all tests pass.
- [ ] Commit `packages/shared/src/config.ts`, `packages/shared/src/config.test.ts`, `packages/shared/src/index.ts` — subject: `Add the environment configuration loader and shared fragments`

### Task 10: Finalise `.env.example` and record the trade-offs [mechanical]

**Files:** Modify `.env.example`, `docs/specs/2026-09-11-telemetry-consistency-design.md`
**Invariant:** none touched
**Verify:** `pnpm format:check && test "$(grep -c '^[A-Z_]*=$' .env.example)" -eq 19 && echo OK`

- [ ] Replace the whole content of `.env.example` with:

  ```
  # Copy to .env for local runs (node --env-file-if-exists=.env …); docker compose sets these for the containers.
  # Every variable is optional unless marked required. An empty value counts as unset: the default applies.
  # Defaults live in packages/shared/src/config.ts (shared keys) and in each service's own config.

  # --- every service ---
  # Log level: trace | debug | info | warn | error | fatal | silent (default info)
  LOG_LEVEL=
  # How long a service waits for in-flight work after SIGTERM, milliseconds (default 10000)
  SHUTDOWN_TIMEOUT_MS=

  # --- RabbitMQ: ingest and processing ---
  # Connection string, required, for example amqp://<user>:<password>@rabbitmq:5672
  RABBITMQ_URL=
  # AMQP heartbeat interval, seconds (default 10)
  AMQP_HEARTBEAT_S=

  # --- MongoDB: processing ---
  # Connection string, required, for example mongodb://mongodb:27017
  MONGODB_URL=
  # Database name (default telemetry)
  MONGODB_DB=
  # Write concern w: 1 on the standalone development database, majority on a replica set (default 1)
  MONGODB_WRITE_W=
  # One timeout for connect, server selection, socket, per-operation maxTimeMS and wtimeoutMS, milliseconds (default 5000)
  MONGODB_TIMEOUT_MS=

  # --- ingest ---
  # Bind address and port of the device socket server (defaults 0.0.0.0 and 4000)
  INGEST_HOST=
  INGEST_PORT=
  # Messages per device connection awaiting a broker confirm before the socket is paused (default 256)
  INGEST_MAX_UNCONFIRMED=
  # A device connection without a message for this long is closed, milliseconds (default 90000)
  INGEST_SOCKET_IDLE_MS=

  # --- processing ---
  # Unacknowledged deliveries per instance, which is also the number of concurrent handlers (default 50)
  PROCESSING_PREFETCH=

  # --- emulator ---
  # Number of emulated devices (default 10)
  EMULATOR_DEVICE_COUNT=
  # Interval between metrics events per device, milliseconds (default 1000)
  EMULATOR_EVENT_INTERVAL_MS=
  # Ingest endpoints, comma-separated host:port; every resolved address is pooled (default ingest:4000)
  INGEST_HOSTS=
  # Messages kept per device while its socket is paused or disconnected; the oldest is dropped when full (default 1000)
  EMULATOR_OUTBOX_MAX=
  # A status heartbeat is sent after this long without another event, milliseconds (default 30000)
  EMULATOR_HEARTBEAT_MS=
  # Fault injection, comma-separated subset of: duplicate, out-of-order, disconnect, restart (default none)
  EMULATOR_CHAOS=
  ```

- [ ] In `docs/specs/2026-09-11-telemetry-consistency-design.md`, section "Trade-offs (running list — TODO item 0.8)", append three rows directly after the row that starts with `| T10 ` (the table's last row). Prettier pads the columns; write the rows unpadded and run `pnpm exec prettier --write docs/specs/2026-09-11-telemetry-consistency-design.md` afterwards:

  ```
  | T11 | NDJSON framing without a length prefix or checksum | A corrupted stream is detected only as invalid JSON and resynchronises at the next newline | Unreliable links, or payloads beyond a few KiB | Length-prefixed frames with a checksum | shared-contract spec, 1 |
  | T12 | zod validation on every message, in ingest and again in processing | CPU per message compared with a compiled JSON Schema validator | Tens of thousands of messages per second per instance | `zod/compile` or ajv behind the same `decodeTelemetryMessage` | shared-contract spec, 2 |
  | T13 | amqplib without automatic recovery | Reconnect, topology re-assertion and re-publish are application code to maintain | More client code to review; never functionally in this scope | rabbitmq-client, or a recovery wrapper around amqplib | shared-contract spec, 10 |
  ```

- [ ] Run the verify command (format check passes and exactly 19 variables have an empty value).
- [ ] Commit `.env.example` and `docs/specs/2026-09-11-telemetry-consistency-design.md` — subject: `Document every environment variable and the step 2 trade-offs`

## Verification Criteria

| #   | Criterion                                                                                                                                 | How to verify                                                                                                                                       |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Each of the four event types has a valid example that parses to an equal, separate copy                                                   | `packages/shared/src/message.test.ts`, the `it.each(TELEMETRY_EVENT_TYPES)` block                                                                   |
| 2   | 23 concrete invalid inputs are rejected with the expected issue code at the expected path; unknown keys are rejected at any level         | `message.test.ts`, the `invalid` table                                                                                                              |
| 3   | `isNewer` follows the consistency spec's rule in six ordered cases and treats an equal key as not newer                                   | `packages/shared/src/identity.test.ts`                                                                                                              |
| 4   | A frame split across chunks, including inside a multi-byte character, decodes correctly; an oversize line throws and the decoder recovers | `packages/shared/src/framing.test.ts`                                                                                                               |
| 5   | Invalid JSON and schema violations return a structured rejection with reason, detail and the parseable identity; nothing throws           | `packages/shared/src/decode.test.ts`                                                                                                                |
| 6   | Storage document types are derived from the schema: one optional section per event type, payload narrowed by type, no `_id` on events     | `pnpm --filter @telemetry/shared typecheck` compiles `contract.test-d.ts`; changing `TELEMETRY_EVENT_TYPES` alone breaks it                         |
| 7   | Log lines are JSON with `service`, `hostname`, ISO `time`; message-scoped lines carry `deviceId`, `sessionId`, `seq`; levels filter       | `packages/shared/src/logger.test.ts`                                                                                                                |
| 8   | A missing or invalid variable throws `ConfigError` naming it; all problems are listed at once; empty means unset                          | `packages/shared/src/config.test.ts`                                                                                                                |
| 9   | `.env.example` lists exactly the 19 variables of the shared-contract spec's configuration table, each with an empty value                 | `grep -c '^[A-Z_]*=$' .env.example` prints `19`; `sed 's/=.*/=<set>/' .env.example` shows no value                                                  |
| 10  | Only two runtime dependencies were added, pinned in the catalog                                                                           | `pnpm ls --filter @telemetry/shared --depth 0` lists `pino 10.3.1` and `zod 4.6.2`; `git diff a852018 -- pnpm-workspace.yaml` shows two added lines |
| 11  | The whole workspace is green                                                                                                              | `pnpm lint && pnpm typecheck && pnpm test && pnpm format:check`                                                                                     |
| 12  | The commit history is ten small imperative commits without assistant attribution                                                          | `git log --format='%s%n%b' a852018..HEAD` shows no `Co-Authored-By` and no mention of Claude or an AI tool                                          |

## Test Plan

- Every task runs `pnpm --filter @telemetry/shared test && pnpm --filter @telemetry/shared typecheck && pnpm --filter @telemetry/shared lint` (Task 1 runs `pnpm install --frozen-lockfile` and `pnpm ls` instead; Task 10 runs the format check and the variable count).
- All tests in this plan are unit tests under `packages/shared/src/*.test.ts`; none needs Docker Compose. The broker and database constants are exercised against the real services in steps 5 and 7.
- `contract.test-d.ts` is verified by `tsc -b` only; it is not part of the Vitest run.
- Full pre-flight at the end: `pnpm lint && pnpm typecheck && pnpm test && pnpm format:check`.
- Expected unit test count after Task 9: 2 (assert-never) + 28 (message) + 11 (identity) + 9 (framing) + 6 (decode) + 6 (logger) + 7 (config) = 69.

## Checkpoint Recovery

If interrupted mid-implementation, resume by:

1. Read this plan and the shared-contract spec.
2. Run `git log --oneline a852018..HEAD` and match the subjects against the task commits above.
3. Run the scoped verify command; if it is red, the current task's files are on disk but not finished — complete that task.
4. Pick up from the first task without a commit. The barrel `packages/shared/src/index.ts` must export every module committed so far.
