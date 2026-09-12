> **STATUS: SHIPPED 2026-09-12.** Landed as 10 commits, `7b27df8..b88abae`. The unchecked `- [ ]` boxes below are historical — the work is done. **Do not re-execute this plan.** If you are changing the shared package, work directly in `packages/shared/src/`; if you are changing the design, work in `docs/specs/`.
>
> **Plan-vs-reality corrections discovered during execution:**
>
> **Library/version drift:** `amqplib` and `mongodb` are still not installed (steps 4 and 5 install them), so the option shapes this plan added could not be checked by `tsc`. They were verified against primary sources instead: the amqplib channel API documents `durable` and `arguments` on `assertQueue`/`assertExchange`, and `mongodb` 7.6.0 `src/operations/indexes.ts` declares `IndexDescription` as `key` plus optional `name` and `unique`, both present in its `VALID_INDEX_OPTIONS`. Test count: this plan predicts 151; the tree ships 202, because every correction below arrived with its own failing-first test.
>
> **Plan code prescriptions that needed adjustment** (each was verified by measurement or by a mutation, not by opinion):
>
> - `logger.ts` (task 2), four defects. Child bindings were never redacted, and the obvious fix does not work: pino installs its own identity formatter on every `.child()` created without an options object (`lib/proto.js:84,98-102`), so `formatters.bindings` reaches the root `base` only — the bindings are redacted at the call site in `childWithIdentity` instead. The walk failed **open** at its depth bound, printing a string five levels deep; it now fails closed at eight. Nothing was guarded against a throw, and pino wraps neither `formatters` nor `serializers` nor `hooks.logMethod`, so a getter that threw escaped the log call. The shutdown comment named `beforeExit`; only `exit` is registered for this destination (`lib/tools.js:276`). Residual, now lint-enforced: a raw `logger.child()` is still unredacted.
> - `identity.ts` (task 3). The plan truncated an oversized `deviceId` to 64 characters. Those first 64 characters can be another device's id, so a sender could make its own rejected frames look like that device's. A non-conforming `deviceId` is dropped instead, which also removes control characters, ANSI escapes and split surrogate pairs in one rule. **Verification criterion 5 below is therefore stale** — the id is dropped, not cut.
> - `framing.ts` (task 4). The plan's chunk-list tail is linear in time but costs one JS `Buffer` object per chunk: 65 536 one-byte pushes held 9.4 MB of heap for 64 KiB of data, trading a CPU denial of service for a memory one. A single buffer that grows by doubling measures 8.3 ms and 0.4 MB. Its capacity is `Math.max(needed, doubled)` rather than a doubling loop, because `Buffer.copy` writes only what fits while the byte count still claims the full length — a short capacity would truncate a line with no error anywhere.
> - `message.ts` (task 5). `seq` had no ceiling, although the poisoning argument behind the `sessionId` window applies to it inside a session; it is capped at `SEQ_MAX`. The comment dated `SESSION_ID_MAX` to 2099-11-26; the value is 2099-12-03. Neither bound named its trade-off, so T18 was added.
> - `decode.ts` (task 6). A device names its own JSON keys and zod quotes an unrecognised one verbatim, so a key containing the `'; '` join token rendered one real issue as two and forged a failure of a field that had validated. The token is removed from each message before joining.
> - `config.ts` (task 7). `envInt`'s swap guard was blind to `NaN`, because every comparison against it is false.
> - `assert-never.ts` (task 9). The planned fallback `String(value)` throws in its own right on a null-prototype object or a hostile `toString`, so a circular _and_ unconvertible value still lost the guard's own message. `Object.prototype.toString.call` is the last resort.
>
> **Plan predictions that were wrong** — a future plan author copying this format should not trust these counts:
>
> - Task 1 edit 28's header reads "replace the whole table row whose first cell is `T10` **with:**" — a replace whose payload is inline, with no `**with:**` block of its own. A parser that classifies by the trailing word treats it as an insert and duplicates the row.
> - Task 1's `replace` anchors carry table padding from a different formatting state; the task text says it ("match the words, not the spaces") and an exact-string matcher fails on edit 3.
> - Task 5 predicted seven failing rows; five failed. `z.int()` already restricts to the safe-integer range, so the two safe-integer rows never were red.
> - Task 6 predicted two failing tests; one failed. V8 never produced a `JSON.parse` message longer than 86 characters across six input shapes, because it truncates the input it quotes — that cap can only be exercised by stubbing the parser.
>
> **Corrections applied during review (commit `7b27df8`):** the trade-off table carried two rows numbered `T10`, the second superseding the first; decision 27 justified itself with `modifiedCount`, which the `findOneAndUpdate` path decision 29 introduced does not return; and the failure row for two instances racing on a new device stated the colliding-upsert conversion as certain, although it is documented for `update` and not for `findAndModify`.
>
> **Deferrals worth tracking** (candidates for the README's "known limits" and for steps 3–7):
>
> - `decode.ts`'s total `detail` is bounded by the issue count, not by a constant — 11 issues and 993 bytes measured for a message with every field wrong and 2 000 junk keys. Re-derive it if the contract ever gains an array or a record field.
> - `INGEST_HOSTS` and `EMULATOR_CHAOS` are comma-separated; whoever writes their zod fragments must trim each entry, not only the whole string.
> - `z.coerce.number()` is `Number()`, so `0x10` reads as 16 and `1e3` as 1000. Documented, not changed.
> - No type-level test pins `telemetryMessageSchema`'s own inferred payload types; `contract.test-d.ts` covers the storage documents only.
> - `decodeTelemetryMessage`'s success branch cannot be shown to return the parsed value rather than the raw input while the schema has no transform.
>
> **Plan history below is preserved as-written for context. Treat the live code as authoritative.**

# Review Fixes Implementation Plan

**Goal:** Apply every finding of the 2026-09-12 code review that concerns what is already built — the two design specs and `packages/shared` — so that steps 3–5 are planned against corrected specs and a shared package that does not leak secrets, drop telemetry or hide a bad index option.
**Approach:** One documentation task records the review's design corrections as decisions 25–29 of the consistency spec (consumer cancel on timeout; three error classes with a pause that returns held deliveries by `basic.nack(requeue=true)`; the device-wide `lastEvent` watermark; the dedup-key invariant with a bounded `sessionId` and a device-id prefix; `findOneAndUpdate` as the state write so the outcome is a function of the previous document) and fixes the wording that described the rejected filter-guard design; nine code tasks then fix the shared package in place, each with its failing test first. Every code block below is the exact file content that passed `pnpm lint && pnpm typecheck && pnpm test` (151 tests) and `pnpm format:check` in the review session; the implementer copies it, does not rewrite it. Task 2 was re-verified on 2026-09-12 after the pino research below removed `flushLogger`: 135 tests at its checkpoint, 151 in the full run. Task 1 also records decision 14 of the shared-contract spec — the argument-style and validation-boundary convention agreed in the 2026-09-12 design discussion — and the matching bullet in `CLAUDE.md`.
**Design spec:** `docs/specs/2026-09-11-telemetry-consistency-design.md` and `docs/specs/2026-09-11-shared-contract-design.md` (both amended by Task 1). The review itself is `.local/reviews/2026-09-12-code-review.md` (gitignored; the coverage table below carries everything from it that this plan needs).
**TODO items:** none new. This plan corrects TODO sections 0 and 2, which stay ticked; the findings it defers are routed to steps 3, 4, 5, 6 and 8 in the coverage table.
**Branch:** `main` (commits go straight to `main`, decided 2026-09-11).
**Scope:** `docs/specs/` (2 files), `CLAUDE.md`, `.env.example`, `packages/shared/src/` (18 files), `eslint.config.js`, `vitest.config.ts`, `package.json`. No file under `apps/` changes; no dependency is added.

## Review coverage

Every finding of the review report and of the plan review, where it lands, and what stays open. `A` = design, `B` = shared code, `C` = tests, `D` = discussion material, `P` = plan-reviewer finding on the first draft of this plan.

| Finding                                                                                                                                           | Substance                                                                                                                                                        | Where it lands                                                                                        |
| ------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| A1 consumer timeout cancels the consumer in RabbitMQ 4.3                                                                                          | abort on cancel, never ack afterwards, re-subscribe                                                                                                              | Task 1: decision 25, processing concurrency paragraph, failure table. Implementation: step 5          |
| A2 error taxonomy, floating handler promise                                                                                                       | three classes, explicit transient set, attempt cap, catch-all, pause                                                                                             | Task 1: decision 26, transient path, `PROCESSING_TRANSIENT_ATTEMPTS`. Implementation: step 5          |
| A3 dedup key reuse: same-millisecond restart, scaled emulator replicas                                                                            | `sessionId = max(Date.now(), previous + 1)`, `EMULATOR_DEVICE_ID_PREFIX`, T14                                                                                    | Task 1: decision 28, device behaviour, `.env.example`. Implementation: step 3                         |
| A4 ingest idle timer during a broker outage                                                                                                       | idle = no bytes received; timer suspended while paused                                                                                                           | Task 1: ingest section. Implementation: step 4                                                        |
| A5 spec says "compare in the filter" twice                                                                                                        | wording                                                                                                                                                          | Task 1                                                                                                |
| A6 `x-received-at` trusted                                                                                                                        | validate, fall back with a warn                                                                                                                                  | Task 1: decision 18, handler step 1. Implementation: step 5                                           |
| A7 `sessionId`, `occurredAt` unbounded                                                                                                            | schema window 2017–2099, `occurredAt ≥ 0`, repair path named                                                                                                     | Task 5 (schema), Task 1 (decision 28)                                                                 |
| A8 no as-of marker, no liveness                                                                                                                   | conditional `lastEvent` watermark, liveness at read time, gap logging                                                                                            | Task 1: decisions 27 and 29, state sketch, pipeline. Task 8: `LastEvent` type. Implementation: step 5 |
| B1 logger leaks passwords through error messages and other keys                                                                                   | `err` serializer, `logMethod` hook, `formatters.log`, `redactUserinfo`                                                                                           | Task 2                                                                                                |
| B2 `await logger.flush()` waits for nothing                                                                                                       | comment corrected, no helper: `flush(cb)` waits for nothing on the default destination either, and pino's exit hook is what writes the last lines                | Task 2                                                                                                |
| B3 unbounded `deviceId` and non-finite numbers on rejected-frame log lines                                                                        | slice to 64, safe integers only                                                                                                                                  | Task 3                                                                                                |
| B4 quadratic frame decoder under a byte drip                                                                                                      | chunk list, one scan per byte                                                                                                                                    | Task 4                                                                                                |
| B5 `FrameTooLongError.frames` is easy to miss                                                                                                     | `push` returns a tagged result, never throws                                                                                                                     | Task 4                                                                                                |
| B6 index and declaration options not in shared                                                                                                    | `EVENTS_IDENTITY_INDEX_SPEC` with `unique: true`, `*_OPTIONS` with `durable: true`                                                                               | Task 8                                                                                                |
| B7 decode detail caps                                                                                                                             | per-issue cap, parser message capped                                                                                                                             | Task 6. `issueCodes` deferred: no consumer yet                                                        |
| B8 config values trimmed only for the emptiness test; effective config not logged                                                                 | parse the trimmed value; startup log sentence in the spec                                                                                                        | Task 7; Task 1 (configuration paragraph). Startup log: steps 3–5                                      |
| B9 `assertNever` throws a `TypeError` on BigInt or circular values                                                                                | try/catch around `JSON.stringify`                                                                                                                                | Task 9                                                                                                |
| B10 tests compiled into `dist/`, `passWithNoTests` at the root, `engines` too wide, ESLint globs                                                  | engines `>=24.10`, ESLint `.mjs/.cjs/.mts/.cts`, `passWithNoTests` scoped to the integration project                                                             | Task 10. The `dist/` split is deferred to step 6 (Dockerfiles), where it matters                      |
| B11 percent fields unbounded                                                                                                                      | `0–100`                                                                                                                                                          | Task 5                                                                                                |
| C1 newline inside a string payload never tested                                                                                                   | round-trip test                                                                                                                                                  | Task 4                                                                                                |
| C2 `dev:0001` never tested                                                                                                                        | rejection case                                                                                                                                                   | Task 5                                                                                                |
| C3 safe-integer ceiling never tested                                                                                                              | rejection cases for `seq` and `sessionId`                                                                                                                        | Task 5                                                                                                |
| C4 `createLogger` without a destination never exercised                                                                                           | deferred: needs a child process to capture stdout; the 2026-09-12 probes did exactly that by hand and are written up in the research section                     | —                                                                                                     |
| C5 secret-leak regression                                                                                                                         | eight call shapes plus a `URL` value                                                                                                                             | Task 2                                                                                                |
| C6 two constant tautologies                                                                                                                       | removed; `LOG_LEVELS` test made behavioural                                                                                                                      | Tasks 2 and 4                                                                                         |
| C7 `contract.test-d.ts` runs only under `tsc -b`                                                                                                  | deferred: `tsc -b` is in the `typecheck` script and the pre-flight; a vitest `typecheck` project can come with step 7                                            | —                                                                                                     |
| D alerts per message vs per condition; lifetime `operationsTotal`; prefetch-window dead-lettering caveat; `telemetry.events` without `max-length` | README material                                                                                                                                                  | Step 8 (README "known limits" and "with more time")                                                   |
| D outbox drops diagnostics first                                                                                                                  | drop the oldest non-diagnostic entry first                                                                                                                       | Task 1: device behaviour. Implementation: step 3                                                      |
| D per-connection unconfirmed window with no instance-wide cap                                                                                     | `INGEST_MAX_UNCONFIRMED_TOTAL`                                                                                                                                   | Task 1: ingest section, `.env.example`. Implementation: step 4                                        |
| D `wtimeoutMS` inert at `w: 1`                                                                                                                    | sentence in decision 24                                                                                                                                          | Task 1                                                                                                |
| D devices without a real-time clock                                                                                                               | rejected loudly by the `sessionId` window; README should say so                                                                                                  | Task 1 (decision 28); step 8                                                                          |
| P1 a client-initiated `basic.cancel` returns nothing                                                                                              | the pause returns held deliveries with `basic.nack(requeue=true)`, which does not count toward the delivery limit in 4.3                                         | Task 1: decision 26, processing paragraph, transient path, "MongoDB down" row                         |
| P2 a value with `toJSON` (a `URL`) bypassed the redaction                                                                                         | the `toJSON` result is redacted (string) or walked (object); a throwing `toJSON` falls through to the property walk; `URL`, nested and throwing regression tests | Task 2                                                                                                |
| P3 gap detection had no named read                                                                                                                | decision 29: `findOneAndUpdate` with `returnDocument: 'before'`; outcome from the returned document and `isNewer`; T16                                           | Task 1                                                                                                |
| P4 `INGEST_MAX_UNCONFIRMED_TOTAL` row sat under processing                                                                                        | moved under ingest in the variable table                                                                                                                         | Task 1                                                                                                |
| P5 verification counts were eyeballed                                                                                                             | hard `test "$(…)" = N` assertions; no raw pipe character inside a table cell                                                                                     | Task 1 verify, criterion 1                                                                            |

One item in Task 1 is not a review finding: decision 14 of the shared-contract spec (argument style and where runtime validation runs) was agreed in the 2026-09-12 design discussion that followed the review. It changes no code — it is the convention steps 3–5 are written against.

## Research (source links)

Everything the shared-contract plan already verified still holds (zod 4.6.2, pino 10.3.1 basics, vitest 4.1.11, Node 24). New for this plan, all read on 2026-09-12:

- [pino — API: `destination`, `pino.destination`, `logger.flush([cb])`, `hooks.logMethod`, `formatters.log`, `serializers`](https://github.com/pinojs/pino/blob/main/docs/api.md) and [Asynchronous Logging](https://github.com/pinojs/pino/blob/main/docs/asynchronous.md) — pino@10.3.1: the default destination is `pino.destination(1)`, a `SonicBoom` with `sync: false` (probe: `sync=false minLength=0`); `flush` "is an asynchronous, best used as fire and forget, operation … If there is a need to wait for the logs to be flushed, a callback should be used" and returns `undefined` (probe) — but that callback waits for nothing on the destination the services actually use, see the next bullet; `hooks.logMethod(args, method, level)` runs before every log method with the raw arguments and is inherited by child loggers (the test in Task 2 proves the child case); `formatters.log` runs on the merging object before the serializers; `serializers.err` replaces the default `stdSerializers.err`, whose result object has a custom prototype and no `toJSON`. Typings: `stdSerializers` and `destination` are named exports of the module, not properties of the named `pino` function (`pino.stdSerializers` is TS2339 in 10.3.1).
- Shutdown and flushing — read in the installed sources (pino 10.3.1, sonic-boom 4.2.1, on-exit-leak-free 2.1.2) and probed on 2026-09-12. A logger with no destination gets `buildSafeSonicBoom({ fd: process.stdout.fd || 1 })` (`pino/lib/tools.js:366`), so `minLength` is 0 and `sync` is false: every line goes straight into an `fs.write`, nothing waits in a user-space buffer. sonic-boom's `flush(cb)` returns immediately when `minLength <= 0` (`sonic-boom/index.js:417`) — the probe saw the callback run synchronously while `_writing` was still `true` — so a promise wrapper around `logger.flush` cannot make a shutdown handler safer. What writes the last lines is the exit hook pino registers for every asynchronous destination on the main thread (`pino/lib/tools.js:276`, `on-exit-leak-free`): `beforeExit` calls `flush()` and ends the stream once it drains, `exit` calls `flushSync()`, which writes the queue with `fs.writeSync` and retries `EAGAIN` until a slow reader catches up (`sonic-boom/index.js:545`). Probe: 2 000 lines, and 500 × 8 KB lines into a reader that sleeps 300 ms, each followed by an immediate `process.exit(0)` — every line arrived, to a file and through a pipe, with no truncation. Residual race, accepted and named in the code: `flushSync` skips the one chunk `fs.write` is already writing, so a forced exit can in principle cut it; `sync: true` would remove the race and make every log call a blocking write.
- pino issue threads behind those mechanisms, read 2026-09-12: [#488 "On demand log flushing?"](https://github.com/pinojs/pino/issues/488) — `pino.destination()` is a [sonic-boom](https://github.com/mcollina/sonic-boom) instance and `flush` is its method; Node turns a redirected stdout into a `net.Socket`, which is why pino writes to the file descriptor itself; the loss reported there was AWS Lambda freezing the process between the write and the flush. [#2326 "sonic boom is not ready yet"](https://github.com/pinojs/pino/issues/2326) (open) reproduces on our pinned versions: a destination opened from a PATH plus an immediate `process.exit(0)` makes pino's own exit hook throw (`sonic-boom/index.js:551`) and the line is lost — probe: empty file, exit code 0, stack trace on stderr. A file destination must therefore never be combined with a forced exit; fd 1 is unaffected because its descriptor is known at construction. This is why Task 2 no longer opens a file destination in `logger.test.ts`. [#1400 "Logging inside process exit event?"](https://github.com/pinojs/pino/issues/1400) — with a `transport` (worker thread) an exit-time log throws "the worker has exited"; one more reason the services log to stdout with no transport and no `pino-pretty`. [#761](https://github.com/pinojs/pino/issues/761) — environments that replace `stdout` (jest, pm2, nodemon, Lambda) break flush-on-exit, and the thread's own advice for tests is to inject a destination object, which is what `capture()` does here. [#1261 "Dropping chars"](https://github.com/pinojs/pino/issues/1261) — truncated and interleaved JSON lines from a BUFFERED stdout destination (`minLength: 4096`), fixed in sonic-boom PR 137: a standing reason not to raise `minLength` on stdout.
- EPIPE, probe 2026-09-12: when the log reader closes the pipe, `buildSafeSonicBoom` replaces `write`, `end`, `flushSync` and `destroy` with no-ops (`pino/lib/tools.js:284-296`); the process survived 30 further log calls with no crash and no output. A silent failure by design — the health of a container cannot be judged from its log stream — documented in the `createLogger` comment.
- `URL.prototype.toJSON` returns `href`, userinfo included (WHATWG URL standard); `Date.prototype.toJSON` returns the ISO string; `Buffer.prototype.toJSON` returns an object. The redaction walk therefore calls `toJSON` and redacts a string result, which is what pino's JSON serialisation would have printed.
- Probe 2026-09-12 against the built package: `logger.error(err)` with `amqp://user:PASS@host` in `err.message` printed the password in `err.message`, `err.stack` and `msg`; `{ url }` under a non-canonical key printed it; only the `RABBITMQ_URL` key was redacted. After Task 2 all eight call shapes and the `URL` value in `logger.test.ts` print `[redacted]@`.
- [amqplib channel API — `consume`, `ack`, `nackAll`](https://amqp-node.github.io/amqplib/channel_api.html) — "If the consumer is cancelled by RabbitMQ, the message callback will be invoked with `null`"; an `ack` of a message that is not outstanding "will break the channel"; `nackAll([requeue])` rejects every outstanding delivery on the channel. [`lib/connect.js`](https://raw.githubusercontent.com/amqp-node/amqplib/main/lib/connect.js) advertises `consumer_cancel_notify: true`.
- [RabbitMQ 4.3 release post](https://www.rabbitmq.com/blog/2026/04/23/rabbitmq-4.3-release) and [Quorum queues](https://www.rabbitmq.com/docs/quorum-queues) — consumer timeout sends `basic.cancel` for the timed-out consumer only when the client advertises `consumer_cancel_notify`; global `consumer_timeout` defaults to 1 800 000 ms; delivery-count table: consumer timeout ❌, `basic.nack` ❌, `basic.reject` ✅, client crash / connection loss ✅, channel termination with pending messages ✅; "it is better to temporarily pause the consumer rather than delaying every message".
- [RabbitMQ Consumers — Cancelling a Consumer](https://www.rabbitmq.com/docs/consumers#unsubscribing) — "Cancelling a consumer will neither discard nor requeue [in-flight deliveries] … To re-queue in-flight deliveries, the application must close the channel." Closing the channel would count each of them as a failed delivery, so the pause in decision 26 returns them with `basic.nack(requeue=true)` instead.
- [MongoDB `db.collection.update()` — Upsert with Duplicate Values, Upsert using an Aggregation Pipeline](https://www.mongodb.com/docs/manual/reference/method/db.collection.update/) — the colliding upsert is retried as an update when the filter is a single equality (or AND of equalities) on the unique index's fields, `multi` is false and the update does not modify those fields; the pipeline base document comes from the equality clauses. [`db.collection.findOneAndUpdate()`](https://www.mongodb.com/docs/manual/reference/method/db.collection.findOneAndUpdate/) — accepts an aggregation pipeline as the update; "Returns the original document by default"; `null` when an upsert inserted; the performance note on retryable writes copying the document into a side collection per replica-set node (decision 29, T16). [Write concern](https://www.mongodb.com/docs/manual/reference/write-concern/) — "`wtimeout` does not apply if `w` is less than or equal to 1".
- Vitest 4.1.11 projects: `passWithNoTests` is a per-project `test` option. Probe 2026-09-12: with the flag only on the integration project, breaking the unit `include` glob makes `pnpm test` exit 1; restoring it exits 0.
- TypeScript 6.0.3 `lib.es2015.core.d.ts`: `Number.isSafeInteger(number: unknown): boolean` — a plain boolean, not a type predicate, so `identity.ts` keeps the `typeof` check in front of it.
- Frame decoder probe 2026-09-12 (built package, 65 536 one-byte pushes): 283 ms before Task 4, 11–13 ms after.

## File Changes

| Action | Path                                                    | Purpose                                                                                                                         |
| ------ | ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Modify | `docs/specs/2026-09-11-telemetry-consistency-design.md` | decisions 25–29, T14–T17, corrected processing/ingest/device sections, `lastEvent` in the pipeline, `findOneAndUpdate` outcomes |
| Modify | `docs/specs/2026-09-11-shared-contract-design.md`       | decision 14, design sections and variable table updated to the code below; T15 and T17                                          |
| Modify | `CLAUDE.md`                                             | the argument-style and validation-boundary convention under "Conventions" (shared-contract spec, decision 14)                   |
| Modify | `.env.example`                                          | `INGEST_MAX_UNCONFIRMED_TOTAL`, `PROCESSING_TRANSIENT_ATTEMPTS`, `EMULATOR_DEVICE_ID_PREFIX` (22 variables)                     |
| Modify | `packages/shared/src/logger.ts`                         | `redactUserinfo`, `err` serializer, `logMethod` hook, `formatters.log`, corrected shutdown and EPIPE comment                    |
| Modify | `packages/shared/src/logger.test.ts`                    | leak regression (8 shapes plus `URL`, nested and throwing `toJSON`), stripped error shape, behavioural level test               |
| Modify | `packages/shared/src/identity.ts`                       | bounded `deviceId`, safe-integer numbers in `extractRawIdentity`                                                                |
| Modify | `packages/shared/src/identity.test.ts`                  | two bound cases                                                                                                                 |
| Modify | `packages/shared/src/framing.ts`                        | `FrameDecodeResult`, chunk-list tail, `FrameTooLongError` without `frames`                                                      |
| Modify | `packages/shared/src/framing.test.ts`                   | result API, escaped-newline round trip, tail-plus-chunk limit, drip cost, tautology removed                                     |
| Modify | `packages/shared/src/message.ts`                        | `SESSION_ID_MIN/MAX`, `PERCENT_MIN/MAX`, `occurredAt ≥ 0`                                                                       |
| Modify | `packages/shared/src/message.test.ts`                   | eight new rejection rows                                                                                                        |
| Modify | `packages/shared/src/decode.ts`                         | per-issue cap, parser message capped                                                                                            |
| Modify | `packages/shared/src/decode.test.ts`                    | two cap tests                                                                                                                   |
| Modify | `packages/shared/src/config.ts`                         | trimmed values are parsed                                                                                                       |
| Modify | `packages/shared/src/config.test.ts`                    | trailing-newline case                                                                                                           |
| Modify | `packages/shared/src/documents.ts`                      | `LastEvent`, `DeviceStateDocument.lastEvent?`                                                                                   |
| Modify | `packages/shared/src/collections.ts`                    | `EVENTS_IDENTITY_INDEX_SPEC`                                                                                                    |
| Modify | `packages/shared/src/topology.ts`                       | `*_EXCHANGE_OPTIONS`, `*_QUEUE_OPTIONS`                                                                                         |
| Modify | `packages/shared/src/contract.test-d.ts`                | `lastEvent` in the shape assertions; literal `true` assertions for `unique` and `durable`                                       |
| Modify | `packages/shared/src/assert-never.ts`                   | serialisation cannot throw                                                                                                      |
| Modify | `packages/shared/src/assert-never.test.ts`              | circular and BigInt cases                                                                                                       |
| Modify | `package.json`                                          | `engines.node` `>=24.10 <25`                                                                                                    |
| Modify | `eslint.config.js`                                      | `.js/.mjs/.cjs` and `.ts/.mts/.cts` globs; `no-console` on scripts too; `max-params` for decision 14                            |
| Modify | `vitest.config.ts`                                      | `passWithNoTests` only on the integration project                                                                               |

## Tasks

### Task 1: Amend the two design specs, `CLAUDE.md` and `.env.example` [mechanical]

**Files:** Modify `docs/specs/2026-09-11-telemetry-consistency-design.md`, `docs/specs/2026-09-11-shared-contract-design.md`, `CLAUDE.md`, `.env.example`
**Invariant:** 1–6 (the consistency spec is their source of truth; this task corrects the text that describes the mechanism enforcing them — no code path changes here)
**Verify:** `pnpm format:check && test "$(grep -c '^[A-Z_]*=$' .env.example)" = 22 && test "$(grep -c '^. 2[5-9] ' docs/specs/2026-09-11-telemetry-consistency-design.md)" = 5 && test "$(grep -c '^. T1[4-6] ' docs/specs/2026-09-11-telemetry-consistency-design.md)" = 3 && test "$(grep -c 'compare in the filter' docs/specs/2026-09-11-telemetry-consistency-design.md)" = 0 && test "$(grep -c '^. 14 ' docs/specs/2026-09-11-shared-contract-design.md)" = 1 && test "$(grep -c 'Runtime validation runs only where data enters a process' CLAUDE.md)" = 1`

The edits below are exact text replacements. Each "replace" names the unique sentence or table cell to find (the tables are Prettier-padded, so match the words, not the spaces) and the text that replaces it; "insert" adds whole rows or bullets. Apply them in the order given — later anchors assume earlier edits. After all edits run `pnpm format` — Prettier re-pads the tables — then the verify command (the `grep` patterns use `.` for the leading table pipe, so no `|` appears in a shell string).

- [ ] Apply the 33 consistency-spec edits and the 23 shared-contract-spec edits listed below.
- [ ] Apply the single `CLAUDE.md` edit listed below.
- [ ] Replace `.env.example` with the content at the end of this task.
- [ ] Run `pnpm format` and the verify command.
- [ ] Commit `docs/specs/2026-09-11-telemetry-consistency-design.md`, `docs/specs/2026-09-11-shared-contract-design.md`, `CLAUDE.md`, `.env.example` — subject: `Amend the design specs after the 2026-09-12 review`

#### Edits to `docs/specs/2026-09-11-telemetry-consistency-design.md`

**1. A5 chosen approach — replace:**

```text
plus one storage rule (compare in the filter)
```

**with:**

```text
plus one storage rule (one conditional pipeline update evaluated by the server)
```

**2. A5 invariants row — replace:**

```text
Device-generated `(sessionId, seq)`; per-section guard in the update filter.
```

**with:**

```text
Device-generated `(sessionId, seq)`; per-section guard inside the conditional pipeline update.
```

**3. decision 13 — replace:**

```text
Trade-off named: an in-place retry is bounded by the broker's consumer acknowledgement timeout (30 minutes by default); after it the channel is closed and the deliveries are requeued, which is the correct outcome for an outage that long.
```

**with:**

```text
Trade-off named: an in-place retry is bounded by the broker's consumer timeout (30 minutes by default); after it the broker returns the deliveries to the queue and cancels the consumer (decision 25), which is the correct outcome for an outage that long — and decision 26 pauses the consumer explicitly well before that, so the timeout is not the normal path. The three error classes are decision 26.
```

**4. decision 18 — replace:**

```text
| Yes, with the same shared schema ingest used.
```

**with:**

```text
| Yes, with the same shared schema ingest used; the `x-received-at` header is validated too (a safe non-negative integer), and a missing or malformed header is replaced by the handler's own clock with a warn log carrying the identity.
```

**5. decisions 25-29 — insert these rows directly after the table row whose first cell is `24`:**

```text
| 25 | What happens when a handler outlives the broker's consumer timeout? | RabbitMQ 4.3 returns the deliveries to the queue and, because amqplib advertises `consumer_cancel_notify`, sends `basic.cancel` for that consumer only; the channel stays open and amqplib invokes the consume callback with `null`. The service treats a cancel exactly like a channel close for its in-flight handlers (abort, never acknowledge) and re-registers the consumer. A timeout does not increment the delivery count, so no message is dead-lettered because of one. | Verified in the 4.3 release notes and the quorum-queue guide. Without this, a stalled handler would acknowledge a returned tag, the 406 would close the channel, every in-flight delivery on it would be requeued with its delivery count incremented ("channel termination with pending messages" counts), and after five such cycles good messages would be dead-lettered — the outcome the failure table promises cannot happen. The instance would also stop consuming silently while readiness still reported the connection as open. Rejected: relying on channel close alone (the pre-4.3 behaviour). |
| 26 | How does the handler classify errors? | Three classes. **Deterministic** (unparsable body, schema violation, malformed `x-received-at`) → `basic.reject(requeue=false)`, dead-lettered. **Transient** (`MongoNetworkError`, `MongoServerSelectionError`, a `MongoServerError` carrying the `RetryableWriteError` label or one of the codes 50 `MaxTimeMSExpired`, 262 `ExceededTimeLimit`, 24 `LockTimeout`, 64 `WriteConcernTimeout`, 10107 `NotWritablePrimary`, 11600 `InterruptedAtShutdown`, 91 `ShutdownInProgress`) → retry in place with backoff; after `PROCESSING_TRANSIENT_ATTEMPTS` (default 5) consecutive failures the instance pauses: it cancels its consumer (no new deliveries), lets the in-flight handlers stop at their abort check, returns every delivery it still holds with `basic.nack(requeue=true)` — a cancel alone neither discards nor requeues in-flight deliveries (consumers guide), and in 4.3 a nack does not increment the delivery count — reports not-ready and re-registers the consumer once the MongoDB ping succeeds. **Permanent** (everything else) → log at error with the identity, `basic.reject(requeue=false)`, dead-lettered. Every dispatched handler is wrapped in a catch-all that can never reject. | "Any other error → transient" made a permanent write failure an unbounded loop that held a prefetch slot, and a floating handler rejection would end the process (Node 24 terminates on an unhandled rejection) and requeue all prefetched deliveries with their count incremented. Pausing the consumer during an outage is what the 4.3 release notes recommend over retrying every delivery. |
| 27 | Does the state document carry a device-wide watermark? | Yes: `lastEvent = { sessionId, seq, type, receivedAt }`, advanced by the same conditional pipeline only when the event is newer than the stored `lastEvent`. It is the reader's "as of" marker (the sections are a per-section latest-value projection, not a point-in-time snapshot), the input for liveness — a reader treats a device as presumed offline when `now - lastEvent.receivedAt` exceeds three times `EMULATOR_HEARTBEAT_MS` — and the reference for gap logging (`seq` skipped a value within one session). | A device whose power is pulled never sends `status: offline`, so without this the state said `online` forever and nothing in the document told the reader when the device was last heard from. The earlier reason for omitting a top-level marker (it would hide the `stale` outcome) holds only for an unconditional field: a conditional one is untouched by a stale message, so `modifiedCount === 0` still identifies `stale`. A message newer than `lastEvent` is newer than every section, so `lastEvent` never moves without its section moving. Rejected: ingest publishing connect/disconnect events (ingest would have to mint identities that are not the device's). |
| 28 | What guarantees the dedup key is never reused? | A contract invariant, now explicit: a device never reuses `(sessionId, seq)` and `sessionId` strictly increases across its sessions. The emulator enforces it with `sessionId = max(Date.now(), previousSessionId + 1)` per device. The schema bounds `sessionId` to 1 500 000 000 000–4 100 000 000 000 (2017–2099, epoch milliseconds), so a clock unit error (seconds, microseconds) or an unset clock is rejected loudly at validation instead of freezing the device's state, and bounds `occurredAt` to ≥ 0. Device ids carry `EMULATOR_DEVICE_ID_PREFIX` (default `dev`); the emulator scales by `EMULATOR_DEVICE_COUNT`, and `--scale emulator=N` needs a distinct prefix per replica (T14). Repair path for a device poisoned by an out-of-range value that slipped through: rebuild its `device_state` document from `events`. | Two restarts within one millisecond reused a `sessionId`, so genuinely new events collided with old ones in the unique index, were logged as duplicates and the state froze; two emulator replicas with the same ids were two physical devices fighting over one document, the higher `sessionId` winning forever. Named residual: a real device without persistence can still reuse a `sessionId` across a sub-millisecond restart (T1). |
| 29 | How does the handler learn the outcome and the previous `lastEvent`? | The state write is `findOneAndUpdate(filter, pipeline, { upsert: true, returnDocument: 'before' })` — same filter, same pipeline, same single-document atomicity — and the handler classifies the outcome from the returned pre-update document with `isNewer`: `null` → `created`; section absent or `isNewer(event, before[T])` → `applied`; otherwise `stale`. The same document carries the previous `lastEvent` for the gap log. | The outcome becomes a pure function of the previous document and the one freshness rule in shared — unit-testable against `isNewer` — instead of the server's modified-count semantics for a no-op `$set`, a detail the design had never verified. Cost named (T16): on a replica set with retryable writes `findAndModify` copies the document into a side collection per node before the update (the manual's own performance note); the document is about 1 KiB. The duplicate-values upsert retry is documented for `update`; for `findAndModify` the handler's own one-shot 11000 retry covers the racing first insert either way. |
```

**6. research consumers — replace:**

```text
delivery acknowledgement timeout (default 30 minutes, quorum queues only since 4.3: the channel is closed and outstanding deliveries requeued)
```

**with:**

```text
delivery acknowledgement timeout (default 30 minutes; quorum queues only since 4.3; the guide's "channel is closed" text describes the fallback — see the 4.3 release post below for the cancel mechanism)
```

**7. research new bullets — replace:**

```text
- [Streams](https://www.rabbitmq.com/docs/streams)
```

**with:**

```text
- [RabbitMQ 4.3 release post — Consumer Timeouts, Support for Unlimited Returns](https://www.rabbitmq.com/blog/2026/04/23/rabbitmq-4.3-release) — "If the client supports the `consumer_cancel_notify` capability (which most modern clients do), the server sends a `basic.cancel` notification to cancel _only_ the timed-out consumer, leaving the channel and other consumers intact. If the client lacks this capability, the server falls back to closing the channel"; global `consumer_timeout` "defaults to 1800000 ms, or 30 minutes"; the delivery-count table: **consumer timeout → `delivery-count` not incremented**, client crash / connection loss and channel termination with pending messages → incremented; "If a consumer cannot process _any_ messages — for example, due to an entire downstream database being offline — it is better to temporarily pause the consumer rather than delaying every message" (decisions 25 and 26).
- [Consumers — Cancelling a Consumer](https://www.rabbitmq.com/docs/consumers#unsubscribing) — "After a consumer is cancelled there will be no future deliveries dispatched to it. Note that there can still be "in flight" deliveries dispatched previously. Cancelling a consumer will neither discard nor requeue them"; the design therefore returns them with `basic.nack(requeue=true)` when it pauses itself (decision 26), never by closing the channel (which would count as a failed delivery for each of them).
- [`db.collection.findOneAndUpdate()`](https://www.mongodb.com/docs/manual/reference/method/db.collection.findOneAndUpdate/) — accepts an aggregation pipeline as the update ("Use an Aggregation Pipeline for Updates"); "Returns the original document by default"; with `upsert: true` and no match it returns `null`; the performance note on retryable writes copying the document into a side collection per replica-set node (decision 29, T16).
- [amqplib channel API — `consume`](https://amqp-node.github.io/amqplib/channel_api.html#channel_consume) — "If the consumer is cancelled by RabbitMQ, the message callback will be invoked with `null`"; [`lib/connect.js`](https://raw.githubusercontent.com/amqp-node/amqplib/main/lib/connect.js) advertises `consumer_cancel_notify: true` in the client capabilities (decision 25). `ack` of a message that is not outstanding "will break the channel".
- [Streams](https://www.rabbitmq.com/docs/streams)
```

**8. device behaviour — replace:**

```text
- Each emulated device has a fixed `deviceId` (`dev-0001` …) and, at process start, `sessionId = Date.now()`; `seq` starts at 1 and increments per message. Restarting the emulator process starts new sessions; sessions are never resumed.
```

**with:**

```text
- Each emulated device has a fixed `deviceId` (`<EMULATOR_DEVICE_ID_PREFIX>-0001` …, default prefix `dev`) and, at every session start, `sessionId = max(Date.now(), previousSessionId + 1)`, so two sessions of one device never share a `sessionId` even when a simulated restart happens within one millisecond (decision 28); `seq` starts at 1 and increments per message. Restarting the emulator process starts new sessions; sessions are never resumed. Scaling the emulator service itself (`--scale emulator=N`) needs a distinct prefix per replica: two replicas with the same ids are two physical devices fighting over one state document (T14).
```

**9. outbox — replace:**

```text
when full, the **oldest** entry is dropped and a warning is logged with the device id and the dropped identity. Newest state is worth more than oldest under absolute values.
```

**with:**

```text
when full, the **oldest non-diagnostic** entry is dropped and a warning is logged with the device id and the dropped identity; diagnostics are dropped only when nothing else is left, because a dropped `error` diagnostic is an alert that is never created. Newest state is worth more than oldest under absolute values.
```

**10. ingest idle — replace:**

```text
A connection idle for `INGEST_SOCKET_IDLE_MS` (default 90 000) is closed.
```

**with:**

```text
A connection that has delivered no bytes for `INGEST_SOCKET_IDLE_MS` (default 90 000) is closed; the idle timer is suspended while the socket is paused for backpressure, so a broker outage (decision 14) never turns into a mass disconnect 90 seconds in.
```

**11. ingest cap — replace:**

```text
Per connection, at most `INGEST_MAX_UNCONFIRMED` (default 256) messages await confirmation; when the window is full the socket is paused and resumed as confirms arrive.
```

**with:**

```text
Per connection, at most `INGEST_MAX_UNCONFIRMED` (default 256) messages await confirmation, and at most `INGEST_MAX_UNCONFIRMED_TOTAL` (default 20 000) per instance; when either window is full the affected sockets (one, or all) are paused and resumed as confirms arrive — without the instance-wide cap the memory bound would grow with the device count.
```

**12. processing concurrency — replace:**

```text
Every handler receives an `AbortSignal` tied to the channel's close event and checks it before each of steps 2–5. Once it has fired the handler stops without acknowledging: its delivery tag is void, because the broker requeued the delivery when the channel closed. An acknowledgement attempted on a closed channel fails client-side; the handler catches that error, logs it at debug with the identity, and ends — nothing is retried on a void tag and nothing crashes.
```

**with:**

```text
Every handler receives an `AbortSignal` that fires when the channel closes **or when the broker cancels the consumer** (amqplib invokes the consume callback with `null`; RabbitMQ 4.3 cancels only the timed-out consumer and leaves the channel open — decision 25) and checks it before each of steps 2–5. Once it has fired the handler stops without acknowledging: its delivery tag is void, because the broker returned the delivery to the queue, and an acknowledgement of an unknown tag is a channel error (406) that would close the channel and requeue every other in-flight delivery with its delivery count incremented. On a broker-initiated cancel the service re-registers the consumer on the same channel; on a close it reconnects. When the service pauses itself (decision 26) the order is: cancel, wait for the handlers to stop at their abort check, `basic.nack(requeue=true)` for everything still held — a client-initiated cancel returns nothing by itself — then re-consume after the ping succeeds. Every dispatched handler is wrapped in a catch-all that can never reject (decision 26). The consumer is registered only after `createIndexes` has resolved, because invariant 2 depends on the unique index existing before the first insert.
```

**13. step 1 — replace:**

```text
1. Parse JSON and validate with the shared schema. On failure: log at warn with the raw identity fields if present, `basic.reject(requeue=false)` → dead-lettered. Done.
```

**with:**

```text
1. Parse JSON and validate with the shared schema; read `x-received-at` as a safe non-negative integer, or use the handler's clock and log at warn (decision 18). On a body failure: log at warn with the raw identity fields if present, `basic.reject(requeue=false)` → dead-lettered. Done.
```

**14. step 2 — replace:**

```text
Duplicate key error 11000 → set `duplicate = true`, log at debug, continue. Any other error → transient path.
```

**with:**

```text
Duplicate key error 11000 → set `duplicate = true`, log at debug, continue. A transient error (decision 26) → transient path; any other error → permanent path.
```

**15. step 3 — replace:**

```text
3. Conditional upsert of the section (see below). Outcome `created | applied | stale`. Continue.
```

**with:**

```text
3. Conditional upsert of the section (see below), which also advances `lastEvent` when the event is newer than it (decision 27). Outcome `created | applied | stale`. If the pre-update document's `lastEvent` (decision 29) had the same `sessionId` and `event.seq > lastEvent.seq + 1`, log a gap at info with both sequence numbers. Continue.
```

**16. transient path — replace:**

```text
Transient path (network error, server selection timeout, operation timeout from MongoDB): retry the whole handler from step 2 with exponential backoff (200 ms → 5 s, jitter) while the delivery stays unacknowledged; log each retry at warn with the attempt number. With all handlers retrying, the prefetch window is full and the broker stops delivering — that is the backpressure.
```

**with:**

```text
Transient path (the error set of decision 26): retry the whole handler from step 2 with exponential backoff (200 ms → 5 s, jitter) while the delivery stays unacknowledged; log each retry at warn with the attempt number. After `PROCESSING_TRANSIENT_ATTEMPTS` consecutive failures of one handler the instance pauses (decision 26): `basic.cancel` stops new deliveries, the in-flight handlers stop at their next abort check, every delivery still held is returned with `basic.nack(requeue=true)` — which in 4.3 does not increment the delivery count — and the instance reports not-ready, pings MongoDB with backoff and re-registers the consumer when the ping succeeds. Permanent path: log at error with the identity and the error, `basic.reject(requeue=false)` → dead-lettered with `x-death` reason `rejected`.
```

**17. retry abort — replace:**

```text
The retry loop checks the `AbortSignal` before every attempt: when the broker closes the channel (consumer acknowledgement timeout, connection loss) the loop stops, because its delivery tag is void and the broker has already requeued the message for another consumer.
```

**with:**

```text
The retry loop checks the `AbortSignal` before every attempt: when the broker cancels the consumer or closes the channel (consumer timeout, connection loss) the loop stops, because its delivery tag is void and the broker has already returned the message to the queue for another consumer.
```

**18. state sketch — replace:**

```text
  _id: 'dev-0001',
  status:     { sessionId, seq, occurredAt, receivedAt, state },
```

**with:**

```text
  _id: 'dev-0001',
  lastEvent:  { sessionId, seq, type, receivedAt },              // device-wide watermark, decision 27
  status:     { sessionId, seq, occurredAt, receivedAt, state },
```

**19. updatedAt paragraph — replace:**

```text
There is deliberately no top-level `updatedAt`: an unconditional field would be modified on every write and hide the `stale` outcome; each section's `receivedAt` says when it last changed.
```

**with:**

```text
There is deliberately no unconditional `updatedAt`: it would be modified on every write and hide the `stale` outcome. `lastEvent` is conditional (decision 27): it moves only when the event is newer than it, so a stale message still leaves the document untouched; it is the reader's "as of" marker, the input for liveness (`now - lastEvent.receivedAt`) and the reference for gap logging.
```

**20. pipeline lastEvent — replace:**

```text
          then: { $literal: next },
          else: `$${T}`,
        },
      },
    },
  },
];
```

**with:**

```text
          then: { $literal: next },
          else: `$${T}`,
        },
      },
      lastEvent: {
        $cond: {
          if: {
            $or: [
              { $eq: [{ $type: '$lastEvent' }, 'missing'] },
              { $lt: ['$lastEvent.sessionId', s] },
              { $and: [{ $eq: ['$lastEvent.sessionId', s] }, { $lt: ['$lastEvent.seq', q] }] },
            ],
          },
          then: { $literal: { sessionId: s, seq: q, type: T, receivedAt } },
          else: '$lastEvent',
        },
      },
    },
  },
];
```

**21. 11000 insurance — replace:**

```text
The `$literal` wrapper around the whole `next` object is required because
```

**with:**

```text
If the update nevertheless reports duplicate key error 11000 — a server that does not retry the colliding insert as an update — the handler runs the same update once more: the document now exists, the filter matches and the `$cond` decides. It is expected never to fire; three lines that take a server detail off the critical path. The `$literal` wrapper around the whole `next` object is required because
```

**22. outcomes — replace:**

```text
Outcomes read from the `UpdateResult`:

- `upsertedCount === 1` → no document for the device existed; created with this section (`created`).
- `modifiedCount === 1` → the section was absent or older; replaced (`applied`).
- `matchedCount === 1 && modifiedCount === 0` → the stored section is newer or has the same key; nothing changed (`stale`; with `duplicate` from step 2 it is a duplicate, otherwise an older message).
```

**with:**

```text
Outcomes read from the document the operation returns — the document as it was before the update (`findOneAndUpdate`, `returnDocument: 'before'`, decision 29):

- `null` → no document for the device existed; created with this section (`created`).
- the section was absent, or `isNewer(event, before[T])` → replaced (`applied`).
- otherwise the stored section is newer or has the same key; nothing changed (`stale`; with `duplicate` from step 2 it is a duplicate, otherwise an older message).

`lastEvent` never moves alone: a message newer than `lastEvent` is newer than every section, so the three outcomes are unchanged by it; the previous `lastEvent` on the same returned document feeds the gap log of step 3.
```

**23. options line — replace:**

```text
options = { upsert: true }; // write concern { w: MONGODB_WRITE_W, journal: true, wtimeoutMS } is set on the client
```

**with:**

```text
options = { upsert: true, returnDocument: 'before' }; // findOneAndUpdate, decision 29; write concern { w: MONGODB_WRITE_W, journal: true, wtimeoutMS } is set on the client
```

**24. config paragraph — replace:**

```text
`INGEST_MAX_UNCONFIRMED`, `INGEST_SOCKET_IDLE_MS`, `PROCESSING_PREFETCH`, `EMULATOR_OUTBOX_MAX`, `EMULATOR_HEARTBEAT_MS`, `EMULATOR_CHAOS`, `INGEST_HOSTS`, `SHUTDOWN_TIMEOUT_MS`, `MONGODB_DB`, `MONGODB_WRITE_W`,
```

**with:**

```text
`INGEST_MAX_UNCONFIRMED`, `INGEST_MAX_UNCONFIRMED_TOTAL` (default 20 000), `INGEST_SOCKET_IDLE_MS`, `PROCESSING_PREFETCH`, `PROCESSING_TRANSIENT_ATTEMPTS` (default 5, decision 26), `EMULATOR_DEVICE_ID_PREFIX` (default `dev`, decision 28), `EMULATOR_OUTBOX_MAX`, `EMULATOR_HEARTBEAT_MS`, `EMULATOR_CHAOS`, `INGEST_HOSTS`, `SHUTDOWN_TIMEOUT_MS`, `MONGODB_DB`, `MONGODB_WRITE_W`,
```

**25. MongoDB down row — replace:**

```text
| Handlers retry in place with backoff; prefetch window fills; the queue accumulates (quorum, on disk); readiness fails. When MongoDB returns, the retries succeed and consumption resumes. Longer than the consumer ack timeout (30 min): the broker closes the channel, requeues, the service reconnects. | No message is acked before its writes are journaled; nothing is dead-lettered because of an outage.
```

**with:**

```text
| Handlers retry in place with backoff; after `PROCESSING_TRANSIENT_ATTEMPTS` consecutive failures the instance pauses (cancel, abort, `basic.nack(requeue=true)` for what it still holds — delivery count unchanged), reports not-ready and re-registers the consumer when the MongoDB ping succeeds; the queue accumulates (quorum, on disk) until the broker's disk alarm blocks publishers, which is the chain that ends in device-side backpressure. A handler that stays stuck past the consumer timeout (30 min) is cancelled by the broker the same way (decision 25). | No message is acked before its writes are journaled; neither a timeout nor a cancel increments the delivery count, so nothing is dead-lettered because of an outage.
```

**26. two live handlers what — replace:**

```text
| The first handler's loop stops at its next abort check; a MongoDB call already in flight completes. The second instance runs the full handler. Both apply idempotent writes; the second one acks.
```

**with:**

```text
| The broker cancels the first consumer (decision 25); the first handler's loop stops at its next abort check and never acknowledges; a MongoDB call already in flight completes. The second instance runs the full handler. Both apply idempotent writes; the second one acks.
```

**27. two live handlers why — replace:**

```text
The step 7 multi-instance test produces the overlap directly (two concurrent handler runs for one delivery, or a forced channel close) instead of waiting for the 30-minute acknowledgement timeout.
```

**with:**

```text
The step 7 multi-instance test produces the overlap directly (two concurrent handler runs for one delivery, or a forced consumer cancel) instead of waiting for the 30-minute consumer timeout.
```

**28. T10 — replace the whole table row whose first cell is `T10` with:**

```text
| T10 | In-place retry during a MongoDB outage holds prefetch slots until the instance pauses its consumer | Zero throughput on that instance until the ping succeeds; a single stuck handler is bounded only by the broker's 30-minute consumer timeout | Outages longer than the timeout, or a handler stuck on one call | A shorter `x-consumer-timeout` on the queue, or a readiness-driven pause before the attempt cap | 13, 25, 26 |
```

**29. T14 T15 T16 T17 — insert these rows directly after the table row whose first cell is `T13`:**

```text
| T14 | The emulator scales by device count, not by replicas | `--scale emulator=N` needs a distinct `EMULATOR_DEVICE_ID_PREFIX` per replica, which one Compose service definition cannot vary | Wanting N emulator containers from one service | Derive the prefix from the container hostname (ids then change on recreate), or one Compose service per emulator group | 28 |
| T15 | The logger rebuilds the merging object of every line to strip URL userinfo | One pass over the log object per line | Tens of thousands of log lines per second per instance | Drop `formatters.log`, keep the `err` serializer and the canonical keys | shared-contract spec, 3 |
| T16 | The state write is `findOneAndUpdate`, not `updateOne` | On a replica set with retryable writes the document is copied into a side collection per node before each update (manual performance note) | Very large state documents or many replica-set members | `updateOne` plus a projected `findOne` of `lastEvent` before it, or drop the gap log | 29 |
| T17 | Log lines are written asynchronously to stdout and no shutdown handler flushes them | `flushSync` in pino's exit hook skips the chunk `fs.write` is already writing, so a forced exit can in principle cut the last line; a log reader that dies silences the service on EPIPE instead of stopping it | An audit that must account for every line, or a crash loop whose last line is the diagnosis | `pino.destination({ fd: 1, sync: true })`, which makes every log call a blocking write | shared-contract spec, 3 |
```

**30. research updateOne note — replace:**

```text
- [`db.collection.updateOne()`](https://www.mongodb.com/docs/manual/reference/method/db.collection.updateOne/) — accepts an aggregation pipeline
```

**with:**

```text
- (Background for the `updateOne` form the design started from; the state write is `findOneAndUpdate` since decision 29, and the outcome no longer comes from an `UpdateResult`.) [`db.collection.updateOne()`](https://www.mongodb.com/docs/manual/reference/method/db.collection.updateOne/) — accepts an aggregation pipeline
```

**31. two live handlers cell — replace:**

```text
| Two live handlers for the same delivery (a slow or retrying handler outlives the consumer acknowledgement timeout; the broker requeues the message to another instance while the first handler is still running) |
```

**with:**

```text
| Two live handlers for the same delivery (a slow or retrying handler outlives the consumer timeout; RabbitMQ cancels that consumer and returns the message to the queue for another instance while the first handler is still running) |
```

**32. startup config log — replace:**

```text
Exact names are confirmed in the step 2 spec; defaults above are the design's.
```

**with:**

```text
Every service logs its effective configuration at startup with the two connection strings left out, so an accidentally empty value in a deployment (for example `MONGODB_WRITE_W` silently falling back to `1` on a replica set) is visible in the first log line instead of during an incident. Exact names are confirmed in the step 2 spec; defaults above are the design's.
```

**33. wtimeout note — replace:**

```text
`socketTimeoutMS` defaults to 0 (never), so "every MongoDB operation has a timeout" is not true without explicit settings.
```

**with:**

```text
`socketTimeoutMS` defaults to 0 (never), so "every MongoDB operation has a timeout" is not true without explicit settings. `wtimeoutMS` applies only when `w` is greater than 1 (write-concern manual), so on the standalone development database it is inert and `maxTimeMS` plus `socketTimeoutMS` are what bound a write; it becomes active with `MONGODB_WRITE_W=majority`.
```

#### Edits to `docs/specs/2026-09-11-shared-contract-design.md`

**1. decision 1 — replace:**

```text
the decoder throws `FrameTooLongError`, resets, and ingest closes that connection
```

**with:**

```text
the decoder returns `ok: false` with a `FrameTooLongError` (it never throws), resets, and ingest closes that connection
```

**2. decision 2 — replace:**

```text
`z.number()` rejects `NaN` and `±Infinity`, and `z.infer` derives
```

**with:**

```text
`z.number()` rejects `NaN` and `±Infinity`, `sessionId` is bounded to a plausible epoch-millisecond window and the percent fields to 0–100 (consistency spec, decision 28), and `z.infer` derives
```

**3. decision 3 — replace:**

```text
No `pino-pretty` dependency.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
```

**with:**

```text
No `pino-pretty` dependency. Connection-string passwords are stripped from every line — an `err` serializer, a `logMethod` hook and a `formatters.log` pass all run `redactUserinfo` — because the path-based `redact` cannot reach a URL inside an error message (trade-off T15). A shutdown handler needs no flush call: with `minLength: 0` the default destination keeps nothing in a user-space buffer and pino's own exit hook writes the queue synchronously (trade-off T17). |
```

**4. decision 4 — replace:**

```text
`loadConfig(schema, env)` drops variables whose value is the empty string (so a `.env` copied from `.env.example` with empty values gets the defaults), parses the rest,
```

**with:**

```text
`loadConfig(schema, env)` trims every value and drops the ones that are then empty (so a `.env` copied from `.env.example` with empty values gets the defaults, and a trailing newline from a mounted secret never reaches a driver), parses the rest,
```

**5. decision 7 — replace:**

```text
Shared exports `DeviceStateDocument`, `EventDocument` and `AlertDocument` (the consistency spec's document sketches as types), derived from the payload types of the schema.
```

**with:**

```text
Shared exports `DeviceStateDocument` (with the device-wide `lastEvent` watermark, consistency spec decision 27), `EventDocument` and `AlertDocument` (the consistency spec's document sketches as types), derived from the payload types of the schema.
```

**6. decision 8 — replace:**

```text
Shared exports the exchange, queue and routing-key names **and** the queue arguments as `as const` objects (`x-queue-type`, `x-delivery-limit`, `x-dead-letter-exchange`), plus the `x-received-at` header name and the content type.
```

**with:**

```text
Shared exports the exchange, queue and routing-key names **and** the complete declaration options as `as const` objects — `durable: true` and the queue arguments (`x-queue-type`, `x-delivery-limit`, `x-dead-letter-exchange`) — plus the `x-received-at` header name and the content type; for MongoDB the complete index description with `unique: true`, so the one option invariant 2 depends on is defined once.
```

**7. decision 12 — replace:**

```text
`EMULATOR_DEVICE_COUNT` default 10, `EMULATOR_EVENT_INTERVAL_MS` default 1 000.
```

**with:**

```text
`EMULATOR_DEVICE_COUNT` default 10, `EMULATOR_DEVICE_ID_PREFIX` default `dev` (consistency spec, decision 28), `EMULATOR_EVENT_INTERVAL_MS` default 1 000.
```

**8. research pino — insert these two bullets directly after the line that starts with `- pino 10.3.1 type definitions`:**

```text
- [pino — API: `destination`, `pino.destination`, `logger.flush([cb])`, `hooks.logMethod`, `formatters.log`, `serializers`](https://github.com/pinojs/pino/blob/main/docs/api.md) and [Asynchronous Logging](https://github.com/pinojs/pino/blob/main/docs/asynchronous.md) (read 2026-09-12 for 10.3.1) — the default destination is `pino.destination(1)`, a `SonicBoom` with `sync: false` (probe: `sync=false minLength=0`), so lines are buffered; `flush` "is an asynchronous, best used as fire and forget, operation … If there is a need to wait for the logs to be flushed, a callback should be used" and returns `undefined` (probe); with the default destination that callback waits for nothing at all (below); `hooks.logMethod(args, method, level)` runs before every log method with the raw arguments; `formatters.log` runs on the merging object before the serializers; `serializers.err` replaces the default error serializer (`stdSerializers.err`, whose result has a custom prototype and no `toJSON`). Probe 2026-09-12: `logger.error(err)` with a connection string in `err.message` printed the password in `err.message`, `err.stack` and `msg` before the change; `{ url }` under a non-canonical key printed it too.
- Shutdown, read in the installed sources and probed on 2026-09-12 (pino 10.3.1, sonic-boom 4.2.1, on-exit-leak-free 2.1.2): a logger with no destination gets `buildSafeSonicBoom({ fd: process.stdout.fd || 1 })` (`pino/lib/tools.js:366`), so `minLength` is 0 and each line goes straight into an `fs.write`. sonic-boom returns from `flush(cb)` immediately when `minLength <= 0` (`sonic-boom/index.js:417`), calling the callback while the write is still in flight, so no promise wrapper around `flush` can make shutdown safer. The exit hook pino registers for an asynchronous destination (`pino/lib/tools.js:276`, `on-exit-leak-free`) is what writes the last lines: `beforeExit` flushes and ends the stream, `exit` calls `flushSync`, which writes the queue with `fs.writeSync` and retries `EAGAIN`. Probe: 2 000 lines, and 500 × 8 KB lines into a reader sleeping 300 ms, each followed by an immediate `process.exit(0)` — nothing lost to a file or through a pipe. Open issue [pinojs/pino#2326](https://github.com/pinojs/pino/issues/2326) reproduces on these versions for a destination opened from a PATH: the same hook throws "sonic boom is not ready yet" and the line is lost, so a file destination and a forced exit must not be combined. On EPIPE pino turns `write`, `end`, `flushSync` and `destroy` into no-ops (`pino/lib/tools.js:284-296`): a dead log reader silences a service instead of stopping it.
```

**9. message contract — replace:**

```text
`sessionId` and `seq` are safe integers ≥ 1; `occurredAt` is a safe integer;
```

**with:**

```text
`sessionId` is a safe integer between `SESSION_ID_MIN` (1 500 000 000 000) and `SESSION_ID_MAX` (4 100 000 000 000, consistency spec decision 28), `seq` a safe integer ≥ 1, `occurredAt` a safe integer ≥ 0;
```

**10. message percent — replace:**

```text
numbers are finite; `counters` values are integers ≥ 0;
```

**with:**

```text
numbers are finite; `cpuPercent` and `ramPercent` are between `PERCENT_MIN` (0) and `PERCENT_MAX` (100); `counters` values are integers ≥ 0;
```

**11. identity — replace:**

```text
`extractRawIdentity(value)` returns the subset of the three fields present on an unvalidated value with the right primitive type, for log lines about rejected input.
```

**with:**

```text
`extractRawIdentity(value)` returns the subset of the three fields present on an unvalidated value with the right primitive type — `deviceId` cut to `DEVICE_ID_MAX_LENGTH`, the numbers only when they are safe integers — for log lines about rejected input, which a device must not be able to inflate.
```

**12. framing — replace:**

```text
`push` throws `FrameTooLongError { bytes, limit }` when a complete line, or the buffered tail, exceeds `maxFrameBytes` (constructor argument, default `MAX_FRAME_BYTES` = 65 536) and clears its buffer first. Ingest always closes the connection on this error (decision 1); the cleared buffer only means the decoder instance is not left in a broken state, which the unit test checks.
```

**with:**

```text
`push(chunk)` never throws: it returns `{ ok: true, frames }`, or `{ ok: false, frames, error: FrameTooLongError { bytes, limit } }` when a complete line, or the buffered tail, exceeds `maxFrameBytes` (constructor argument, default `MAX_FRAME_BYTES` = 65 536), with the buffer cleared and the rest of that chunk unread; `frames` is on both branches so the lines decoded before the oversized one cannot be dropped by accident. The tail is kept as the list of chunks it arrived in and each `push` scans only its own chunk, so the cost is one copy and one scan per byte however the bytes are split (a one-byte drip up to the limit costs ~13 ms, not the ~280 ms of re-copying the tail on every push). Ingest closes the connection on `ok: false` (decision 1).
```

**13. decoding — replace:**

```text
`detail` is the `JSON.parse` error message, or every zod issue as `path: message` joined by `; ` (`(root)` for an empty path).
```

**with:**

```text
`detail` is the `JSON.parse` error message, or every zod issue as `path: message` joined by `; ` (`(root)` for an empty path); each message is capped at 200 characters, so the path of every failing field survives however long one message is, and the parser message gets the same cap.
```

**14. documents — replace:**

```text
type DeviceStateDocument = {
  _id: string; // deviceId
  status?: DeviceStateSection<'status'>;
```

**with:**

```text
type LastEvent = { sessionId: number; seq: number; type: TelemetryEventType; receivedAt: number };
type DeviceStateDocument = {
  _id: string; // deviceId
  lastEvent?: LastEvent; // device-wide watermark, consistency spec decision 27
  status?: DeviceStateSection<'status'>;
```

**15. naming table — replace:**

```text
| `EVENTS_IDENTITY_INDEX`       | `{ deviceId: 1, sessionId: 1, seq: 1 }`, unique, named `identity_unique` (`EVENTS_IDENTITY_INDEX_NAME`) |
```

**with:**

```text
| `EVENTS_IDENTITY_INDEX`       | `{ deviceId: 1, sessionId: 1, seq: 1 }`, unique, named `identity_unique` (`EVENTS_IDENTITY_INDEX_NAME`) |
| `EVENTS_IDENTITY_INDEX_SPEC`  | `{ key: EVENTS_IDENTITY_INDEX, name: 'identity_unique', unique: true }`, the whole `createIndexes` entry |
| `TELEMETRY_EXCHANGE_OPTIONS`  | `{ durable: true }`                                                                                     |
| `DEAD_LETTER_EXCHANGE_OPTIONS` | `{ durable: true }`                                                                                    |
| `TELEMETRY_QUEUE_OPTIONS`     | `{ durable: true, arguments: TELEMETRY_QUEUE_ARGUMENTS }`                                               |
| `DEAD_LETTER_QUEUE_OPTIONS`   | `{ durable: true, arguments: DEAD_LETTER_QUEUE_ARGUMENTS }`                                             |
```

**16. logging — replace:**

```text
`createLogger({ service, level, destination? })` returns a pino `Logger` with `base: { service, hostname }` and ISO time; `destination` is for tests. `messageLogger(logger, identity: RawIdentity)` returns `logger.child({ deviceId, sessionId, seq })` — a `RawIdentity` so that a rejected frame can still be logged with whatever fields it had. The `Logger` type is re-exported so that no service imports pino directly.
```

**with:**

```text
`createLogger({ service, level, destination? })` returns a pino `Logger` with `base: { service, hostname }` and ISO time; `destination` is for tests. Three mechanisms strip `scheme://user:password@` from every line, because the path-based `redact` (`RABBITMQ_URL`, `MONGODB_URL`) cannot reach a URL inside a string: `serializers.err` runs the standard error serializer and then `redactUserinfo` over its `message`, `stack` and nested fields; `hooks.logMethod` strips every string argument and gives a bare error an explicit stripped message (pino would otherwise copy `err.message` into `msg` before any serializer runs); `formatters.log` walks the merging object (plain objects and arrays, four levels deep; an `Error` is left to the serializer; a value with its own `toJSON` is serialised through it and the result redacted when it is a string — a `URL` prints its whole `href`, userinfo included) for a connection string under any other key. `redactUserinfo(text)` is exported for callers that build their own strings. `messageLogger(logger, identity: MessageIdentity)` returns `logger.child({ deviceId, sessionId, seq })` for validated messages; `rejectedMessageLogger(logger, identity: RawIdentity)` the same for a rejected frame with whatever fields it had. Nothing wraps `flush`: on the default destination (`minLength: 0`) `flush(cb)` calls back while the write is still in flight, and the exit hook pino registers writes the queue with `flushSync` when the process exits, so a shutdown handler may log its last line and exit (trade-off T17). The `Logger` type is re-exported so that no service imports pino directly.
```

**17. config table processing — replace:**

```text
| `PROCESSING_PREFETCH`        | processing         | `50`          | integer 1–2000 (quorum-queue cap)                                     | processing (step 5)  |
```

**with:**

```text
| `PROCESSING_PREFETCH`        | processing         | `50`          | integer 1–2000 (quorum-queue cap)                                     | processing (step 5)  |
| `PROCESSING_TRANSIENT_ATTEMPTS` | processing      | `5`           | integer ≥ 1; consecutive transient failures before the consumer pauses (consistency spec, decision 26) | processing (step 5)  |
```

**18. config table ingest — replace:**

```text
| `INGEST_SOCKET_IDLE_MS`      | ingest             | `90000`       | integer ≥ 1                                                           | ingest (step 4)      |
```

**with:**

```text
| `INGEST_SOCKET_IDLE_MS`      | ingest             | `90000`       | integer ≥ 1                                                           | ingest (step 4)      |
| `INGEST_MAX_UNCONFIRMED_TOTAL` | ingest           | `20000`       | integer ≥ 1; unconfirmed messages per instance before every socket pauses | ingest (step 4)      |
```

**19. config table emulator — replace:**

```text
| `EMULATOR_DEVICE_COUNT`      | emulator           | `10`          | integer ≥ 1                                                           | emulator (step 3)    |
```

**with:**

```text
| `EMULATOR_DEVICE_COUNT`      | emulator           | `10`          | integer ≥ 1                                                           | emulator (step 3)    |
| `EMULATOR_DEVICE_ID_PREFIX`  | emulator           | `dev`         | 1–32 chars of `[A-Za-z0-9_]`, ids are `<prefix>-0001` …; distinct per emulator replica (consistency spec, decision 28) | emulator (step 3)    |
```

**20. failure table framing — replace:**

```text
| Line longer than `MAX_FRAME_BYTES`                          | `FrameDecoder.push` throws `FrameTooLongError`, buffer cleared; ingest logs and closes the connection.                                  |
```

**with:**

```text
| Line longer than `MAX_FRAME_BYTES`                          | `FrameDecoder.push` returns `ok: false` with the error and the frames decoded before it, buffer cleared; ingest logs and closes the connection. |
```

**21. T15 T17 — replace:**

```text
| T13 | amqplib without automatic recovery                                 | Reconnect, topology re-assertion and re-publish are application code to maintain           | More client code to review; never functionally in this scope | rabbitmq-client, or a recovery wrapper around amqplib         | 10       |
```

**with:**

```text
| T13 | amqplib without automatic recovery                                 | Reconnect, topology re-assertion and re-publish are application code to maintain           | More client code to review; never functionally in this scope | rabbitmq-client, or a recovery wrapper around amqplib         | 10       |
| T15 | The logger rebuilds the merging object of every line to strip URL userinfo | One pass over the log object per line | Tens of thousands of log lines per second per instance | Drop `formatters.log`, keep the `err` serializer and the canonical keys | 3 |
| T17 | Log lines are written asynchronously to stdout and no shutdown handler flushes them | `flushSync` in pino's exit hook skips the chunk `fs.write` is already writing, so a forced exit can in principle cut the last line; a log reader that dies silences the service on EPIPE instead of stopping it | An audit that must account for every line, or a crash loop whose last line is the diagnosis | `pino.destination({ fd: 1, sync: true })`, which makes every log call a blocking write | 3 |
```

**22. trade-off intro — replace:**

```text
Rows T11–T13 are appended to the consistency spec's running list by the plan (task 10).
```

**with:**

```text
Rows T11–T13 were appended to the consistency spec's running list by the shared-contract plan (task 10); T15 and T17 by the review-fixes plan of 2026-09-12 (T14 and T16 belong to the consistency spec's own decisions 28 and 29).
```

**23. decision 14 — insert this row directly after the table row whose first cell is `13`:**

```text
| 14  | Argument style, and where runtime validation runs | Function arguments are positional by default. A single named object (a parameter object) is used when a function takes three or more arguments, or two or more arguments of the same type — `createLogger({ service, level, destination })` is the existing example. Argument and return types are derived from the message schema (`z.infer`, `Pick<>`, `.extend()` on a payload schema), never redeclared; no second schema is written for a shape the message schema already describes. Runtime validation runs only where data enters a process from outside the type system: socket frames (`decodeTelemetryMessage`), environment variables (`loadConfig`), the emulator's command-line arguments (step 3), the AMQP body and the `x-received-at` header (consistency spec, decision 18), and a MongoDB read that a branch or a test assertion depends on. Inside a process no function re-validates a value the compiler already typed. The argument rule binds new code; `max-params: ['error', 2]` in `eslint.config.js` enforces the "three or more" half of it (task 10), and the three existing signatures that keep positional same-typed arguments are named opposite. | Two independent choices hide under the word "DTO", and only the first is a style question. A parameter object makes the call site self-documenting and two same-typed arguments unswappable; below three arguments it is noise, and `isNewer(candidate, stored)` stays positional on purpose — it is the comparator idiom, and the swap that would matter lives in the MongoDB pipeline mirroring it, where a parameter object cannot help. Two further signatures keep positional same-typed arguments, each for a reason: `envInt(min, defaultValue)` is protected completely by its own import-time guard — the guard enforces `defaultValue >= min`, so any swap that changes behaviour makes the new default smaller than the new minimum and throws when the module is imported — and `FrameTooLongError(bytes, limit)` only formats an error message, where a swap costs a wrong number in one log line and no invariant, and positional arguments are the idiom for an Error constructor. Those three are the complete list in `packages/shared` after this plan; `max-params` catches the rest mechanically. Runtime validation inside a process is an assertion written expensively: `eslint.config.js` extends `recommendedTypeChecked`, which sets `no-explicit-any` and six `no-unsafe-*` rules to error, so a value typed `TelemetryMessage` can only be malformed if it entered through a cast or an untyped library return — that is, at one of the boundaries above. A third `safeParse` per message would add to the cost already named in T12 and buy nothing measurable. Rejected: validating at internal call sites (no failure mode it prevents that the linter does not, and unmotivated ceremony reads as over-engineering); a separate DTO schema per service (a second source of truth that drifts, against the "types derived from the schema" rule). Named residual: the guarantee rests on the no-`any` rules, so an `eslint-disable` at a library boundary reopens the hole and the error then surfaces far from its cause. Derivation gotcha, verified in the pinned declarations: in zod 4.6.2 `ZodObject` has `.pick`, `.omit` and `.extend`, but `ZodDiscriminatedUnion` has none of them, so a subset of `telemetryMessageSchema` is derived at the type level (`Pick<>`, as `MessageIdentity` does) or built from `envelopeShape` plus a payload schema. |
```

#### Edit to `CLAUDE.md`

**1. Conventions — insert this bullet directly after the bullet that starts with `- **Strict TypeScript everywhere.**`:**

```text
- **Arguments and validation boundaries:** positional arguments by default; a single named object when a function takes three or more arguments, or two or more of the same type. Runtime validation runs only where data enters a process from outside the type system — socket frames, env vars, CLI arguments, the AMQP body and its headers, and a MongoDB read a branch or an assertion depends on. Inside a process, `strict: true` and the `no-unsafe-*` lint rules are the guarantee; a `parse()` there can only fail on a programmer error (shared-contract spec, decision 14).
```

#### `.env.example` (whole file)

```text
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
# Unconfirmed messages per ingest instance before every device socket is paused (default 20000)
INGEST_MAX_UNCONFIRMED_TOTAL=
# A device connection without a message for this long is closed, milliseconds (default 90000)
INGEST_SOCKET_IDLE_MS=

# --- processing ---
# Unacknowledged deliveries per instance, which is also the number of concurrent handlers (default 50)
PROCESSING_PREFETCH=
# Consecutive transient MongoDB failures of one handler before the instance pauses its consumer (default 5)
PROCESSING_TRANSIENT_ATTEMPTS=

# --- emulator ---
# Number of emulated devices (default 10)
EMULATOR_DEVICE_COUNT=
# Prefix of the generated device ids, <prefix>-0001 …; must differ per emulator replica (default dev)
EMULATOR_DEVICE_ID_PREFIX=
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

### Task 2: Strip connection-string passwords from every log line and document the shutdown path [integration]

**Files:** Modify `packages/shared/src/logger.ts`, Test `packages/shared/src/logger.test.ts`
**Invariant:** none of 1–6 directly; upholds the `CLAUDE.md` rule "no secrets in code or logs" (review B1, plan review P2) and gives steps 3–5 a shutdown rule that is true (B2)
**Verify:** `pnpm --filter @telemetry/shared test && pnpm --filter @telemetry/shared typecheck && pnpm --filter @telemetry/shared lint`

pino's path-based `redact` only sees object keys. The first error every service logs — a driver's `connect ECONNREFUSED amqp://user:pass@host` — reaches the line through `err.message`, `err.stack` and the `msg` field pino copies an error message into, and a connection string under any other key (`{ url }`) or inside a `URL` value (whose `toJSON` returns the whole `href`) is printed as-is. Three mechanisms close that: an `err` serializer that strips userinfo from the standard serializer's output, a `logMethod` hook that strips every string argument and gives a bare error an explicit stripped message (pino copies `err.message` into `msg` before any serializer runs), and a `formatters.log` walk over plain objects and arrays that serialises `toJSON` values the way JSON would, redacts a string result, walks an object result, and walks the value itself when `toJSON` throws. Review finding B2 is real but its proposed fix was not: `await logger.flush()` does await `undefined`, and a promise wrapper around the callback would not help either, because sonic-boom returns from `flush(cb)` immediately whenever `minLength <= 0` — which is the case for pino's default stdout destination (`sonic-boom/index.js:417`, probe 2026-09-12: the callback ran synchronously while the write was still in flight). The last lines are written by the exit hook pino registers for an asynchronous destination (`beforeExit` flushes and ends, `exit` calls `flushSync` with an `EAGAIN` retry), which probes confirmed for 2 000 lines and for 500 × 8 KB lines into a slow pipe reader, to a file and through a pipe. So this task adds no helper: it records that mechanism, its one accepted race and the EPIPE silence in the `createLogger` comment (research section, trade-off T17).

- [ ] Replace `logger.test.ts` with the content below. Run the verify command: the file fails to import `redactUserinfo`; against the old logger every `never prints the password` case and the `URL` case would print the password (probe 2026-09-12).
- [ ] Replace `logger.ts` with the content below. Run the verify command: green — 135 tests at this checkpoint (31 logger tests plus the 104 tests of the files Tasks 3–9 have not touched yet); verified 2026-09-12 on this exact content, together with `typecheck`, `lint` and `format:check`.
- [ ] Read the header comment of `createLogger` once more — it is the contract steps 3–5 copy into their shutdown handlers: log the last line, then exit; never wrap `flush` in a promise, and never point the logger at a file path in a service that force-exits (pinojs/pino#2326).
- [ ] Commit — subject: `Strip connection-string passwords from every log line`

#### `packages/shared/src/logger.test.ts` (whole file)

```ts
import { describe, expect, it } from 'vitest';

import {
  LOG_LEVELS,
  createLogger,
  messageLogger,
  redactUserinfo,
  rejectedMessageLogger,
} from './logger.js';

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

  it.each(LOG_LEVELS)('accepts %s as a level and reports what it enables', (level) => {
    const logger = createLogger({ service: 'test', level, destination: capture() });
    expect(logger.level).toBe(level);
    // `silent` enables nothing; every other level enables at least `fatal`.
    expect(logger.isLevelEnabled('fatal')).toBe(level !== 'silent');
  });
});

describe('redactUserinfo', () => {
  it('replaces the userinfo of every URL and keeps the rest of the text', () => {
    expect(
      redactUserinfo(
        'connect ECONNREFUSED amqp://user:p%40ss@rabbitmq:5672/vhost and mongodb+srv://u:p@a.example,b.example/db?x=1',
      ),
    ).toBe(
      'connect ECONNREFUSED amqp://[redacted]@rabbitmq:5672/vhost and mongodb+srv://[redacted]@a.example,b.example/db?x=1',
    );
  });

  it('leaves a URL without userinfo unchanged', () => {
    expect(redactUserinfo('amqp://rabbitmq:5672 mongodb://mongodb:27017/telemetry')).toBe(
      'amqp://rabbitmq:5672 mongodb://mongodb:27017/telemetry',
    );
  });
});

describe('createLogger password redaction beyond the canonical keys', () => {
  // amqplib and the MongoDB driver embed the connection string in their error messages, so this
  // is the first thing every service will log against a broker or database that is down.
  const secret = 'SECRETPASS';
  const url = `amqp://user:${secret}@rabbitmq:5672`;

  function lines(log: (logger: ReturnType<typeof createLogger>) => void): string[] {
    const destination = capture();
    log(createLogger({ service: 'ingest', level: 'info', destination }));
    return destination.lines;
  }

  it.each([
    {
      name: 'a bare error',
      log: (l: ReturnType<typeof createLogger>) =>
        l.error(new Error(`connect ECONNREFUSED ${url}`)),
    },
    {
      name: 'an error under err without a message',
      log: (l: ReturnType<typeof createLogger>) => l.error({ err: new Error(`connect ${url}`) }),
    },
    {
      name: 'an error under err with a message',
      log: (l: ReturnType<typeof createLogger>) =>
        l.error({ err: new Error(`connect ${url}`) }, 'connect failed'),
    },
    {
      name: 'a string message',
      log: (l: ReturnType<typeof createLogger>) => l.warn(`retrying ${url}`),
    },
    {
      name: 'a format argument',
      log: (l: ReturnType<typeof createLogger>) => l.warn('retrying %s', url),
    },
    {
      name: 'a string under a non-canonical key',
      log: (l: ReturnType<typeof createLogger>) => l.info({ target: url }, 'connecting'),
    },
    {
      name: 'a nested string under a non-canonical key',
      log: (l: ReturnType<typeof createLogger>) => l.info({ amqp: { url } }, 'connecting'),
    },
    {
      name: 'an error logged through a message child logger',
      log: (l: ReturnType<typeof createLogger>) =>
        messageLogger(l, { deviceId: 'dev-1', sessionId: 1, seq: 1 }).error(
          new Error(`connect ${url}`),
        ),
    },
  ])('never prints the password for $name', ({ log }) => {
    const output = lines(log);
    expect(output).toHaveLength(1);
    expect(output[0]).not.toContain(secret);
    expect(output[0]).toContain('rabbitmq:5672');
  });

  it('keeps the error type, message and stack, only stripped', () => {
    const [line] = lines((l) => l.error(new Error(`connect ${url}`), 'connect failed'));
    const parsed = parseLine(line);
    expect(parsed).toMatchObject({ msg: 'connect failed' });
    expect(parsed['err']).toMatchObject({
      type: 'Error',
      message: 'connect amqp://[redacted]@rabbitmq:5672',
    });
    expect(String((parsed['err'] as Record<string, unknown>)['stack'])).toContain('[redacted]@');
  });

  it('gives a bare error its stripped message as msg, as pino would have done unstripped', () => {
    const [line] = lines((l) => l.error(new Error(`connect ${url}`)));
    expect(parseLine(line)).toMatchObject({ msg: 'connect amqp://[redacted]@rabbitmq:5672' });
  });

  it('walks the properties of a value whose toJSON throws', () => {
    const broken = {
      target: url,
      toJSON: () => {
        throw new Error('not serialisable');
      },
    };
    const [line] = lines((l) => l.info({ broken }, 'shape'));
    expect(line).not.toContain(secret);
    expect(parseLine(line)).toMatchObject({
      broken: { target: 'amqp://[redacted]@rabbitmq:5672' },
    });
  });

  it('redacts inside the object a toJSON returns', () => {
    const wrapped = { toJSON: () => ({ nested: { target: url } }) };
    const [line] = lines((l) => l.info({ wrapped }, 'shape'));
    expect(line).not.toContain(secret);
    expect(parseLine(line)).toMatchObject({
      wrapped: { nested: { target: 'amqp://[redacted]@rabbitmq:5672' } },
    });
  });

  it('serialises a value through its own toJSON and redacts the result', () => {
    // `URL#toJSON` returns the whole href, userinfo included; a Date its ISO string.
    const when = new Date('2026-09-12T10:00:00.000Z');
    const custom = { secret: `x ${url}`, toJSON: () => 'custom' };
    const [line] = lines((l) => l.info({ when, custom, target: new URL(`${url}/vhost`) }, 'shape'));
    expect(line).not.toContain(secret);
    expect(parseLine(line)).toMatchObject({
      when: '2026-09-12T10:00:00.000Z',
      custom: 'custom',
      target: 'amqp://[redacted]@rabbitmq:5672/vhost',
    });
  });
});

describe('createLogger redaction', () => {
  it('redacts connection strings, which carry a password', () => {
    const destination = capture();
    const logger = createLogger({ service: 'ingest', level: 'info', destination });
    logger.info({ RABBITMQ_URL: 'amqp://u:p@rabbitmq:5672' }, 'connecting');
    logger.info({ config: { MONGODB_URL: 'mongodb://u:p@mongodb:27017' } }, 'connecting');
    const [first, second] = destination.lines.map(parseLine);
    expect(first?.['RABBITMQ_URL']).toBe('[redacted]');
    expect(second?.['config']).toEqual({ MONGODB_URL: '[redacted]' });
    expect(destination.lines.join('\n')).not.toContain('u:p@');
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

  it('logs only the three identity fields, never the rest of a wider object', () => {
    const destination = capture();
    const logger = createLogger({ service: 'processing', level: 'info', destination });
    const wide = { deviceId: 'dev-1', sessionId: 2, seq: 3, payload: { secretish: 'x' } };
    messageLogger(logger, wide).info('stored');
    const line = parseLine(destination.lines[0]);
    expect(line).toMatchObject({ deviceId: 'dev-1', sessionId: 2, seq: 3 });
    expect(line).not.toHaveProperty('payload');
  });

  it('is unaffected by later mutation of the identity object', () => {
    const destination = capture();
    const logger = createLogger({ service: 'processing', level: 'info', destination });
    const identity = { deviceId: 'dev-1', sessionId: 2, seq: 3 };
    const scoped = messageLogger(logger, identity);
    scoped.info('first');
    identity.seq = 999;
    scoped.info('second');
    for (const raw of destination.lines) {
      expect(parseLine(raw)).toMatchObject({ seq: 3 });
    }
  });

  it('keeps two children of one parent independent', () => {
    const destination = capture();
    const logger = createLogger({ service: 'processing', level: 'info', destination });
    messageLogger(logger, { deviceId: 'dev-a', sessionId: 1, seq: 1 }).info('a');
    messageLogger(logger, { deviceId: 'dev-b', sessionId: 2, seq: 2 }).info('b');
    expect(parseLine(destination.lines[0])).toMatchObject({ deviceId: 'dev-a', seq: 1 });
    expect(parseLine(destination.lines[1])).toMatchObject({ deviceId: 'dev-b', seq: 2 });
  });
});

describe('rejectedMessageLogger', () => {
  it('accepts a partial identity for rejected input', () => {
    const destination = capture();
    const logger = createLogger({ service: 'ingest', level: 'info', destination });
    rejectedMessageLogger(logger, { deviceId: 'dev-0002' }).warn('rejected');
    const line = parseLine(destination.lines[0]);
    expect(line).toMatchObject({ deviceId: 'dev-0002', msg: 'rejected' });
    expect(line).not.toHaveProperty('sessionId');
    expect(line).not.toHaveProperty('seq');
  });
});
```

#### `packages/shared/src/logger.ts` (whole file)

```ts
import { hostname } from 'node:os';

import {
  pino,
  stdSerializers,
  type DestinationStream,
  type Logger,
  type LoggerOptions,
} from 'pino';

import type { MessageIdentity, RawIdentity } from './identity.js';

export type { Logger };

export const LOG_LEVELS = ['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

/**
 * Config values that carry credentials (`RABBITMQ_URL` is documented in `.env.example` as
 * `amqp://<user>:<password>@host`). Redaction matches object PATHS, so this covers
 * `logger.info({ RABBITMQ_URL })` and one level of nesting. Everything else that can carry a
 * connection string — an error message, a stack, a string under another key — goes through
 * `redactUserinfo` below.
 */
const REDACTED_PATHS = ['RABBITMQ_URL', 'MONGODB_URL', '*.RABBITMQ_URL', '*.MONGODB_URL'] as const;

/**
 * `scheme://user:password@` inside any text. amqplib and the MongoDB driver embed the connection
 * string in their error messages, so without this the password would reach the log through
 * `err.message`, `err.stack` and the `msg` field pino copies an error message into.
 */
const URL_USERINFO = /([a-z][\w+.-]*:\/\/)[^\s/@]+@/gi;

/** Replaces the userinfo of every URL in `text` with `[redacted]`; the host and path are kept. */
export function redactUserinfo(text: string): string {
  return text.replace(URL_USERINFO, '$1[redacted]@');
}

/** Bounded walk over plain objects and arrays; every string is passed through `redactUserinfo`. */
const MAX_REDACT_DEPTH = 4;

function redactStrings(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') {
    return redactUserinfo(value);
  }
  if (depth >= MAX_REDACT_DEPTH || value === null || typeof value !== 'object') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item: unknown) => redactStrings(item, depth + 1));
  }
  // An Error is left for the `err` serializer. A value with its own `toJSON` is serialised the
  // way JSON would serialise it and the result is redacted in turn: a `URL` prints its whole
  // `href`, userinfo included, a `Date` its ISO string, a `Buffer` an object with its bytes. A
  // `toJSON` that throws is ignored and the value is walked like any other object. Anything else
  // — a plain object, or the serialised error the standard serializer returns, which has a custom
  // prototype but no `toJSON` — is rebuilt from the same own enumerable properties that JSON
  // serialisation would read, so the line keeps its shape.
  if (value instanceof Error) {
    return value;
  }
  const { toJSON } = value as { toJSON?: unknown };
  if (typeof toJSON === 'function') {
    try {
      const json: unknown = (toJSON as () => unknown).call(value);
      return typeof json === 'string' ? redactUserinfo(json) : redactStrings(json, depth + 1);
    } catch {
      // Fall through: the object's own properties are still walked below.
    }
  }
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    // JSON serialisation omits function properties; copying a `toJSON` would also re-invoke it.
    if (typeof item !== 'function') {
      out[key] = redactStrings(item, depth + 1);
    }
  }
  return out;
}

/** The error found at `err` on a merging object, if any. */
function errorOf(value: unknown): Error | undefined {
  if (value instanceof Error) {
    return value;
  }
  if (typeof value === 'object' && value !== null && 'err' in value && value.err instanceof Error) {
    return value.err;
  }
  return undefined;
}

const loggerOptions: Pick<LoggerOptions, 'serializers' | 'formatters' | 'hooks'> = {
  serializers: {
    // Runs after `formatters.log`, on the Error instance itself: strips the userinfo out of
    // `message`, `stack` and any nested cause the standard serializer surfaces.
    err: (error: Error) => redactStrings(stdSerializers.err(error)),
  },
  formatters: {
    // Runs on the merging object before serialisation: covers a connection string logged under
    // any key (`{ url }`, `{ target }`), which the path-based redaction cannot know about. Cost:
    // one pass over the merging object per line, negligible next to the JSON serialisation.
    log: (object) => redactStrings(object) as Record<string, unknown>,
  },
  hooks: {
    // Runs before the line is built: strips every string argument (the message and format
    // arguments) and gives a bare error an explicit, stripped message. Without the latter pino
    // copies `err.message` into `msg` before any serializer sees it.
    logMethod(args, method) {
      const redacted: unknown[] = args.map((arg: unknown) =>
        typeof arg === 'string' ? redactUserinfo(arg) : arg,
      );
      const error = errorOf(redacted[0]);
      if (error !== undefined && typeof redacted[1] !== 'string') {
        redacted.splice(1, 0, redactUserinfo(error.message));
      }
      method.apply(this, redacted as Parameters<typeof method>);
    },
  },
};

export type CreateLoggerOptions = {
  service: string;
  level: LogLevel;
  /** Where lines go; defaults to stdout. Tests pass an object with `write(msg)`. */
  destination?: DestinationStream;
};

/**
 * JSON lines. Every line carries `service` and `hostname` (one per Compose replica) and an
 * ISO-8601 `time`; `pid` is left out because it is meaningless inside a container.
 *
 * Three things a caller must know:
 * - A shutdown handler needs no flush call, and `logger.flush()` would not give it one. The
 *   default destination is `pino.destination(1)`: a SonicBoom with `sync: false` and
 *   `minLength: 0`, so a line is handed to `fs.write` as it is logged and no user-space buffer
 *   holds it. sonic-boom 4.2.1 returns from `flush(cb)` immediately when `minLength <= 0` and
 *   calls the callback while the write is still in flight, so wrapping it in a promise waits for
 *   nothing. What protects the last lines is the exit hook pino registers for an asynchronous
 *   destination (`pino/lib/tools.js` `buildSafeSonicBoom` -> `on-exit-leak-free`): `beforeExit`
 *   flushes and ends the stream, `exit` calls `flushSync`, which writes the queue with
 *   `fs.writeSync` and retries EAGAIN until a slow reader catches up. Accepted race: `flushSync`
 *   skips the one chunk `fs.write` is already writing, so a forced `process.exit()` can in
 *   principle cut it (probes of 2 000 lines and of 500 x 8 KB lines into a slow pipe reader lost
 *   nothing). `sync: true` would remove the race and make every line a blocking write; the
 *   telemetry path is not worth that.
 * - A log reader that goes away silences the service instead of stopping it: on EPIPE pino
 *   replaces `write`, `end`, `flushSync` and `destroy` with no-ops, and the process keeps
 *   running with no output at all. Health of a container cannot be judged by its log stream.
 * - Annotate an exported binding as `Logger` imported from this package, not from `pino`:
 *   `export const logger: Logger = createLogger(...)`. Without the annotation an app that does
 *   not itself depend on pino fails to build with TS2883 (the inferred type cannot be named).
 */
export function createLogger({ service, level, destination }: CreateLoggerOptions): Logger {
  return pino(
    {
      level,
      base: { service, hostname: hostname() },
      timestamp: pino.stdTimeFunctions.isoTime,
      redact: { paths: [...REDACTED_PATHS], censor: '[redacted]' },
      ...loggerOptions,
    },
    destination,
  );
}

/**
 * A child logger whose every line carries the message identity as separate fields
 * (consistency spec, decision 21). Takes a COMPLETE identity, so the convention "every log line
 * about a message carries the device id and the message identity" cannot be broken by accident on
 * the valid-message path. Use `rejectedMessageLogger` for input that failed to decode.
 */
export function messageLogger(logger: Logger, identity: MessageIdentity): Logger {
  return childWithIdentity(logger, identity);
}

/**
 * The same, for input that never became a valid message: `decodeTelemetryMessage` returns whatever
 * identity fields it could read, which may be none. pino omits a binding whose value is undefined,
 * so a line carries exactly the fields that were actually present.
 */
export function rejectedMessageLogger(logger: Logger, identity: RawIdentity): Logger {
  return childWithIdentity(logger, identity);
}

/** Fields are copied one by one: bindings never take an externally supplied object. */
function childWithIdentity(logger: Logger, identity: RawIdentity): Logger {
  return logger.child({
    deviceId: identity.deviceId,
    sessionId: identity.sessionId,
    seq: identity.seq,
  });
}
```

### Task 3: Bound the identity fields logged for a rejected frame [mechanical]

**Files:** Modify `packages/shared/src/identity.ts`, Test `packages/shared/src/identity.test.ts`
**Invariant:** none touched; `CLAUDE.md` "malformed input is rejected and logged, never crashes a service" — a device must not be able to inflate the log line (review B3)
**Verify:** `pnpm --filter @telemetry/shared test && pnpm --filter @telemetry/shared typecheck && pnpm --filter @telemetry/shared lint`

`extractRawIdentity` output lands on every log line about a rejected frame. A 65 000-character `deviceId` became a 65 KB line, and `sessionId: 1e400` became `Infinity`, which pino prints as `null`. `deviceId` is cut to `DEVICE_ID_MAX_LENGTH` (a valid id never exceeds it) and the numbers are kept only when they are safe integers. `Number.isSafeInteger` is typed as a plain boolean in TypeScript 6.0.3, so the `typeof` check stays in front of it.

- [ ] Replace `identity.test.ts` with the content below. Run the verify command: the two new cases fail (length 100 000 and `{ sessionId: Infinity }` passing through).
- [ ] Replace `identity.ts` with the content below. Run the verify command: green.
- [ ] Commit — subject: `Bound the identity fields logged for a rejected frame`

#### `packages/shared/src/identity.test.ts` (whole file)

```ts
import { describe, expect, it } from 'vitest';

import { makeStatusMessage } from './fixtures.js';
import { extractRawIdentity, isNewer, messageIdentity, orderKey } from './identity.js';
import { DEVICE_ID_MAX_LENGTH } from './message.js';

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
      name: 'a numerically larger session whose digit string is shorter',
      candidate: { sessionId: 10, seq: 1 },
      stored: { sessionId: 9, seq: 5 },
      expected: true,
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

  it('drops deviceId and seq when they have the wrong type', () => {
    expect(extractRawIdentity({ deviceId: 42, seq: '3' })).toEqual({});
  });

  it('drops sessionId when it has the wrong type and keeps the others', () => {
    expect(extractRawIdentity({ deviceId: 'dev-1', sessionId: '2', seq: 3 })).toEqual({
      deviceId: 'dev-1',
      seq: 3,
    });
  });

  it('keeps a present field when the others are absent', () => {
    expect(extractRawIdentity({ deviceId: 'dev-1' })).toEqual({ deviceId: 'dev-1' });
  });

  it('returns an empty object for null', () => {
    // typeof null === 'object', so null is the only input that needs the explicit null check.
    expect(extractRawIdentity(null)).toEqual({});
  });

  it('returns an empty object for a non-object primitive', () => {
    expect(extractRawIdentity('text')).toEqual({});
    expect(extractRawIdentity(undefined)).toEqual({});
  });

  it('returns an empty object for an array', () => {
    expect(extractRawIdentity(['dev-1', 2, 3])).toEqual({});
  });

  it('bounds a deviceId to the contract maximum, because it lands on every log line', () => {
    const { deviceId } = extractRawIdentity({ deviceId: 'd'.repeat(100_000) });
    expect(deviceId).toHaveLength(DEVICE_ID_MAX_LENGTH);
  });

  it('drops a non-finite or unsafe number, which pino would print as null', () => {
    expect(extractRawIdentity({ sessionId: Number.POSITIVE_INFINITY, seq: Number.NaN })).toEqual(
      {},
    );
    expect(extractRawIdentity({ sessionId: 2 ** 53, seq: 1.5 })).toEqual({});
  });
});
```

#### `packages/shared/src/identity.ts` (whole file)

```ts
import { DEVICE_ID_MAX_LENGTH, type TelemetryMessage } from './message.js';

/** The dedup key of a message (consistency spec, decision 3). Projected from the schema, not redeclared. */
export type MessageIdentity = Pick<TelemetryMessage, 'deviceId' | 'sessionId' | 'seq'>;

/**
 * The order key of a message, compared lexicographically (decision 1). Deliberately independent of
 * `TelemetryMessage`: `isNewer` also takes the watermark stored on a device-state section.
 */
export type OrderKey = { sessionId: number; seq: number };

/** Identity fields found on an unvalidated value, for log lines about rejected input. */
export type RawIdentity = Partial<MessageIdentity>;

/** `deviceId:sessionId:seq` — the log field, the AMQP messageId and the `_id` of an alert. */
export function messageIdentity(message: MessageIdentity): string {
  return `${message.deviceId}:${message.sessionId}:${message.seq}`;
}

/**
 * The order key as a tuple, for logging and for building a storage key.
 * Never compare two of these with `<` or `>`: JavaScript compares arrays by string coercion, so
 * `[2, 1] > [10, 50]` is `true`, which is numerically backwards. Only `isNewer` decides order.
 */
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
  // `in` rather than Object.hasOwn: TypeScript 6.0.3 declares hasOwn as returning plain `boolean`,
  // so it does not narrow `unknown`. The only caller passes `JSON.parse` output, which never has
  // inherited properties, so the two are equivalent here.
  // Bounded and finite: this object lands on every log line about a rejected frame, so a device
  // must not be able to put 64 KiB, `Infinity` (which pino prints as null) or `1e400` there.
  const identity: RawIdentity = {};
  if ('deviceId' in value && typeof value.deviceId === 'string') {
    identity.deviceId = value.deviceId.slice(0, DEVICE_ID_MAX_LENGTH);
  }
  if (
    'sessionId' in value &&
    typeof value.sessionId === 'number' &&
    Number.isSafeInteger(value.sessionId)
  ) {
    identity.sessionId = value.sessionId;
  }
  if ('seq' in value && typeof value.seq === 'number' && Number.isSafeInteger(value.seq)) {
    identity.seq = value.seq;
  }
  return identity;
}
```

### Task 4: Return a result from the frame decoder and scan each chunk once [integration]

**Files:** Modify `packages/shared/src/framing.ts`, Test `packages/shared/src/framing.test.ts`
**Invariant:** 6 (ingest stays stateless per connection and survives a misbehaving device — review B4, B5, C1)
**Verify:** `pnpm --filter @telemetry/shared test && pnpm --filter @telemetry/shared typecheck && pnpm --filter @telemetry/shared lint`

Two changes in one module. `push` no longer throws: it returns `{ ok: true, frames }` or `{ ok: false, frames, error }`, so the frames decoded before an oversized line sit on the same field in both branches and cannot be dropped by a `try/catch` that only closes the connection — the shape `decodeTelemetryMessage` already uses. And the unfinished tail is kept as the list of chunks it arrived in, so each push scans and copies only its own chunk: a one-byte drip up to the 64 KiB limit cost 283 ms of blocked event loop per connection before, 13 ms after. The test file also adds the escaped-newline round trip the NDJSON decision rests on and drops the `MAX_FRAME_BYTES === 65536` tautology.

- [ ] Replace `framing.test.ts` with the content below. Run the verify command: the file fails to type-check against the old `push` signature (`FrameDecodeResult` has no iterator), which is the expected red.
- [ ] Replace `framing.ts` with the content below. Run the verify command: green; the drip case reports well under its 150 ms budget.
- [ ] Commit — subject: `Return a result from the frame decoder and scan each chunk once`

#### `packages/shared/src/framing.test.ts` (whole file)

```ts
import { describe, expect, it } from 'vitest';

import { exampleMessages } from './fixtures.js';
import { FrameDecoder, FrameTooLongError, MAX_FRAME_BYTES, encodeFrame } from './framing.js';

describe('encodeFrame', () => {
  it('serialises the message as one JSON line', () => {
    const message = exampleMessages.status;
    expect(encodeFrame(message).toString('utf8')).toBe(`${JSON.stringify(message)}\n`);
  });

  it('keeps a newline inside a string value escaped, so the frame stays one line', () => {
    // The NDJSON decision rests on this: a raw U+000A can never come from a string field.
    const message = {
      ...exampleMessages.diagnostic,
      payload: { ...exampleMessages.diagnostic.payload, message: 'line one\nline two' },
    };
    const bytes = encodeFrame(message);
    expect(bytes.indexOf(0x0a)).toBe(bytes.length - 1);
    const result = new FrameDecoder().push(bytes);
    expect(result.frames).toEqual([JSON.stringify(message)]);
    expect(JSON.parse(result.frames[0] ?? '')).toEqual(message);
  });
});

describe('FrameDecoder', () => {
  it('returns each complete line and keeps the unfinished tail', () => {
    const decoder = new FrameDecoder();
    expect(decoder.push(Buffer.from('{"a":1}\n{"b":'))).toEqual({ ok: true, frames: ['{"a":1}'] });
    expect(decoder.pendingBytes).toBe(5);
    expect(decoder.push(Buffer.from('2}\n'))).toEqual({ ok: true, frames: ['{"b":2}'] });
    expect(decoder.pendingBytes).toBe(0);
  });

  it('returns several frames from one chunk in order', () => {
    const decoder = new FrameDecoder();
    expect(decoder.push(Buffer.from('1\n2\n3\n')).frames).toEqual(['1', '2', '3']);
  });

  it('reassembles a frame split inside a multi-byte character', () => {
    const bytes = Buffer.from('{"m":"čau"}\n', 'utf8');
    const cut = bytes.indexOf(0xc4) + 1; // between the two bytes of "č"
    const decoder = new FrameDecoder();
    const frames = [
      ...decoder.push(bytes.subarray(0, cut)).frames,
      ...decoder.push(bytes.subarray(cut)).frames,
    ];
    expect(frames).toEqual(['{"m":"čau"}']);
  });

  it('reassembles a frame split across three chunks', () => {
    const decoder = new FrameDecoder();
    const frames = [
      ...decoder.push(Buffer.from('{"a"')).frames,
      ...decoder.push(Buffer.from(':123')).frames,
      ...decoder.push(Buffer.from('}\n')).frames,
    ];
    expect(frames).toEqual(['{"a":123}']);
  });

  it('skips empty and whitespace-only lines and leaves a trailing carriage return in place', () => {
    const decoder = new FrameDecoder();
    const { frames } = decoder.push(Buffer.from('\n  \n{"a":1}\r\n'));
    expect(frames).toEqual(['{"a":1}\r']);
    expect(JSON.parse(frames[0] ?? '') as unknown).toEqual({ a: 1 });
  });

  it('reports a FrameTooLongError with the sizes when a completed line exceeds the limit', () => {
    const decoder = new FrameDecoder(8);
    const result = decoder.push(Buffer.from('123456789\n'));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(FrameTooLongError);
      expect(result.error).toMatchObject({ bytes: 9, limit: 8 });
    }
  });

  it('reports a FrameTooLongError when the unfinished tail exceeds the limit and resets', () => {
    const decoder = new FrameDecoder(8);
    const result = decoder.push(Buffer.from('123456789'));
    expect(result).toMatchObject({ ok: false, error: { bytes: 9, limit: 8 } });
    expect(decoder.pendingBytes).toBe(0);
    expect(decoder.push(Buffer.from('{"a":1}\n'))).toEqual({ ok: true, frames: ['{"a":1}'] });
  });

  it('counts the buffered tail into the length of the line it belongs to', () => {
    const decoder = new FrameDecoder(8);
    expect(decoder.push(Buffer.from('12345')).ok).toBe(true);
    // 5 buffered + 4 new = 9 bytes for one line, although neither chunk alone exceeds 8.
    expect(decoder.push(Buffer.from('6789\n'))).toMatchObject({
      ok: false,
      error: { bytes: 9, limit: 8 },
    });
    expect(decoder.pendingBytes).toBe(0);
  });

  it('still returns the frames decoded before the oversized one', () => {
    const decoder = new FrameDecoder(8);
    const result = decoder.push(Buffer.from('ok\nXXXXXXXXXXXXX'));
    // The valid frame was already decoded and is no longer in the decoder; losing it would
    // silently drop telemetry from a caller that keeps the connection open.
    expect(result).toMatchObject({ ok: false, frames: ['ok'] });
    expect(decoder.pendingBytes).toBe(0);
  });

  it('accepts a line and a tail of exactly the limit', () => {
    const decoder = new FrameDecoder(8);
    expect(decoder.push(Buffer.from('12345678\n'))).toEqual({ ok: true, frames: ['12345678'] });
    expect(decoder.push(Buffer.from('abcdefgh')).ok).toBe(true);
    expect(decoder.pendingBytes).toBe(8);
  });

  it('stays usable after a completed line exceeded the limit', () => {
    const decoder = new FrameDecoder(8);
    expect(decoder.push(Buffer.from('123456789\n')).ok).toBe(false);
    expect(decoder.pendingBytes).toBe(0);
    expect(decoder.push(Buffer.from('{"a":1}\n'))).toEqual({ ok: true, frames: ['{"a":1}'] });
  });

  it('clears a non-empty buffered tail when the limit is exceeded', () => {
    const decoder = new FrameDecoder(8);
    decoder.push(Buffer.from('ab'));
    expect(decoder.pendingBytes).toBe(2);
    // Without the reset the tail would stay at 2, so the 0 below can only come from the reset.
    expect(decoder.push(Buffer.from('cdefghij\n')).ok).toBe(false);
    expect(decoder.pendingBytes).toBe(0);
  });

  it("does not let the pending tail alias the caller's chunk buffer", () => {
    const decoder = new FrameDecoder();
    const chunk = Buffer.from('{"a":1}\n{"b":');
    expect(decoder.push(chunk).frames).toEqual(['{"a":1}']);
    chunk.fill(0); // a real socket reuses its read buffer
    expect(decoder.push(Buffer.from('2}\n')).frames).toEqual(['{"b":2}']);
  });

  it('keeps each decoder independent, so one connection cannot corrupt another', () => {
    const a = new FrameDecoder(8);
    const b = new FrameDecoder(8);
    a.push(Buffer.from('ab'));
    expect(a.push(Buffer.from('cdefghij')).ok).toBe(false);
    expect(b.push(Buffer.from('ok\n'))).toEqual({ ok: true, frames: ['ok'] });
    expect(b.pendingBytes).toBe(0);
  });

  it('wires the default limit to MAX_FRAME_BYTES', () => {
    const decoder = new FrameDecoder();
    expect(decoder.push(Buffer.from('x'.repeat(MAX_FRAME_BYTES))).ok).toBe(true);
    expect(decoder.push(Buffer.from('x'))).toMatchObject({
      ok: false,
      error: { bytes: MAX_FRAME_BYTES + 1, limit: MAX_FRAME_BYTES },
    });
  });

  it('costs one scan per byte when a line arrives one byte at a time', () => {
    // A misbehaving device drips bytes. Re-copying and re-scanning the whole tail on every push
    // made this quadratic: 65 536 single-byte pushes took ~280 ms of blocked event loop per
    // connection. Linear work stays far under the budget below on any machine.
    const decoder = new FrameDecoder();
    const byte = Buffer.from('x');
    let rejected = 0;
    const started = performance.now();
    for (let i = 0; i < MAX_FRAME_BYTES; i++) {
      if (!decoder.push(byte).ok) {
        rejected += 1;
      }
    }
    expect(performance.now() - started).toBeLessThan(150);
    expect(rejected).toBe(0);
    expect(decoder.pendingBytes).toBe(MAX_FRAME_BYTES);
    expect(decoder.push(Buffer.from('\n')).frames).toEqual(['x'.repeat(MAX_FRAME_BYTES)]);
  });

  it('round-trips every example message', () => {
    const decoder = new FrameDecoder();
    const chunk = Buffer.concat(Object.values(exampleMessages).map(encodeFrame));
    const decoded = decoder.push(chunk).frames.map((line) => JSON.parse(line) as unknown);
    expect(decoded).toEqual(Object.values(exampleMessages));
  });
});
```

#### `packages/shared/src/framing.ts` (whole file)

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

/**
 * What one `push` produced. `frames` is on both branches so the lines decoded before an oversized
 * one cannot be dropped by accident; `error` says the decoder gave up on the stream and the caller
 * should close the connection (shared-contract spec, decision 1).
 */
export type FrameDecodeResult =
  { ok: true; frames: string[] } | { ok: false; frames: string[]; error: FrameTooLongError };

/** One message per line: UTF-8 JSON followed by `\n` (shared-contract spec, decision 1). */
export function encodeFrame(message: TelemetryMessage): Buffer {
  return Buffer.from(`${JSON.stringify(message)}\n`, 'utf8');
}

/**
 * Splits a byte stream into complete lines. Keeps the unfinished tail between calls, so one
 * instance belongs to one connection. Whitespace-only lines are ignored. Never throws.
 *
 * The tail is kept as the list of chunks it arrived in, and each `push` scans only the chunk it
 * was given: the cost is one copy and one scan per byte however the bytes are split. Rebuilding
 * one buffer per push would cost the whole tail again on every call, which a device that sends
 * one byte at a time turns into seconds of blocked event loop per connection.
 */
export class FrameDecoder {
  #pending: Buffer[] = [];
  #pendingBytes = 0;
  readonly #maxFrameBytes: number;

  constructor(maxFrameBytes: number = MAX_FRAME_BYTES) {
    this.#maxFrameBytes = maxFrameBytes;
  }

  /** Bytes of the unfinished line currently buffered (logged when a connection closes). */
  get pendingBytes(): number {
    return this.#pendingBytes;
  }

  /**
   * Returns every complete frame in the stream so far, without its newline. When a line or the
   * buffered tail exceeds the limit the result is `ok: false`: the buffer is cleared, the rest of
   * the chunk is not read, and the frames decoded before that point are still returned.
   */
  push(chunk: Buffer): FrameDecodeResult {
    const frames: string[] = [];
    let start = 0;
    for (;;) {
      const end = chunk.indexOf(NEWLINE, start);
      if (end === -1) {
        break;
      }
      const lineBytes = this.#pendingBytes + (end - start);
      if (lineBytes > this.#maxFrameBytes) {
        this.#reset();
        return { ok: false, frames, error: new FrameTooLongError(lineBytes, this.#maxFrameBytes) };
      }
      const part = chunk.subarray(start, end);
      // Concatenate before decoding, so a multi-byte character split across chunks is intact.
      const line =
        this.#pendingBytes === 0
          ? part.toString('utf8')
          : Buffer.concat([...this.#pending, part]).toString('utf8');
      this.#reset();
      if (line.trim().length > 0) {
        frames.push(line);
      }
      start = end + 1;
    }
    const tail = chunk.subarray(start);
    const tailBytes = this.#pendingBytes + tail.length;
    if (tailBytes > this.#maxFrameBytes) {
      this.#reset();
      return { ok: false, frames, error: new FrameTooLongError(tailBytes, this.#maxFrameBytes) };
    }
    if (tail.length > 0) {
      // Copy, not a view: `subarray` would keep the caller's chunk alive, and a socket reuses it.
      this.#pending.push(Buffer.from(tail));
      this.#pendingBytes = tailBytes;
    }
    return { ok: true, frames };
  }

  #reset(): void {
    this.#pending = [];
    this.#pendingBytes = 0;
  }
}
```

### Task 5: Bound `sessionId`, `occurredAt` and the percent fields in the contract [mechanical]

**Files:** Modify `packages/shared/src/message.ts`, Test `packages/shared/src/message.test.ts`
**Invariant:** 1 (the order key cannot be poisoned by one out-of-range `sessionId`) and 2 (`deviceId` cannot contain the identity separator) — proved by the `sessionId` window rows and the `dev:0001` row in `message.test.ts`
**Verify:** `pnpm --filter @telemetry/shared test && pnpm --filter @telemetry/shared typecheck && pnpm --filter @telemetry/shared lint`

`sessionId` is bounded to 1 500 000 000 000–4 100 000 000 000 (2017-07-14 to 2099-11-26, epoch milliseconds): a value in seconds or microseconds, or a clock that was never set, is rejected loudly at validation instead of freezing a device's state for good (consistency spec, decision 28). `occurredAt` must be ≥ 0, `cpuPercent` and `ramPercent` within 0–100. The example messages already sit inside the window; the identity tests use small `sessionId` values only through `isNewer`, which is schema-free.

- [ ] Replace `message.test.ts` with the content below. Run the verify command: seven of the eight new rejection rows fail against the old schema (the two `sessionId` window rows, the two safe-integer rows, the negative `occurredAt`, the two percent rows); the `dev:0001` row already passes through the existing regex and is kept as a pin of the identity separator.
- [ ] Replace `message.ts` with the content below. Run the verify command: green.
- [ ] Commit — subject: `Bound sessionId, occurredAt and the percent fields in the contract`

#### `packages/shared/src/message.test.ts` (whole file)

```ts
import { describe, expect, it } from 'vitest';

import { exampleMessages } from './fixtures.js';
import {
  DIAGNOSTIC_CODE_MAX_LENGTH,
  DIAGNOSTIC_MESSAGE_MAX_LENGTH,
  PERCENT_MAX,
  SESSION_ID_MAX,
  SESSION_ID_MIN,
  TELEMETRY_EVENT_TYPES,
  telemetryMessageSchema,
} from './message.js';

describe('telemetryMessageSchema', () => {
  it.each(TELEMETRY_EVENT_TYPES)('accepts a valid %s message and returns an equal copy', (type) => {
    const input = exampleMessages[type];
    const result = telemetryMessageSchema.safeParse(input);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual(input);
      // A fresh object: processing may enrich the parsed message without touching the caller's.
      expect(result.data).not.toBe(input);
    }
  });

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
      // `deviceId:sessionId:seq` is the dedup key, the AMQP messageId and `alerts._id`.
      name: 'a deviceId containing the identity separator',
      input: { ...status, deviceId: 'dev:0001' },
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
      // Beyond 2^53 a double cannot count by one, so `isNewer` would stop distinguishing messages.
      name: 'a seq beyond the safe integer range',
      input: { ...status, seq: Number.MAX_SAFE_INTEGER + 2 },
      code: 'too_big',
      path: ['seq'],
    },
    {
      name: 'a fractional seq',
      input: { ...status, seq: 1.5 },
      code: 'invalid_type',
      path: ['seq'],
    },
    {
      name: 'sessionId 0',
      input: { ...status, sessionId: 0 },
      code: 'too_small',
      path: ['sessionId'],
    },
    {
      // Seconds since the epoch: a clock unit error that would stay "older" than every session.
      name: 'a sessionId below the plausible epoch-millisecond window',
      input: { ...status, sessionId: SESSION_ID_MIN - 1 },
      code: 'too_small',
      path: ['sessionId'],
    },
    {
      // Microseconds: 1 000× too large, it would stay "newer" than every later real session.
      name: 'a sessionId above the plausible epoch-millisecond window',
      input: { ...status, sessionId: SESSION_ID_MAX + 1 },
      code: 'too_big',
      path: ['sessionId'],
    },
    {
      name: 'a sessionId beyond the safe integer range',
      input: { ...status, sessionId: Number.MAX_SAFE_INTEGER + 2 },
      code: 'too_big',
      path: ['sessionId'],
    },
    {
      name: 'a fractional sessionId',
      input: { ...status, sessionId: 1.5 },
      code: 'invalid_type',
      path: ['sessionId'],
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
      name: 'a negative occurredAt',
      input: { ...status, occurredAt: -1 },
      code: 'too_small',
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
      name: 'an unknown metrics payload key',
      input: { ...metrics, payload: { ...metrics.payload, extra: 1 } },
      code: 'unrecognized_keys',
      path: ['payload'],
    },
    {
      name: 'an unknown counters payload key',
      input: { ...counters, payload: { ...counters.payload, extra: 1 } },
      code: 'unrecognized_keys',
      path: ['payload'],
    },
    {
      name: 'an unknown diagnostic payload key',
      input: { ...diagnostic, payload: { ...diagnostic.payload, extra: 1 } },
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
      name: 'a NaN cpuPercent',
      input: { ...metrics, payload: { ...metrics.payload, cpuPercent: Number.NaN } },
      code: 'invalid_type',
      path: ['payload', 'cpuPercent'],
    },
    {
      name: 'a cpuPercent above 100',
      input: { ...metrics, payload: { ...metrics.payload, cpuPercent: PERCENT_MAX + 0.5 } },
      code: 'too_big',
      path: ['payload', 'cpuPercent'],
    },
    {
      name: 'a negative ramPercent',
      input: { ...metrics, payload: { ...metrics.payload, ramPercent: -1 } },
      code: 'too_small',
      path: ['payload', 'ramPercent'],
    },
    {
      name: 'an infinite ramPercent',
      input: {
        ...metrics,
        payload: { ...metrics.payload, ramPercent: Number.POSITIVE_INFINITY },
      },
      code: 'invalid_type',
      path: ['payload', 'ramPercent'],
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
      name: 'a fractional operationsTotal',
      input: { ...counters, payload: { ...counters.payload, operationsTotal: 0.5 } },
      code: 'invalid_type',
      path: ['payload', 'operationsTotal'],
    },
    {
      name: 'a negative uptimeMs',
      input: { ...counters, payload: { ...counters.payload, uptimeMs: -1 } },
      code: 'too_small',
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
      name: 'a diagnostic code over the limit',
      input: {
        ...diagnostic,
        payload: { ...diagnostic.payload, code: 'x'.repeat(DIAGNOSTIC_CODE_MAX_LENGTH + 1) },
      },
      code: 'too_big',
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

#### `packages/shared/src/message.ts` (whole file)

```ts
import { z } from 'zod';

/** Contract version carried by every message as `v`. Bump on an incompatible change. */
export const CONTRACT_VERSION = 1;

export const DEVICE_ID_PATTERN = /^[A-Za-z0-9_-]+$/;
export const DEVICE_ID_MAX_LENGTH = 64;
export const DIAGNOSTIC_CODE_MAX_LENGTH = 64;
export const DIAGNOSTIC_MESSAGE_MAX_LENGTH = 1024;

/**
 * Plausible window for `sessionId`, milliseconds since the epoch: 2017-07-14 to 2099-11-26.
 * One value outside it would poison a device for good — a microsecond clock is 1 000× too large
 * and stays "newer" than every later real session, a clock that was never set is 1970 and stays
 * "older" — so both are rejected loudly at validation instead of silently freezing the state.
 */
export const SESSION_ID_MIN = 1_500_000_000_000;
export const SESSION_ID_MAX = 4_100_000_000_000;
export const PERCENT_MIN = 0;
export const PERCENT_MAX = 100;

export const TELEMETRY_EVENT_TYPES = ['status', 'metrics', 'counters', 'diagnostic'] as const;
export type TelemetryEventType = (typeof TELEMETRY_EVENT_TYPES)[number];

// Envelope: device identity, message identity and order (consistency spec, decisions 1–4).
// `occurredAt` is the device clock and is diagnostic only; `(sessionId, seq)` decides order.
const envelopeShape = {
  v: z.literal(CONTRACT_VERSION),
  deviceId: z.string().min(1).max(DEVICE_ID_MAX_LENGTH).regex(DEVICE_ID_PATTERN),
  sessionId: z.int().min(SESSION_ID_MIN).max(SESSION_ID_MAX),
  seq: z.int().min(1),
  occurredAt: z.int().min(0),
};

// Payloads carry absolute values (decision 5); counters are cumulative per session (decision 6).
export const statusPayloadSchema = z.strictObject({
  state: z.enum(['online', 'degraded', 'offline']),
});

export const metricsPayloadSchema = z.strictObject({
  temperatureC: z.number(),
  cpuPercent: z.number().min(PERCENT_MIN).max(PERCENT_MAX),
  ramPercent: z.number().min(PERCENT_MIN).max(PERCENT_MAX),
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

### Task 6: Cap every decode issue message and the JSON parser message [mechanical]

**Files:** Modify `packages/shared/src/decode.ts`, Test `packages/shared/src/decode.test.ts`
**Invariant:** none touched; log-line size stays out of a device's control (review B7)
**Verify:** `pnpm --filter @telemetry/shared test && pnpm --filter @telemetry/shared typecheck && pnpm --filter @telemetry/shared lint`

The 512-character cap sat on the joined `detail`, so with several failing fields the ones after the cut vanished — including their paths. The cap is now per issue (200 characters), so every failing field path survives, and the `JSON.parse` message gets the same cap because how much of the input V8 quotes is an engine detail.

- [ ] Replace `decode.test.ts` with the content below. Run the verify command: `caps the parser message` and `caps each issue separately` fail against the old code (the joined-blob cap cuts the `seq` issue away).
- [ ] Replace `decode.ts` with the content below. Run the verify command: green.
- [ ] Commit — subject: `Cap every decode issue message and the JSON parser message`

#### `packages/shared/src/decode.test.ts` (whole file)

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
      // The real parser message must be forwarded, not a placeholder that merely says "JSON".
      let expected = '';
      try {
        JSON.parse('{"deviceId":');
      } catch (error) {
        expected = (error as Error).message;
      }
      expect(result.detail).toBe(expected);
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

  it('renders an empty issue path as (root)', () => {
    const result = decodeTelemetryMessage('"text"');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.detail).toMatch(/^\(root\): /);
    }
  });

  it('lists every issue exactly once, joined by a semicolon', () => {
    const result = decodeTelemetryMessage(
      JSON.stringify({ ...exampleMessages.status, seq: 0, v: 2 }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const parts = result.detail.split('; ');
      expect(parts).toHaveLength(2);
      expect(parts.filter((part) => part.startsWith('v: '))).toHaveLength(1);
      expect(parts.filter((part) => part.startsWith('seq: '))).toHaveLength(1);
    }
  });

  it('keeps only identity fields of the right type', () => {
    const result = decodeTelemetryMessage(JSON.stringify({ deviceId: 7, sessionId: 1, seq: 'x' }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.identity).toEqual({ sessionId: 1 });
    }
  });

  it('caps the parser message of invalid JSON the same way', () => {
    const result = decodeTelemetryMessage(`{${'x'.repeat(5_000)}`);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('invalid_json');
      expect(result.detail.length).toBeLessThan(300);
    }
  });

  it('caps each issue separately, so every failing field path survives', () => {
    const junk = Object.fromEntries(Array.from({ length: 400 }, (_, i) => [`junkKey${i}`, 1]));
    const result = decodeTelemetryMessage(
      JSON.stringify({ ...exampleMessages.status, ...junk, seq: 0 }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const parts = result.detail.split('; ');
      expect(parts.filter((part) => part.startsWith('(root): '))).toHaveLength(1);
      expect(parts.filter((part) => part.startsWith('seq: '))).toHaveLength(1);
      expect(result.detail.length).toBeLessThan(400);
    }
  });

  it('caps detail so a device cannot drive the log line size', () => {
    // zod quotes unrecognized key names verbatim, so the text is device-controlled.
    const junk = Object.fromEntries(Array.from({ length: 400 }, (_, i) => [`junkKey${i}`, 1]));
    const result = decodeTelemetryMessage(JSON.stringify({ ...exampleMessages.status, ...junk }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.detail.length).toBeLessThan(600);
      expect(result.detail).toMatch(/truncated from \d+ characters\)$/);
    }
  });

  // The no-throw contract is the reason this function exists, so it is proved per hostile input
  // rather than once: each of these reaches a different part of the pipeline.
  it.each([
    { name: 'an empty frame', text: '' },
    { name: 'deeply nested JSON', text: `${'['.repeat(100_000)}${']'.repeat(100_000)}` },
    { name: 'a JSON null', text: 'null' },
    { name: 'a JSON array', text: '[]' },
    {
      name: 'an own __proto__ key',
      text: '{"__proto__":{"polluted":true},"type":"status"}',
    },
    { name: 'a lone surrogate', text: '"\ud800"' },
  ])('never throws for $name', ({ text }) => {
    expect(() => decodeTelemetryMessage(text)).not.toThrow();
    expect(decodeTelemetryMessage(text).ok).toBe(false);
  });

  it('does not pollute Object.prototype through a __proto__ key', () => {
    decodeTelemetryMessage('{"__proto__":{"polluted":true},"type":"status"}');
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
  });
});
```

#### `packages/shared/src/decode.ts` (whole file)

```ts
import { extractRawIdentity, type RawIdentity } from './identity.js';
import { telemetryMessageSchema, type TelemetryMessage } from './message.js';

export type DecodeFailureReason = 'invalid_json' | 'invalid_schema';

export type DecodeResult =
  | { ok: true; message: TelemetryMessage }
  | { ok: false; reason: DecodeFailureReason; detail: string; identity: RawIdentity };

type IssueLike = { readonly path: readonly PropertyKey[]; readonly message: string };

/**
 * Upper bound on the text of one issue. A zod `unrecognized_keys` issue quotes the offending key
 * names verbatim, so a device controls that text: without a cap, one 64 KiB frame of junk keys
 * becomes a 64 KiB log line. The cap is per issue, not per `detail`, so the path of every failing
 * field survives however long one message is. `JSON.parse` messages get the same cap: V8 quotes a
 * window of the input, and how long that window is belongs to the engine, not to this code.
 * Verified against zod 4.6.2; `invalid_value` does not echo the received value.
 */
const MAX_ISSUE_MESSAGE_LENGTH = 200;

/**
 * Turns the text of one frame into a validated message or a structured rejection. Never throws:
 * invalid input is a normal path that the caller logs (with `identity`) and drops.
 *
 * The caller must bound `text` before calling. Ingest gets that from `FrameDecoder`
 * (`MAX_FRAME_BYTES`); the AMQP consumer in processing has to bound the body itself.
 */
export function decodeTelemetryMessage(text: string): DecodeResult {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    const detail = cap(error instanceof Error ? error.message : String(error));
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
        `${issue.path.length === 0 ? '(root)' : issue.path.map(String).join('.')}: ${cap(issue.message)}`,
    )
    .join('; ');
}

function cap(text: string): string {
  return text.length <= MAX_ISSUE_MESSAGE_LENGTH
    ? text
    : `${text.slice(0, MAX_ISSUE_MESSAGE_LENGTH)}… (truncated from ${text.length} characters)`;
}
```

### Task 7: Parse trimmed environment values [mechanical]

**Files:** Modify `packages/shared/src/config.ts`, Test `packages/shared/src/config.test.ts`
**Invariant:** none touched; `CLAUDE.md` "a missing or invalid variable fails fast with a message naming it" (review B8)
**Verify:** `pnpm --filter @telemetry/shared test && pnpm --filter @telemetry/shared typecheck && pnpm --filter @telemetry/shared lint`

`loadConfig` trimmed a value only to decide whether it was empty and then parsed the untrimmed original, so a trailing newline from a mounted secret reached the driver inside the connection string and failed far from its cause. The trimmed value is now what gets parsed.

- [ ] Replace `config.test.ts` with the content below. Run the verify command: `parses the trimmed value` fails (the value keeps its newline).
- [ ] Replace `config.ts` with the content below. Run the verify command: green.
- [ ] Commit — subject: `Parse trimmed environment values`

#### `packages/shared/src/config.test.ts` (whole file)

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

  it('treats a whitespace-only value as unset', () => {
    // Number(' ') is 0, which would pass SHUTDOWN_TIMEOUT_MS's min of 0 and leave a service with
    // no drain window at all instead of the documented default.
    const config = loadConfig(schema, { ...required, SHUTDOWN_TIMEOUT_MS: ' ', LOG_LEVEL: '  ' });
    expect(config.SHUTDOWN_TIMEOUT_MS).toBe(10_000);
    expect(config.LOG_LEVEL).toBe('info');
  });

  it('parses the trimmed value, so a trailing newline from a secret file never reaches a driver', () => {
    const config = loadConfig(schema, { ...required, RABBITMQ_URL: ' amqp://rabbitmq:5672\n' });
    expect(config.RABBITMQ_URL).toBe('amqp://rabbitmq:5672');
  });

  it('still honours an explicit zero rather than treating it as unset', () => {
    expect(loadConfig(schema, { ...required, SHUTDOWN_TIMEOUT_MS: '0' }).SHUTDOWN_TIMEOUT_MS).toBe(
      0,
    );
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
  });

  it('coerces a numeric MONGODB_WRITE_W from a string', () => {
    expect(loadConfig(schema, { ...required, MONGODB_WRITE_W: '2' }).MONGODB_WRITE_W).toBe(2);
  });

  it('names a missing required variable', () => {
    const problems = problemsOf(() => loadConfig(schema, { MONGODB_URL: required.MONGODB_URL }));
    expect(problems).toEqual([expect.stringMatching(/^RABBITMQ_URL: /)]);
    expect(() => loadConfig(schema, { MONGODB_URL: required.MONGODB_URL })).toThrow(/RABBITMQ_URL/);
  });

  it('rejects a non-numeric AMQP_HEARTBEAT_S', () => {
    expect(problemsOf(() => loadConfig(schema, { ...required, AMQP_HEARTBEAT_S: 'abc' }))).toEqual([
      expect.stringMatching(/^AMQP_HEARTBEAT_S: /),
    ]);
  });

  it('rejects an AMQP_HEARTBEAT_S below the minimum', () => {
    expect(problemsOf(() => loadConfig(schema, { ...required, AMQP_HEARTBEAT_S: '0' }))).toEqual([
      expect.stringMatching(/^AMQP_HEARTBEAT_S: /),
    ]);
  });

  it('rejects a MONGODB_WRITE_W that is neither "majority" nor a number', () => {
    expect(problemsOf(() => loadConfig(schema, { ...required, MONGODB_WRITE_W: 'abc' }))).toEqual([
      expect.stringMatching(/^MONGODB_WRITE_W: /),
    ]);
  });

  it('rejects an undeclared LOG_LEVEL value', () => {
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
});

describe('envInt', () => {
  it('rejects a default below its own minimum when the schema is built', () => {
    expect(() => envInt(100, 50)).toThrow(/default 50 is below the minimum 100/);
  });

  it('accepts a default equal to its own minimum', () => {
    expect(() => envInt(5, 5)).not.toThrow();
  });

  const fragment = z.object({ N: envInt(2, 7) });

  it('applies the default when the variable is unset', () => {
    expect(loadConfig(fragment, {}).N).toBe(7);
  });

  it('accepts a value at the minimum', () => {
    expect(loadConfig(fragment, { N: '2' }).N).toBe(2);
  });

  it('rejects a value below the minimum', () => {
    expect(problemsOf(() => loadConfig(fragment, { N: '1' }))).toEqual([
      expect.stringMatching(/^N: /),
    ]);
  });

  it('rejects a non-integer value', () => {
    expect(problemsOf(() => loadConfig(fragment, { N: '2.5' }))).toEqual([
      expect.stringMatching(/^N: /),
    ]);
  });
});
```

#### `packages/shared/src/config.ts` (whole file)

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
  if (defaultValue < min) {
    // Fails when the module is imported, not when a service happens to read the variable:
    // `.default()` short-circuits parsing, so an out-of-range default is never re-checked.
    throw new Error(`envInt: default ${defaultValue} is below the minimum ${min}`);
  }
  return z.coerce.number().int().min(min).default(defaultValue);
}

/**
 * Validates `env` against `schema` once at startup. A variable that is empty or whitespace-only
 * counts as unset, so a `.env` copied from `.env.example` gets the defaults. Throws ConfigError
 * naming every missing or invalid variable; the service must let that end the process.
 */
export function loadConfig<S extends z.ZodType>(
  schema: S,
  env: NodeJS.ProcessEnv = process.env,
): z.output<S> {
  // Trimmed values are what gets parsed, not only what gets tested: `Number(' ')` is 0, so a stray
  // space would silently pass `.min(0)`, and a trailing newline from a mounted secret file would
  // reach the driver inside the connection string and fail far from its cause. The `undefined`
  // check is defensive about NodeJS.ProcessEnv's `string | undefined` type, not load-bearing.
  const present: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    const trimmed = value?.trim();
    if (trimmed !== undefined && trimmed !== '') {
      present[key] = trimmed;
    }
  }
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

### Task 8: Add the device-wide watermark type and the complete index and declaration options [mechanical]

**Files:** Modify `packages/shared/src/documents.ts`, `packages/shared/src/collections.ts`, `packages/shared/src/topology.ts`, Test `packages/shared/src/contract.test-d.ts`
**Invariant:** 2 (`unique: true` is now defined once, next to the key it belongs to) and 3 (`lastEvent` is the conditional device-wide watermark of decision 27) — proved by the literal `true` assertions and the `DeviceStateDocument` shape assertion in `contract.test-d.ts`, checked by `tsc -b`
**Verify:** `pnpm --filter @telemetry/shared test && pnpm --filter @telemetry/shared typecheck && pnpm --filter @telemetry/shared lint`

`EVENTS_IDENTITY_INDEX` carried the key pattern and the name but not `unique: true`, the one option invariant 2 depends on; the queue and exchange constants carried the arguments but not `durable: true`, which is checked at redeclaration exactly like the arguments. Both now exist as complete objects the services pass through unchanged. `DeviceStateDocument` gains the optional `lastEvent` watermark of decision 27; the type-level test pins it and excludes it from the one-section-per-event-type check.

- [ ] Replace `contract.test-d.ts` with the content below. Run the verify command: `tsc -b` fails on the missing exports and on the `lastEvent` shape (TS2344), which is the expected red.
- [ ] Replace `documents.ts`, `collections.ts` and `topology.ts` with the content below. Run the verify command: green.
- [ ] Commit — subject: `Add the device-wide watermark type and the complete index and declaration options`

#### `packages/shared/src/contract.test-d.ts` (whole file)

```ts
// Type-level assertions. Checked by `pnpm --filter @telemetry/shared typecheck` (tsc -b compiles
// the whole src tree); the Vitest unit project only runs *.test.ts, so nothing here executes.
import { expectTypeOf } from 'vitest';

import { EVENTS_IDENTITY_INDEX_SPEC } from './collections.js';
import type {
  AlertDocument,
  DeviceStateDocument,
  DeviceStateSection,
  EventDocument,
  LastEvent,
  SectionMeta,
} from './documents.js';
import type {
  CountersPayload,
  PayloadOf,
  TelemetryEventType,
  TelemetryMessage,
} from './message.js';
import {
  DEAD_LETTER_EXCHANGE_OPTIONS,
  DEAD_LETTER_QUEUE_OPTIONS,
  TELEMETRY_EXCHANGE_OPTIONS,
  TELEMETRY_QUEUE_OPTIONS,
} from './topology.js';

// The event-type list and the schema union agree.
expectTypeOf<TelemetryMessage['type']>().toEqualTypeOf<TelemetryEventType>();

// Every event type has exactly one optional section in the state document; the only other
// fields are the id and the device-wide watermark.
expectTypeOf<
  Exclude<keyof DeviceStateDocument, '_id' | 'lastEvent'>
>().toEqualTypeOf<TelemetryEventType>();
// Each section is pinned to its OWN event type: the keyof check above sees only key names, so
// without this a swap (status holding a diagnostic section) would compile cleanly.
expectTypeOf<DeviceStateDocument>().toEqualTypeOf<{
  _id: string;
  lastEvent?: LastEvent;
  status?: DeviceStateSection<'status'>;
  metrics?: DeviceStateSection<'metrics'>;
  counters?: DeviceStateSection<'counters'>;
  diagnostic?: DeviceStateSection<'diagnostic'>;
}>();

/**
 * No payload field may be named like a watermark field. The update pipeline builds a section as
 * `{ ...meta, ...payload }`, so a collision would overwrite the watermark and break invariant 1.
 * The mapped type is required: `keyof PayloadOf<TelemetryEventType>` is the intersection of the
 * four payload key sets, which is already `never`, so it would pass whatever happened.
 */
type SectionMetaCollision = {
  [T in TelemetryEventType]: keyof PayloadOf<T> & keyof SectionMeta;
}[TelemetryEventType];
expectTypeOf<SectionMetaCollision>().toBeNever();
// The four fields are inlined on purpose, not written as `SectionMeta & CountersPayload`:
// this is the only assertion that would catch a field added to or removed from SectionMeta.
expectTypeOf<DeviceStateSection<'counters'>>().toEqualTypeOf<
  { sessionId: number; seq: number; occurredAt: number; receivedAt: number } & CountersPayload
>();

// The event document narrows its payload by type and has no _id (the driver adds the ObjectId).
expectTypeOf<Extract<EventDocument, { type: 'counters' }>>().toEqualTypeOf<{
  deviceId: string;
  sessionId: number;
  seq: number;
  type: 'counters';
  occurredAt: number;
  receivedAt: number;
  processedAt: number;
  payload: CountersPayload;
}>();
expectTypeOf<Extract<keyof EventDocument, '_id'>>().toBeNever();

// Alerts are keyed by the message identity string. The whole shape is pinned: nothing else in the
// repository consumes AlertDocument yet, so this file is its only check.
expectTypeOf<AlertDocument>().toEqualTypeOf<{
  _id: string;
  deviceId: string;
  sessionId: number;
  seq: number;
  code: string;
  message: string;
  occurredAt: number;
  createdAt: number;
}>();

// The one index option invariant 2 depends on, and the declaration options both services must
// agree on, are literally `true` in the shared definitions (a redeclaration mismatch is a 406).
expectTypeOf(EVENTS_IDENTITY_INDEX_SPEC.unique).toEqualTypeOf<true>();
expectTypeOf(TELEMETRY_EXCHANGE_OPTIONS.durable).toEqualTypeOf<true>();
expectTypeOf(DEAD_LETTER_EXCHANGE_OPTIONS.durable).toEqualTypeOf<true>();
expectTypeOf(TELEMETRY_QUEUE_OPTIONS.durable).toEqualTypeOf<true>();
expectTypeOf(DEAD_LETTER_QUEUE_OPTIONS.durable).toEqualTypeOf<true>();
```

#### `packages/shared/src/documents.ts` (whole file)

```ts
import type { PayloadOf, TelemetryEventType } from './message.js';

/**
 * Watermark and provenance stored with every section (consistency spec, decision 7).
 * The three message fields come from the schema; `receivedAt` is stamped by ingest and has no
 * schema source. No payload may use these names — `contract.test-d.ts` enforces that, because the
 * update pipeline spreads the payload last and a collision would silently overwrite the watermark.
 */
export type SectionMeta = {
  sessionId: number;
  seq: number;
  occurredAt: number;
  receivedAt: number;
};

/** The newest unique event of one type, with its own `(sessionId, seq)` watermark. */
export type DeviceStateSection<T extends TelemetryEventType> = SectionMeta & PayloadOf<T>;

/**
 * Device-wide watermark: the newest unique event of any type (consistency spec, decision 27).
 * Advanced by the same conditional pipeline as the sections, only when the event is newer, so a
 * stale message still changes nothing. It is the "as of" marker of the document, the input for
 * liveness (`now - receivedAt`) and the reference for gap detection (`seq` skipped a value).
 */
export type LastEvent = {
  sessionId: number;
  seq: number;
  type: TelemetryEventType;
  receivedAt: number;
};

/**
 * One document per device in `device_state`; `_id` is the device id. A section is absent until
 * the first event of its type arrives. There is deliberately no unconditional `updatedAt`: every
 * field, `lastEvent` included, moves only when an event is newer than what is stored.
 */
export type DeviceStateDocument = {
  _id: string;
  lastEvent?: LastEvent;
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

#### `packages/shared/src/collections.ts` (whole file)

```ts
/** MongoDB names and index definitions (consistency spec, "MongoDB collections and indexes"). */
export const EVENTS_COLLECTION = 'events';
export const DEVICE_STATE_COLLECTION = 'device_state';
export const ALERTS_COLLECTION = 'alerts';

/** The dedup key (decision 9a), unique. Its prefixes serve per-device and per-session reads. */
export const EVENTS_IDENTITY_INDEX = { deviceId: 1, sessionId: 1, seq: 1 } as const;
export const EVENTS_IDENTITY_INDEX_NAME = 'identity_unique';

/**
 * The whole index description for `createIndexes`, so that `unique: true` — the one option
 * invariant 2 depends on — is defined once. Processing must create it before it consumes.
 */
export const EVENTS_IDENTITY_INDEX_SPEC = {
  key: EVENTS_IDENTITY_INDEX,
  name: EVENTS_IDENTITY_INDEX_NAME,
  unique: true,
} as const;

/** Server error code of a unique-index violation (`DuplicateKey`); the driver has no named constant. */
export const DUPLICATE_KEY_ERROR_CODE = 11000;
```

#### `packages/shared/src/topology.ts` (whole file)

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

/** Exchange types are part of the declaration, so a mismatch is a 406 just like a wrong argument. */
export const TELEMETRY_EXCHANGE_TYPE = 'direct';
export const DEAD_LETTER_EXCHANGE_TYPE = 'fanout';

/**
 * Quorum queue, dead-lettered after the fifth delivery attempt (decisions 13 and 19).
 * `x-dead-letter-strategy` is deliberately left at its `at-most-once` default: `at-least-once`
 * would additionally require `overflow: reject-publish`, the `stream_queue` feature flag and a
 * `max-length` bound, and it buys nothing here because nothing consumes `telemetry.dead` — the
 * dead-lettered messages are informational and read in the management UI (trade-off T8).
 * https://www.rabbitmq.com/docs/quorum-queues#dead-lettering
 */
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

/**
 * Declaration options, complete: `durable` is checked at redeclaration exactly like the arguments,
 * so both services pass these objects unchanged to `assertExchange` and `assertQueue`.
 */
export const TELEMETRY_EXCHANGE_OPTIONS = { durable: true } as const;
export const DEAD_LETTER_EXCHANGE_OPTIONS = { durable: true } as const;
export const TELEMETRY_QUEUE_OPTIONS = {
  durable: true,
  arguments: TELEMETRY_QUEUE_ARGUMENTS,
} as const;
export const DEAD_LETTER_QUEUE_OPTIONS = {
  durable: true,
  arguments: DEAD_LETTER_QUEUE_ARGUMENTS,
} as const;
```

### Task 9: Keep the `assertNever` message when the value cannot be serialised [mechanical]

**Files:** Modify `packages/shared/src/assert-never.ts`, Test `packages/shared/src/assert-never.test.ts`
**Invariant:** none touched (review B9)
**Verify:** `pnpm --filter @telemetry/shared test && pnpm --filter @telemetry/shared typecheck && pnpm --filter @telemetry/shared lint`

`JSON.stringify` throws on a BigInt and on a circular value, so the exhaustiveness guard reported `Converting circular structure to JSON` instead of the context and the variant. The rendering is wrapped; `String(value)` is the fallback.

- [ ] Replace `assert-never.test.ts` with the content below. Run the verify command: the new case fails with the `TypeError`.
- [ ] Replace `assert-never.ts` with the content below. Run the verify command: green.
- [ ] Commit — subject: `Keep the assertNever message when the value cannot be serialised`

#### `packages/shared/src/assert-never.test.ts` (whole file)

```ts
import { describe, expect, it } from 'vitest';

import { assertNever } from './assert-never.js';

describe('assertNever', () => {
  it('throws with the serialised value so the unhandled variant is visible in the error', () => {
    expect(() => assertNever({ type: 'unknown' } as never, 'unhandled event')).toThrow(
      'unhandled event: {"type":"unknown"}',
    );
  });

  it('falls back to a generic prefix when no context is given', () => {
    expect(() => assertNever('x' as never)).toThrow('unhandled variant: "x"');
  });

  it('still names the variant when the value cannot be serialised as JSON', () => {
    // JSON.stringify throws on both; the guard's own error must win, not a TypeError.
    const circular: Record<string, unknown> = {};
    circular['self'] = circular;
    expect(() => assertNever(circular as never, 'circular')).toThrow(
      /^circular: \[object Object\]$/,
    );
    expect(() => assertNever(10n as never, 'bigint')).toThrow(/^bigint: 10$/);
  });
});
```

#### `packages/shared/src/assert-never.ts` (whole file)

```ts
/**
 * Exhaustiveness guard for discriminated unions. Reaching it at runtime means a
 * new variant (for example a new telemetry event type) was added without being
 * handled, so it fails loudly with the offending value instead of silently
 * ignoring it.
 */
export function assertNever(value: never, context = 'unhandled variant'): never {
  throw new Error(`${context}: ${render(value)}`);
}

/** `JSON.stringify` throws on a BigInt and on a circular value; the guard's own message must win. */
function render(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}
```

### Task 10: Tighten the Node range, lint every script extension, enforce the argument rule and fail the unit project on zero tests [mechanical]

**Files:** Modify `package.json`, `eslint.config.js`, `vitest.config.ts`
**Invariant:** none touched (review B10)
**Verify:** `pnpm lint && pnpm typecheck && pnpm test && pnpm format:check`

`engines.node` admitted 24.0–24.9, where `--env-file-if-exists` is still experimental (the shared-contract spec already asked for `>=24.10`). ESLint's flat config lints only the extensions its `files` patterns name, so `.mjs`, `.cjs`, `.mts`, `.cts` were unlinted and a `.js` helper escaped `no-console`. `max-params` makes the "three or more arguments take a named object" half of decision 14 mechanical instead of a habit; probe 2026-09-12: the rule fails on exactly one signature today, the three-parameter `FrameTooLongError` constructor that task 4 already reduces to two, so it is green from task 4 onwards. `passWithNoTests: true` at the root let a broken unit `include` glob pass with zero tests; scoped to the integration project (empty until step 7) the unit project fails on zero tests — probe 2026-09-12: with the unit glob broken `pnpm test` exits 1.

- [ ] Replace the three files with the content below.
- [ ] Run the verify command: green with 151 tests.
- [ ] Prove the guard once: change the unit `include` to `'{apps,packages}/*/src/**/*.nomatch.ts'`, run `pnpm test` (exit code 1), restore the file, run `pnpm test` (exit code 0). Do not commit the probe.
- [ ] Commit — subject: `Tighten the Node range, lint every script extension, enforce the argument rule and fail the unit project on zero tests`

#### `package.json` (whole file)

```json
{
  "name": "telemetry-monorepo",
  "private": true,
  "type": "module",
  "packageManager": "pnpm@10.29.2",
  "engines": {
    "node": ">=24.10 <25",
    "pnpm": ">=10"
  },
  "scripts": {
    "build": "tsc -b",
    "typecheck": "tsc -b",
    "lint": "eslint .",
    "lint:fix": "eslint . --fix",
    "format": "prettier --write .",
    "format:check": "prettier --check .",
    "test": "vitest run",
    "test:unit": "vitest run --project unit",
    "test:integration": "vitest run --project integration",
    "test:watch": "vitest"
  },
  "devDependencies": {
    "@eslint/js": "catalog:",
    "@types/node": "catalog:",
    "eslint": "catalog:",
    "eslint-config-prettier": "catalog:",
    "prettier": "catalog:",
    "typescript": "catalog:",
    "typescript-eslint": "catalog:",
    "vitest": "catalog:"
  }
}
```

#### `eslint.config.js` (whole file)

```js
// @ts-check
import js from '@eslint/js';
import prettier from 'eslint-config-prettier/flat';
import { defineConfig, globalIgnores } from 'eslint/config';
import tseslint from 'typescript-eslint';

export default defineConfig([
  globalIgnores(['**/dist/**', '**/node_modules/**', '**/coverage/**']),
  {
    files: ['**/*.{js,mjs,cjs}'],
    extends: [js.configs.recommended],
    rules: {
      // Services log through the shared structured logger (CLAUDE.md "Conventions").
      'no-console': 'error',
    },
  },
  {
    files: ['**/*.{ts,mts,cts}'],
    extends: [js.configs.recommended, tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Services log through the shared structured logger (CLAUDE.md "Conventions").
      'no-console': 'error',
      '@typescript-eslint/no-non-null-assertion': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/switch-exhaustiveness-check': 'error',
      // Three or more arguments take a single named object (shared-contract spec, decision 14).
      'max-params': ['error', 2],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
    },
  },
  {
    // Root config files are not part of any tsconfig; lint them without type information.
    files: ['*.config.{ts,mts}'],
    extends: [tseslint.configs.disableTypeChecked],
  },
  prettier,
]);
```

#### `vitest.config.ts` (whole file)

```ts
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Tests run against the current sources of the shared package; its `exports`
// (dist/) is only for runtime, so no build is needed before `pnpm test`.
const sharedSource = fileURLToPath(new URL('./packages/shared/src/index.ts', import.meta.url));

export default defineConfig({
  resolve: {
    alias: { '@telemetry/shared': sharedSource },
  },
  test: {
    environment: 'node',
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          include: ['{apps,packages}/*/src/**/*.test.ts'],
        },
      },
      {
        // Real RabbitMQ + MongoDB from docker compose; longer timeouts, one file at a time.
        // Empty until step 7; the unit project must never pass with zero tests, so the
        // allowance is scoped here and removed when the first integration file lands.
        extends: true,
        test: {
          name: 'integration',
          include: ['{apps,packages}/*/test/integration/**/*.test.ts'],
          passWithNoTests: true,
          testTimeout: 30_000,
          hookTimeout: 60_000,
          fileParallelism: false,
        },
      },
    ],
  },
});
```

## Verification Criteria

| #   | Criterion                                                                                                                                                                                                                             | How to verify                                                                                                                                                                                                                      |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | The consistency spec has decisions 25–29 and trade-offs T14–T17, and the phrase "compare in the filter" no longer appears anywhere                                                                                                    | `test "$(grep -c '^. 2[5-9] ' docs/specs/2026-09-11-telemetry-consistency-design.md)" = 5`, `test "$(grep -c '^. T1[4-7] ' …)" = 4`, `test "$(grep -c 'compare in the filter' …)" = 0` (the `.` stands for the leading table pipe) |
| 2   | `.env.example` lists exactly 22 variables, each with an empty value                                                                                                                                                                   | `test "$(grep -c '^[A-Z_]*=$' .env.example)" = 22`; `sed 's/=.*/=<set>/' .env.example` shows no value                                                                                                                              |
| 3   | Logging an error whose message embeds `amqp://user:PASS@host`, through any of eight call shapes including a child logger, and a `URL` value, a nested `toJSON` result and a throwing `toJSON`, never prints `PASS` and keeps the host | `packages/shared/src/logger.test.ts`, `never prints the password for …`, the three `toJSON` cases                                                                                                                                  |
| 4   | The shutdown rule in the `createLogger` comment matches the installed pino: `flush(cb)` calls back while the write is in flight, and an immediate `process.exit(0)` still prints every line                                           | Probe rerun (research section): `node -e` with 2 000 lines, and with 500 × 8 KB lines into a reader sleeping 300 ms, piped and redirected — every line present, none truncated                                                     |
| 5   | A rejected frame's identity is bounded: a 100 000-character `deviceId` is cut to 64; `Infinity`, `NaN`, `2 ** 53` and `1.5` are dropped                                                                                               | `packages/shared/src/identity.test.ts`                                                                                                                                                                                             |
| 6   | `FrameDecoder.push` never throws; the frames before an oversized line are returned with the error; a tail plus a chunk exceeding the limit is rejected as one line                                                                    | `packages/shared/src/framing.test.ts`                                                                                                                                                                                              |
| 7   | An escaped newline inside a string payload round-trips as one frame                                                                                                                                                                   | `framing.test.ts`, `keeps a newline inside a string value escaped`                                                                                                                                                                 |
| 8   | 65 536 one-byte pushes complete in under 150 ms and the line is then decoded whole                                                                                                                                                    | `framing.test.ts`, `costs one scan per byte …` (probe: 11–13 ms)                                                                                                                                                                   |
| 9   | `sessionId` outside 1.5e12–4.1e12, beyond the safe range, a negative `occurredAt`, a percent outside 0–100 and `dev:0001` are rejected with the expected code and path                                                                | `packages/shared/src/message.test.ts` (41 invalid rows)                                                                                                                                                                            |
| 10  | Every failing field path survives the decode-detail cap; the parser message is capped                                                                                                                                                 | `packages/shared/src/decode.test.ts`                                                                                                                                                                                               |
| 11  | A value with surrounding whitespace or a trailing newline is parsed trimmed                                                                                                                                                           | `packages/shared/src/config.test.ts`                                                                                                                                                                                               |
| 12  | `unique` and `durable` are literally `true` in the shared definitions; `DeviceStateDocument` has `lastEvent?` and exactly one section per event type                                                                                  | `pnpm --filter @telemetry/shared typecheck` compiles `contract.test-d.ts`; removing `unique: true` fails it with TS2344                                                                                                            |
| 13  | A broken unit `include` glob fails `pnpm test`; the empty integration project does not                                                                                                                                                | Task 10 step 3 (probe, not committed)                                                                                                                                                                                              |
| 14  | The whole workspace is green                                                                                                                                                                                                          | `pnpm lint && pnpm typecheck && pnpm test && pnpm format:check` — 151 tests                                                                                                                                                        |
| 15  | Ten small imperative commits without assistant attribution                                                                                                                                                                            | `git log --format='%s%n%b' fd964f6..HEAD` shows no `Co-Authored-By` and no mention of Claude or an AI tool                                                                                                                         |

## Test Plan

- Tasks 2–9 run `pnpm --filter @telemetry/shared test && pnpm --filter @telemetry/shared typecheck && pnpm --filter @telemetry/shared lint`; Task 1 runs `pnpm format:check` plus the four `grep` assertions; Task 10 runs the full pre-flight.
- All tests in this plan are unit tests under `packages/shared/src/*.test.ts`; none needs Docker Compose. `contract.test-d.ts` is checked by `tsc -b` only.
- Every task replaces whole files with content that already passed the pre-flight, so a red verify after a task means a copy error: diff the file against this plan before debugging anything else.
- Full pre-flight at the end: `pnpm lint && pnpm typecheck && pnpm test && pnpm format:check`. Expected unit test count: 151 — assert-never 3, framing 19, logger 31, identity 18, config 18, message 46, decode 16 (Vitest's per-file line).

## Checkpoint Recovery

If interrupted mid-implementation, resume by:

1. Read this plan.
2. Run `git log --oneline fd964f6..HEAD` and match the subjects against the task commits above (one commit per task, in order).
3. Run the scoped verify command; if it is red, the current task's files are on disk but not finished — re-copy that task's files from this plan and re-run.
4. Pick up from the first task without a commit. Tasks 2–9 are independent of each other; Task 8 must land before any app imports `EVENTS_IDENTITY_INDEX_SPEC` or the `*_OPTIONS` constants (step 4 and step 5).
