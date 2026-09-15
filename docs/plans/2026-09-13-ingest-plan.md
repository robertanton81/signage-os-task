> **STATUS: SHIPPED 2026-09-13.** Landed as 30 commits, `40b3cd5..d2f795a`: the spec and plan commit, one or more commits per task, and the fixes the reviews asked for. The other session's commits in that range (`47baa44`, `0145604`, `34f75aa`, `e2fd497`, `4913afb`, `4334813`) are not counted. The full pre-flight passed right before the last commit: `pnpm format:check && pnpm lint && pnpm typecheck && pnpm test`, 538 tests in 28 files, 209 of them in `apps/ingest`. The unchecked `- [ ]` boxes below are historical; the work is done. **Do not re-execute this plan.** If you are changing ingest, work directly in `apps/ingest/src/`.
>
> **Library and version drift:** none. amqplib 2.0.1, zod 4.6.2, vitest 4.1.11, TypeScript 6.0.3 and Node 24.21.0 are as pinned, and amqplib ships its own types. Four facts from the library, runtime and broker sources shaped the code, and the plan did not describe them:
>
> - amqplib 2.0.1, `lib/channel.js`: a channel registers its own `close` listener in its constructor, and that listener fails every unconfirmed publish callback with "channel closed". `publisher.ts` therefore prepends its channel `close` listener, so a closed channel recycles as `channel_closed`, not as `nacked`.
> - amqplib 2.0.1, `lib/channel_model.js` forwards only `error`, `close`, `blocked`, `unblocked` and `update-secret-ok` from the connection, so only the channel has a `handler-error` listener. `lib/connection.js` emits no `error` for a CONNECTION_FORCED close, so the error the connection closed with goes into the backoff `warn` line.
> - Node 24.21.0: a socket accepted with `pauseOnConnect` already has `readableFlowing` false (`lib/net.js`, `pauseOnCreate`), so `DeviceConnection` does not pause it again, and its `timeout` starts undefined, so the constructor sets `setTimeout(0)`. A server socket's `data` chunk is at most 65 536 bytes. `http.Server#timeout` defaults to 0.
> - RabbitMQ 4.3: the `guest` user may log in only from inside the container, so the scripted run creates its own user through `RABBITMQ_DEFAULT_USER` and `RABBITMQ_DEFAULT_PASS`.
>
> **Plan prescriptions that needed adjustment:**
>
> - Task 1: the spec, the plan and the amendments landed as the user's own commit `40b3cd5`; `/implement` added no commit for it.
> - Task 2: the moved backoff test's fifth case compared a call with itself; it became an exact scaling check. The emulator's `BACKOFF_*` constants stay private to `apps/emulator/src/connection.ts`. The new emulator retry-delay test calls `vi.isFakeTimers()` before it spies on `setTimeout`, because the first `vi.waitFor` builds vitest's fake timers, which call the global `setTimeout(NOOP, 0)` once.
> - Task 3: the `RABBITMQ_URL` rejections include the look-alikes `amqpx://` and `amqp//`, and every rejection asserts the full fixed message.
> - Task 4: `INGEST_PORT` uses `.min(1, { abort: true })` and `.max(65_535, { abort: true })`. Without `abort`, zod runs the `superRefine` after a range error and adds a misleading "must differ from HEALTH_PORT" line.
> - Task 5: the publish-arguments table compares `content` separately, because `expect.any(Buffer)` is typed `any` and fails lint. A multi-byte UTF-8 case guards against a latin1 encoding.
> - Spec correction `11636e8`: `socket.pause()` does not stop a socket's handle. Only a socket that was never resumed, or one whose buffer is full, misses the peer's FIN or reset (probes in `.local/research/2026-09-13-paused-*.mjs`).
> - Task 6: only an odd cap (3) tells `Math.floor` from `Math.ceil`, so the window tests use one.
> - Task 7: `StallClock` takes named objects, `onSent({ now, sentCount })`, `onAck({ now, sentCount })` and `isStalled({ now, timeoutMs })`; the plan's positional signatures broke the rule for two arguments of the same type. `onSent` starts the wait only when the sent count rises to 1.
> - Task 8: `connecting` is two variants, and the failed one carries the first trigger's reason, which the spec's type could not hold. The row tests are one 36-case table.
> - Task 9: the plan's close test with a silent socket proved nothing, because `server.close()` ends idle connections; the test pipelines a complete and an unfinished request instead. `server.timeout` defaults to 0, so `HEALTH_IDLE_TIMEOUT_MS` (10 s) bounds a connection that never sends a request. HEAD and PUT answer 404.
> - Task 10: events dispatched while effects run are queued, so a publish that throws inside `send_pending` cannot start a transition in the middle of another. A model is closed once per handle, and `stop()` waits for every close in flight. `AMQP_RECONNECT_MAX_MS` is taken from `BACKOFF_RESET_AFTER_MS`. The plan gave the shell no test file; after review, `publisher.test.ts` tests `stop()` without a broker, `parseMessageId` moved to `amqp-message.ts` with tests, and the stall guard became the tested pure function `isConfirmStall`.
> - Task 11: `DeviceConnection` has a `pendingBytes` getter, which the close line and two tests read. Test 10 became three tests, 10a to 10c. A device with `allowHalfOpen: true` never sees a close when the server destroys its half-closed socket with nothing unread, because no RST is sent (`.local/research/2026-09-13-half-open-destroy-probe.mjs`), so test 10b waits for the server's close line.
> - Task 12: `main()` is async, and the publisher and the server are constructed before the lifecycle handlers. The unref'd summary interval is not cleared at shutdown. The manual check ran as `.local/research/2026-09-13-ingest-no-broker-run.mjs`, and `main.test.ts` covers the same ground in a child process, like the emulator's process test.
> - Task 13: see the run's evidence below. Scenario 2 recycles as `channel_closed`, and scenario 5's early drain shows as a missing budget warning.
> - Task 14: rows T26 to T37 sit between the T19–T25 block and the T38–T39 block of the consistency spec, and T36 has the narrowed wording.
>
> **Corrections applied during review:**
>
> - Tasks 2 to 9, before the pause: the second commit of each task (`ae82329`, `e927d5a`, `306ac24`, `526afec`, `bcef6df`, `0ca0b1a`, `62f8c3b`, `76cfe73`) holds the fixes from that task's review, as its message describes.
> - Task 10, test quality (3 blocking): the failure branches of `parseMessageId`, `stop()` from backoff and during a connect attempt, and the confirm-stall guard had no evidence; fixed in `0ba20e9`, with T36 narrowed in `3cbd838`. Code review (1 blocking): the `publish threw` and `publish nacked` debug lines lacked the message identity; fixed in `a7d7bbc`.
> - Task 11, test quality (3 blocking): the soft cap, `stats()` for an open connection and the `error` close reason were untested; fixed in `1f4ff00`, which also took two code-review suggestions, a readiness change during the drain and `lastDeviceId` on the error line.
> - Task 12, test quality (1 blocking): the process test checked six outcomes with plain `expect`, so one failure hid the rest; fixed in `702e79e` with `expect.soft`, plus a check that `/readyz` answers `shutting_down` during the drain.
> - Spec `f964e9c`: decision 12 now matches the shipped publisher, and the Tests section lists the tests that shipped.
>
> **Mutation testing**, always in a separate worktree: every mutant of the new Task 10–12 tests made them fail, 39 distinct mutants in all (17 and 8 for the server, 7 for the entry point, 7 for the publisher). Two changes cannot be observed and have no test: dropping a `pause()` before the `data` listener (see above), and dropping the frames decoded before an oversized line, because one data chunk never exceeds the 64 KiB frame limit. The scripts and outputs are in `.local/research/`.
>
> **Deferrals worth tracking:**
>
> - Step 6: give ingest a Compose `stop_grace_period` above `SHUTDOWN_TIMEOUT_MS + AMQP_CLOSE_TIMEOUT_MS` (12 s; the spec suggests 15 s) and an exec-form `CMD`. Decide whether the test-support files (`fixtures.ts`, `test-publisher.ts`, `test-device.ts`, `test-source-hooks.ts`) belong in `dist/`.
> - Step 7: automated broker tests of the publisher. T36 names the two paths no run reaches: the confirm-stall recycle, and a stop during a connect attempt that the broker completes.
> - Entry point: no guard against a SIGTERM between the startup steps, no structured line for a configuration error before the handlers exist (the emulator behaves the same), and no test of the startup order or of the summary line.
> - Publisher: no catch around the rest of a connect attempt (a throw there is a programmer error, and the lifecycle handler exits 1), and `#backoffTimer` is not unref'd.
> - Tests: `main.test.ts` pre-allocates its ports, which another process can take first (the emulator's accepted pattern). The health tests have no seam test for the error logged after `listen`, and the explicit 10 s timeout of the in-flight close test is not explained. The long publisher-state walk is not split, and `Window` has no guard against a cap below 1 (the config schema enforces the minimum).
> - Emulator, from before this plan: `apps/emulator/src/random.ts` passes pairs of numbers positionally (`int`, `range`, `deviceSeed`).
>
> **Process notes:** two sessions worked against `main` at the same time, and the user paused this one until the other had finished. Mutants run only in a separate worktree under a process-group timeout, because an endless mutant in the main tree once hung the other session's tests. Every commit was gated with `&&` on lint, typecheck, tests and format, and a mutant count went into a commit message only after the script had printed it.
>
> **Scripted run against RabbitMQ (Task 13), 2026-09-13.** `node .local/research/2026-09-13-ingest-scripted-run.mjs` ran the built entry point of `702e79e` as a child process (`AMQP_HEARTBEAT_S=2`, `LOG_LEVEL=debug`) against a throwaway `rabbitmq:4.3-management` container that reported RabbitMQ 4.3.5 (Erlang 27.3.4.17). All six scenarios passed; the output is in `.local/research/2026-09-13-ingest-scripted-run-final-output.txt`. Re-run on 2026-09-13 during `/verify` at `c1c9d3e`, again against RabbitMQ 4.3.5: every scenario passed again, and scenario 7 below was added because the broker restart of scenario 2 rarely catches an unconfirmed message; the outputs are `.local/research/2026-09-13-ingest-scripted-run-verify-output.txt` (six scenarios, before the addition) and `.local/research/2026-09-13-ingest-scripted-run-7-scenarios-output.txt`.
>
> 1. **Normal publish.** Two devices sent 20 frames: 20 confirms, 20 messages in `telemetry.events`, 20 distinct ids. A peeked message had `message_id` `probe-a:1700000000000:1`, `content_type` `application/json`, `delivery_mode` 2, `timestamp` 1789316761 (seconds) and `x-received-at` 1789316761133 (milliseconds).
> 2. **Broker restart while devices send.** 56 frames at 10 per second across `docker restart`. `/readyz` answered 503 `connecting` during the restart. The publisher recycled once with reason `channel_closed` and err `CONNECTION_FORCED - broker forced connection closure with reason 'shutdown'`, skipped the close because the connection had already closed, and retried three times while the broker started. The queue held all 56 frames, none missing. In this run no message was unconfirmed at the moment of the restart; the earlier run of the same script, on `986e9cb`, had one, and it was published again after the reconnect. Scenario 7 reaches that republish on every run.
> 3. **Queue deleted while running.** The delete answered 204. The next frame came back as `message returned` at `error` with its identity, the publisher recycled with reason `returned` and declared the queue again, and the message was in it.
> 4. **Resource alarm.** After `set_vm_memory_high_watermark 0.0000001`, `connection blocked` was logged at `warn`, `/readyz` answered 503 `blocked`, and a device's `write()` returned `false` once the paused sockets' buffers had filled (5001 frames). Decision 14's heartbeat question: no recycle happened during the 8 s alarm with a 2 s heartbeat. After the watermark went back to 0.6, `connection unblocked` was logged, and all 5001 frames were in the queue, none missing.
> 5. **SIGTERM with devices connected.** Exit code 0 after 14 ms. Both devices received FIN and closed, no drain budget warning appeared, and the lines were `shutting down`, `connection closed` twice, `publisher stopping`, `amqp connection close` and `stopped`.
> 6. **Invalid frames.** After a restart of the ingest process, `{"type":"bogus"}` and `not json` produced two `frame rejected` lines at `warn` (`invalid_schema`, then `invalid_json`). The queue held only the valid frame written after them, and the connection stayed open.
> 7. **Broker frozen with messages in flight** (added 2026-09-13 during `/verify`). After `docker pause`, a device sent 200 frames: all 200 were published into the frozen broker and none was confirmed. amqplib's heartbeat check logged `amqp connection error` with `Heartbeat timeout`, and the publisher recycled as `channel_closed` 4753 ms after the pause, a little over `2 × AMQP_HEARTBEAT_S`; `/readyz` answered 503 `connecting`. After `docker unpause` the reconnect published all 200 again and every one was confirmed. The queue held 258 messages, 200 distinct, none missing: the broker had also enqueued 58 of the frames it read from the old socket before it processed the close, the at-least-once duplicate that processing's dedup absorbs (decision 12).
>
> Differences from the scenario text of Task 13 below: scenario 2 recycles as `channel_closed`, not `connection_closed`, because amqplib closes the channels before it emits the connection's `close`; scenario 5 has no log line with the drain numbers, so the early finish shows as the missing budget warning, exit code 0 and the 14 ms; the broker user comes from `RABBITMQ_DEFAULT_USER` and `RABBITMQ_DEFAULT_PASS`, because `guest` may log in only from inside the container; every scenario drains the queue and compares distinct message ids, because a requeued peek counts toward the quorum queue's delivery limit. Scenario 7 is not in Task 13; it was added during `/verify` of this plan.
>
> **Plan text below is preserved as written. Treat the live code as authoritative.**

# Socket Ingest Service Implementation Plan

**Goal:** Build `apps/ingest` so that any number of stateless instances accept long-lived device sockets, validate every frame with the shared schema, publish every valid message to RabbitMQ with publisher confirms, keep every message until the broker acks it, survive a broker outage without dropping or disconnecting devices, report readiness on `/readyz`, and drain on SIGTERM.

**Approach:** Fourteen tasks in dependency order, each one module plus its tests plus one commit. Task 1 commits the approved spec and the amendments it made to the older specs. Tasks 2–3 move two helpers into `packages/shared` and add the two shared config changes. Tasks 4–8 build the **pure core** of ingest (configuration, publish arguments, windows, ledger, the publisher state machine) with direct unit tests. Tasks 9–12 build the **impure shell** (health server, amqplib publisher, socket server, entrypoint); the socket server is tested against real `net` clients and an in-memory `PublishPort`, never a mocked socket and never a mock of amqplib. Task 13 runs the amqplib shell against a real RabbitMQ 4.3 container in a scripted run and records the evidence in this plan. Task 14 ticks `TODO.md` and appends the trade-offs.

As in the emulator plan, every task gives exact paths, the exported signatures in full, every constant and the enumerated test cases; function bodies are not transcribed, because the design spec fixes every rule they implement (by decision number) and a transcript would only drift from it.

**Design spec:** `docs/specs/2026-09-13-ingest-design.md` (approved 2026-09-13 after two `design-reviewer` rounds, `.local/reviews/2026-09-13-ingest-design-review.md`). Binding above it: `docs/specs/2026-09-11-telemetry-consistency-design.md` and `docs/specs/2026-09-11-shared-contract-design.md`, both amended by the spec's section "Amendments to earlier specs".
**TODO items:** `4. Socket ingest služba` — all eight items. Step 7 gained one item (the automated broker tests of the publisher) that this plan does **not** execute.
**Branch:** `main`, direct, small atomic commits (the repository's practice; the history is part of the assessment). No `Co-Authored-By`, no AI mention.
**Scope:** `apps/ingest/**`, `packages/shared/src/{backoff,lifecycle,config}.ts` and tests, `apps/emulator/src/{connection,main}.ts` (they import the moved helpers), `pnpm-workspace.yaml`, `.env.example`, `TODO.md`, the consistency spec's trade-off table.

## Assumptions decided without asking (standing instruction: work autonomously, log every decision)

| #   | Assumption                                                                                                                                                              | Basis                                                                                                  |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| A1  | The spec and the four amended files are committed together as Task 1, before any code, exactly as `a1f3736` committed the emulator spec with its amendments.            | The user asked for it; the emulator precedent.                                                         |
| A2  | amqplib 2.0.1 ships its own types (`"types": "./index.d.ts"` in its `package.json` at tag v2.0.1); no `@types/amqplib` is added.                                        | Verified against the package manifest on 2026-09-13; `@types/amqplib` is at 0.10.8 and predates 1.0.0. |
| A3  | The scripted broker run uses `docker run` of `rabbitmq:4.3-management` (tag verified with `docker manifest inspect`), not a Compose file — Compose is step 6.           | Spec decision 25; OrbStack is running (`docker info` checked this session).                            |
| A4  | The moved helpers keep their behaviour; the only visible change is `backoffDelay`'s argument object and the lifecycle success line `stopped`.                           | Spec decision 20.                                                                                      |
| A5  | The emulator's `BACKOFF_BASE_MS` and `BACKOFF_MAX_MS` move into `apps/emulator/src/connection.ts` (their only caller) when `backoff.ts` is deleted.                     | Spec, "Changes to `packages/shared`".                                                                  |
| A6  | The scripted run's evidence goes into this plan's `STATUS` header when it ships (the emulator plan's format); the script itself lives in gitignored `.local/research/`. | Spec decision 25 ("evidence recorded in the plan").                                                    |
| A7  | The `PublishPort` gains nothing beyond the spec; the summary line reads counters from the concrete `AmqpPublisher` and `IngestServer`, which `main.ts` holds anyway.    | KISS; the port stays minimal for the in-memory test implementation.                                    |
| A8  | The RabbitMQ default credentials used by the scripted run stay inside the gitignored script and are never printed; the logger redacts the URL in every line anyway.     | `CLAUDE.md`, Secrets; shared-contract decision 3.                                                      |

## Research (source links)

Everything below was verified in the design spec's Research section (amqplib source at tag `v2.0.1`, Node source at `v24.21.0`, live RabbitMQ 4.3 pages); the links are repeated here so the plan stands alone, plus the typing facts this plan adds.

- [amqplib `index.d.ts` at v2.0.1](https://github.com/amqp-node/amqplib/blob/v2.0.1/index.d.ts) — `connect(url: string | Options.Connect, socketOptions?: SocketOptions): Promise<ChannelModel>`; `ChannelModel` has `close(): Promise<void>`, `createConfirmChannel(): Promise<ConfirmChannel>` and typed `on` overloads for `close` (`(err?: Error)`), `error`, `blocked` (`(reason: string)`), `unblocked`, `handler-error` (`(err: Error, eventName: string)`); `Channel` has typed `on` for `close`, `error`, `return` (`(message: Message)`), `handler-error`, plus `assertExchange`, `assertQueue`, `bindQueue`; `ConfirmChannel#publish(exchange, routingKey, content, options?, callback?: (err: any, ok) => void): boolean`; `IllegalOperationError` is exported. Tasks 8 and 10.
- [amqplib `lib/properties.d.ts` at v2.0.1](https://github.com/amqp-node/amqplib/blob/v2.0.1/lib/properties.d.ts) — `SocketOptions` has `timeout?: number` and `clientProperties?: Record<string, unknown>`; `Options.Publish` has `mandatory`, `persistent`, `contentType`, `headers: any`, `messageId`, `timestamp: number`; `Message` has `content`, `fields`, `properties` with `messageId: any | undefined` and `headers`. Tasks 5 and 10.
- [amqplib `lib/channel_model.js` at v2.0.1](https://github.com/amqp-node/amqplib/blob/v2.0.1/lib/channel_model.js) — `ConfirmChannel#publish` runs the plain publish (which throws `IllegalOperationError` on a closed channel) **before** it records the callback; `ChannelModel#close()` is the promisified `Connection#close`. Task 10's `try` around `publish` and the `markSent` guard.
- [amqplib `lib/connection.js` at v2.0.1](https://github.com/amqp-node/amqplib/blob/v2.0.1/lib/connection.js) — `toClosed` replaces `close` with a function that calls back with `IllegalOperationError`, so `close()` after the `close` event rejects; a second `close()` during a close throws, which `promisify` turns into a rejection. Task 10's `close_model` effect.
- [amqplib `lib/heartbeat.js` at v2.0.1](https://github.com/amqp-node/amqplib/blob/v2.0.1/lib/heartbeat.js) — the client times out after two consecutive intervals without a received frame. Task 13's resource-alarm scenario.
- [Node `net`](https://nodejs.org/api/net.html) — `pauseOnConnect`, `allowHalfOpen` (default `false`), `keepAlive`, `keepAliveInitialDelay`, `server.close()` keeps existing connections, `socket.setTimeout(0)` disables the timer, `socket.end()` half-closes. [Node `http`](https://nodejs.org/api/http.html) — `server.closeAllConnections()` after `server.close()`. [Node `lib/net.js` at v24.21.0](https://github.com/nodejs/node/blob/v24.21.0/lib/net.js) — a `pauseOnCreate` socket never starts its handle reading until `resume()`; `Socket#pause()` defers to `stream.Duplex.prototype.pause`, so `readableFlowing` becomes `false` (the assertion the socket tests use). Tasks 9 and 11.
- [RabbitMQ publishers](https://www.rabbitmq.com/docs/publishers), [confirms](https://www.rabbitmq.com/docs/confirms), [alarms](https://www.rabbitmq.com/docs/alarms), [queue length limit](https://www.rabbitmq.com/docs/maxlength), [property conversions](https://www.rabbitmq.com/docs/conversions) — streaming confirms, `basic.return` before `basic.ack`, blocked connections, `reject-publish` nacks, `timestamp` in seconds. Tasks 5, 8 and 13.
- [RabbitMQ management HTTP API](https://www.rabbitmq.com/docs/management#http-api) — `GET /api/queues/{vhost}/{name}` (message counts), `POST /api/queues/{vhost}/{name}/get` (peek at messages), `DELETE /api/queues/{vhost}/{name}`; the vhost `/` is written `%2F`. Task 13.
- [`rabbitmqctl set_vm_memory_high_watermark`](https://www.rabbitmq.com/docs/memory) — a fraction such as `0.0000001` raises the memory alarm at once; the default is `0.6`. Task 13.
- [Docker Compose `stop_grace_period`](https://docs.docker.com/reference/compose-file/services/) — default 10 s; the spec requires step 6 to set it above `SHUTDOWN_TIMEOUT_MS + AMQP_CLOSE_TIMEOUT_MS`. Recorded for step 6, nothing to do here.
- `packages/shared/src/config.ts:29` — `envInt(min, defaultValue)` returns `z.coerce.number().int().min(min).default(defaultValue)`; a `.max()` cannot follow a `.default()` (zod 4.6.2, `ZodDefault` exposes only `unwrap`/`removeDefault`), which is why the two ports are written out. Tasks 3 and 4.
- `apps/emulator/src/random.ts:10` — `Random.float()` returns a number in `[0, 1)`; `range(min, max)` is `min + float() * (max - min)`, so `backoffDelay({ random: () => random.float() })` draws the same number as the old `random.range(0, ceiling)` for the same seed. Task 2.

## File Changes

| Action | Path                                                               | Purpose                                                                                                             |
| ------ | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| Create | `packages/shared/src/backoff.ts`                                   | `backoffDelay({ attempt, baseMs, maxMs, random })` — moved from the emulator, new argument object (decision 20)     |
| Create | `packages/shared/src/backoff.test.ts`                              | The emulator's five cases with explicit constants and a fixed `random`                                              |
| Create | `packages/shared/src/lifecycle.ts`                                 | `createLifecycleHandlers`, `SIGINT_EXIT_CODE`, `FAILURE_EXIT_CODE` — moved from `apps/emulator/src/main.ts`         |
| Create | `packages/shared/src/lifecycle.test.ts`                            | The emulator's five lifecycle cases, success line `stopped`                                                         |
| Modify | `packages/shared/src/config.ts`                                    | `healthEnv` (`HEALTH_PORT`); `RABBITMQ_URL` shape check (decisions 17 and 18)                                       |
| Modify | `packages/shared/src/config.test.ts`                               | Four new `RABBITMQ_URL` cases, two `HEALTH_PORT` cases                                                              |
| Modify | `packages/shared/src/index.ts`                                     | Export `backoff.js` and `lifecycle.js`                                                                              |
| Delete | `apps/emulator/src/backoff.ts`, `backoff.test.ts`                  | Moved to shared                                                                                                     |
| Delete | `apps/emulator/src/main.test.ts`                                   | Moved to shared as `lifecycle.test.ts`                                                                              |
| Modify | `apps/emulator/src/connection.ts`                                  | Imports `backoffDelay` from shared; owns `BACKOFF_BASE_MS` and `BACKOFF_MAX_MS`                                     |
| Modify | `apps/emulator/src/main.ts`                                        | Imports the lifecycle factory from shared; keeps `SERVICE_NAME` and `main()`                                        |
| Modify | `pnpm-workspace.yaml`                                              | Catalog entry `amqplib: 2.0.1`                                                                                      |
| Modify | `apps/ingest/package.json`                                         | `amqplib`, `zod` (catalog), `vitest` dev dependency                                                                 |
| Modify | `.env.example`                                                     | `HEALTH_PORT` in a new `# --- ingest and processing ---` block                                                      |
| Create | `apps/ingest/src/config.ts`, `config.test.ts`                      | Ingest environment schema (decision 23)                                                                             |
| Create | `apps/ingest/src/fixtures.ts`                                      | Test support: four valid example messages, one per event type (shared's `fixtures.ts` is deliberately not exported) |
| Create | `apps/ingest/src/amqp-message.ts`, `amqp-message.test.ts`          | `toPublishArgs` (decisions 6 and 7)                                                                                 |
| Create | `apps/ingest/src/flow.ts`, `flow.test.ts`                          | `Window`, `shouldRead` (decisions 2 and 3)                                                                          |
| Create | `apps/ingest/src/ledger.ts`, `ledger.test.ts`                      | `Ledger`, `StallClock` (decisions 11 and 15)                                                                        |
| Create | `apps/ingest/src/publisher-state.ts`, `publisher-state.test.ts`    | `transition`, `isReady`, the state, event and effect types (decisions 12–14)                                        |
| Create | `apps/ingest/src/health.ts`, `health.test.ts`                      | `readinessReport`, `startHealthServer` (decision 17)                                                                |
| Create | `apps/ingest/src/publisher.ts`                                     | `AmqpPublisher`, the amqplib shell (decisions 8–16, 24)                                                             |
| Create | `apps/ingest/src/connection.ts`                                    | `DeviceConnection` (decisions 4, 5, 21)                                                                             |
| Create | `apps/ingest/src/server.ts`, `server.test.ts`                      | `IngestServer` (decisions 1–3, 19)                                                                                  |
| Create | `apps/ingest/src/test-publisher.ts`, `test-device.ts`              | Test support: in-memory `PublishPort`; a real `net` client                                                          |
| Modify | `apps/ingest/src/main.ts`                                          | Entry point                                                                                                         |
| Create | `.local/research/2026-09-13-ingest-scripted-run.mjs`               | The scripted broker run (gitignored; evidence goes into this plan)                                                  |
| Modify | `TODO.md`, `docs/specs/2026-09-11-telemetry-consistency-design.md` | Tick step 4; append T26–T37                                                                                         |

## Tasks

### Task 1: Commit the design spec and its amendments [mechanical]

**Files:** `docs/specs/2026-09-13-ingest-design.md` (untracked), `docs/specs/2026-09-11-telemetry-consistency-design.md`, `docs/specs/2026-09-11-shared-contract-design.md`, `docs/specs/2026-09-12-emulator-design.md`, `TODO.md` (all modified, unstaged)
**Invariant:** none touched.
**Verify:** `pnpm format:check && git status --short` (clean after the commit)

- [ ] Read the spec's section "Amendments to earlier specs" and confirm each listed edit is present in its target file (`grep` for the new wording: `ingest spec, 2026-09-13, decision 12`, `INGEST_MAX_UNCONFIRMED_TOTAL` in the crash row, `opt-in recovery (since 1.1.0)` in both T13 rows, `HEALTH_PORT` in the shared-contract table, `backoffDelay({ attempt, baseMs, maxMs, random })` in the emulator module table, the new step 7 item in `TODO.md`). Nothing is reapplied; a missing edit is applied by hand and named in the commit body.
- [ ] `pnpm format:check` passes.
- [ ] Commit all five files: `Add the socket ingest design spec`

### Task 2: Move the backoff and lifecycle helpers to shared [mechanical]

**Files:** Create `packages/shared/src/backoff.ts`, `backoff.test.ts`, `lifecycle.ts`, `lifecycle.test.ts`; modify `packages/shared/src/index.ts`, `apps/emulator/src/connection.ts`, `apps/emulator/src/main.ts`; delete `apps/emulator/src/backoff.ts`, `backoff.test.ts`, `main.test.ts`
**Invariant:** none touched; the emulator's seeded runs must replay unchanged (`random.test.ts`, `generator.test.ts`, `device.test.ts` stay green).
**Verify:** `pnpm --filter @telemetry/shared test && pnpm --filter @telemetry/shared typecheck && pnpm --filter @telemetry/shared lint && pnpm --filter @telemetry/emulator test && pnpm --filter @telemetry/emulator typecheck && pnpm --filter @telemetry/emulator lint`

```ts
// packages/shared/src/backoff.ts
export type BackoffInput = {
  /** 0-based. */
  attempt: number;
  baseMs: number;
  maxMs: number;
  /** Returns a number in [0, 1). */
  random: () => number;
};
/** Full Jitter: `random() * Math.min(maxMs, baseMs * 2 ** attempt)`. */
export function backoffDelay(input: BackoffInput): number;
```

```ts
// packages/shared/src/lifecycle.ts
export const SIGINT_EXIT_CODE = 130;
export const FAILURE_EXIT_CODE = 1;
export type LifecycleHandlers = {
  onSignal: (signal: NodeJS.Signals) => void;
  onUnhandledRejection: (reason: unknown) => void;
  onUncaughtException: (error: Error) => void;
};
export type LifecycleOptions = {
  logger: Logger;
  shutdown: () => Promise<void>;
  exit: (code: number) => void;
};
export function createLifecycleHandlers(options: LifecycleOptions): LifecycleHandlers;
```

Rules: `backoff.ts` keeps the emulator's comment on why the exponent needs no clamp. `lifecycle.ts` is the emulator's factory unchanged except the success line, which becomes `'stopped'` (every line already carries `service`). `packages/shared` has no dependency on the emulator's `Random`, hence the plain `random` function. `index.ts` adds `export * from './backoff.js'` and `export * from './lifecycle.js'`.

Emulator changes: `connection.ts` declares `export const BACKOFF_BASE_MS = 500;` and `export const BACKOFF_MAX_MS = 10_000;` (with the emulator's original comment about Full Jitter and the AWS IoT SDK) and calls `backoffDelay({ attempt, baseMs: BACKOFF_BASE_MS, maxMs: BACKOFF_MAX_MS, random: () => this.#random.float() })`. `main.ts` imports `createLifecycleHandlers` from `@telemetry/shared`, keeps `SERVICE_NAME` and `main()`, and no longer exports the exit codes. Run `grep -rn "SIGINT_EXIT_CODE\|FAILURE_EXIT_CODE\|from './backoff.js'\|from './main.js'" apps/emulator/src` and fix every hit.

- [ ] Move `backoff.test.ts` to shared: the same five cases (never exceeds the cap at any attempt up to 50; zero at the bottom of the window; doubles its ceiling per attempt until the cap; holds at the cap past the overflow to `Infinity`; depends only on the injected random), each passing `baseMs: 500, maxMs: 10_000` explicitly and `random: () => 0.999_999_999` or `() => 0`.
- [ ] Move `main.test.ts` to `lifecycle.test.ts`: the same five cases; the first expects the line `stopped` instead of `emulator stopped`.
- [ ] Verify both moved test files fail (modules missing).
- [ ] Implement `backoff.ts`, `lifecycle.ts`, the exports, the emulator changes; delete the three emulator files.
- [ ] Verify tests pass in both packages; the total test count is unchanged (311).
- [ ] Commit: `Move the reconnect backoff and the lifecycle handlers to the shared package`

### Task 3: Shared configuration — the health port and the RabbitMQ URL shape [mechanical]

**Files:** Modify `packages/shared/src/config.ts`, `packages/shared/src/config.test.ts`, `.env.example`
**Invariant:** none touched.
**Verify:** `pnpm --filter @telemetry/shared test && pnpm --filter @telemetry/shared typecheck && pnpm --filter @telemetry/shared lint && pnpm format:check`

```ts
export const healthEnv = {
  HEALTH_PORT: z.coerce.number().int().min(1).max(65_535).default(8080),
};
export const rabbitmqEnv = {
  RABBITMQ_URL: z.string().min(1).refine(isAmqpUrl, 'must be an amqp:// or amqps:// URL'),
  AMQP_HEARTBEAT_S: envInt(1, 10),
};
```

`isAmqpUrl(value: string): boolean` (module-private) calls `new URL(value)` inside `try`/`catch` and returns `url.protocol === 'amqp:' || url.protocol === 'amqps:'`; a parse failure returns `false`. The refine message is fixed text, so the `ConfigError` never carries the value (decision 18). `HEALTH_PORT` is written out because `envInt` cannot take `.max()`.

`.env.example`: a new block after the `# --- RabbitMQ: ingest and processing ---` block:

```
# --- ingest and processing ---
# Port of the HTTP readiness endpoint GET /readyz used by the Compose healthcheck (default 8080)
HEALTH_PORT=
```

- [ ] Write failing tests in `config.test.ts`: (1) `RABBITMQ_URL=http://x` is rejected with a `ConfigError` whose `problems` entry names `RABBITMQ_URL` and does not contain `http://x`; (2) `RABBITMQ_URL=not a url` is rejected the same way, without the value; (3) `amqps://user:pw@host:5671/vhost` is accepted unchanged (the loader returns the trimmed string, it never rewrites it); (4) `amqp://rabbitmq:5672` is accepted; (5) `HEALTH_PORT` defaults to 8080; (6) `HEALTH_PORT=65536` and `HEALTH_PORT=0` are rejected naming `HEALTH_PORT`.
- [ ] Verify tests fail
- [ ] Implement
- [ ] Verify tests pass
- [ ] Commit: `Validate the RabbitMQ URL shape and add the shared health port`

### Task 4: Ingest dependencies and configuration [mechanical]

**Files:** Modify `pnpm-workspace.yaml`, `apps/ingest/package.json`; create `apps/ingest/src/config.ts`, `apps/ingest/src/config.test.ts`
**Invariant:** none touched.
**Verify:** `pnpm install && pnpm --filter @telemetry/ingest test && pnpm --filter @telemetry/ingest typecheck && pnpm --filter @telemetry/ingest lint`

`pnpm-workspace.yaml` catalog gains `amqplib: 2.0.1` (alphabetical: before `eslint`). `apps/ingest/package.json` `dependencies` gains `"amqplib": "catalog:"` and `"zod": "catalog:"`; `devDependencies: { "vitest": "catalog:" }`. Run `pnpm install`; the lockfile changes only by the ingest entries and the amqplib package (no dependencies of its own).

```ts
// apps/ingest/src/config.ts
export const ingestEnvSchema = z
  .object({
    ...logLevelEnv,
    ...shutdownEnv,
    ...rabbitmqEnv,
    ...healthEnv,
    INGEST_HOST: z.string().min(1).default('0.0.0.0'),
    INGEST_PORT: z.coerce.number().int().min(1).max(65_535).default(4000),
    INGEST_MAX_UNCONFIRMED: envInt(1, 256),
    INGEST_MAX_UNCONFIRMED_TOTAL: envInt(1, 20_000),
    INGEST_SOCKET_IDLE_MS: envInt(1, 90_000),
  })
  .superRefine((value, ctx) => {
    if (value.INGEST_PORT === value.HEALTH_PORT) {
      ctx.addIssue({
        code: 'custom',
        path: ['INGEST_PORT'],
        message: 'must differ from HEALTH_PORT',
      });
    }
  });
export type IngestConfig = z.output<typeof ingestEnvSchema>;
export function loadIngestConfig(env: NodeJS.ProcessEnv = process.env): IngestConfig;
```

No type annotation on the schema (the emulator's reason: the alias would reference itself). The tests set `RABBITMQ_URL` to `amqp://localhost` in every case because it is required.

- [ ] Write failing tests: (1) defaults — every optional key has its documented default; (2) `INGEST_PORT=0` and `INGEST_PORT=65536` rejected naming `INGEST_PORT`; (3) `INGEST_PORT=8080` with the default `HEALTH_PORT` rejected, `problems` contains `INGEST_PORT` and `HEALTH_PORT`; (4) a missing `RABBITMQ_URL` rejected naming it; (5) values are trimmed (`INGEST_PORT=' 4001 '` gives 4001).
- [ ] Verify tests fail
- [ ] Implement
- [ ] Verify tests pass
- [ ] Commit: `Add the ingest configuration and its dependencies`

### Task 5: Publish arguments [mechanical]

**Files:** Create `apps/ingest/src/fixtures.ts`, `apps/ingest/src/amqp-message.ts`, `apps/ingest/src/amqp-message.test.ts`
**Invariant:** 1 and 2 pass through — `deviceId`, `sessionId` and `seq` reach the body unchanged and `messageId` is the identity string (proven by case 1).
**Verify:** `pnpm --filter @telemetry/ingest test && pnpm --filter @telemetry/ingest typecheck && pnpm --filter @telemetry/ingest lint`

```ts
import type { Options } from 'amqplib';
export type PublishArgs = {
  exchange: string;
  routingKey: string;
  content: Buffer;
  options: Options.Publish;
};
export function toPublishArgs(message: TelemetryMessage, receivedAt: number): PublishArgs;
```

`fixtures.ts` exports `exampleMessages: { [T in TelemetryEventType]: TelemetryMessageOf<T> }` — one valid message per event type, written as literals in ingest, because `packages/shared/src/fixtures.ts` is deliberately kept out of the shared barrel (shared-contract spec, module table) and each package builds its own fixtures. Not named `*.test.ts` (the unit project would report an empty suite). It is used by Tasks 5, 11 and 13.

Every field follows the spec's "Publish arguments" table: `TELEMETRY_EXCHANGE`, `TELEMETRY_ROUTING_KEY`, `Buffer.from(JSON.stringify(message), 'utf8')`, `persistent: true`, `mandatory: true`, `contentType: MESSAGE_CONTENT_TYPE`, `messageId: messageIdentity(message)`, `timestamp: Math.floor(receivedAt / 1000)`, `headers: { [RECEIVED_AT_HEADER]: receivedAt }`. Pure; two positional arguments (under the `max-params` limit).

- [ ] Write failing tests using `exampleMessages` from `./fixtures.js`: (1) for all four event types, every row of the table holds and `content` decodes back through `decodeTelemetryMessage` to a message deep-equal to the input; (2) `content` contains no `\n`; (3) `timestamp` is `Math.floor(receivedAt / 1000)` and `headers['x-received-at']` is the exact millisecond value, for `receivedAt = 1_757_800_000_123`; (4) `messageId` equals `messageIdentity(message)`.
- [ ] Verify tests fail
- [ ] Implement
- [ ] Verify tests pass
- [ ] Commit: `Map a validated message to its AMQP publish arguments`

### Task 6: Windows and the reading rule [mechanical]

**Files:** Create `apps/ingest/src/flow.ts`, `apps/ingest/src/flow.test.ts`
**Invariant:** 5 — a socket pauses only for a full window (case 3 proves the hysteresis that prevents pause churn per message).
**Verify:** `pnpm --filter @telemetry/ingest test && pnpm --filter @telemetry/ingest typecheck && pnpm --filter @telemetry/ingest lint`

```ts
export class Window {
  /** Closes when size reaches cap; reopens when size falls to Math.floor(cap / 2). */
  constructor(cap: number);
  add(): 'closed' | 'unchanged';
  remove(): 'reopened' | 'unchanged';
  readonly isOpen: boolean;
  readonly size: number;
}
export type ReadInput = {
  publisherReady: boolean;
  connectionWindowOpen: boolean;
  instanceWindowOpen: boolean;
};
export function shouldRead(input: ReadInput): boolean;
```

`remove()` below zero is a programmer error: it throws a plain `Error('window underflow')` (no `assert` dependency); the server never calls it more than `add()`.

- [ ] Write failing tests: (1) with cap 1, `add()` returns `closed` at size 1 and `remove()` returns `reopened` at size 0; (2) with cap 2, closes at 2, reopens at 1; (3) with cap 256, closes exactly at the 256th `add`, stays closed through removes down to 129, reopens at the remove that reaches 128, and `add` while closed returns `unchanged`; (4) `add`/`remove` report `unchanged` for every step that does not cross a boundary; (5) `shouldRead` is `true` only for all-true input (all eight combinations tested); (6) `remove()` on an empty window throws.
- [ ] Verify tests fail
- [ ] Implement
- [ ] Verify tests pass
- [ ] Commit: `Add the ingest confirm windows and the reading rule`

### Task 7: The ledger and the stall clock [mechanical]

**Files:** Create `apps/ingest/src/ledger.ts`, `apps/ingest/src/ledger.test.ts`
**Invariant:** 2 by design — a message leaves the ledger only through `confirm`, and `lose()` makes every `sent` entry `pending` again (cases 2, 3), so nothing is dropped and duplicates are the only cost.
**Verify:** `pnpm --filter @telemetry/ingest test && pnpm --filter @telemetry/ingest typecheck && pnpm --filter @telemetry/ingest lint`

```ts
export type LedgerEntry = {
  readonly id: number;
  readonly args: PublishArgs;
  readonly onConfirmed: () => void;
  state: { name: 'pending' } | { name: 'sent'; generation: number };
  /** Set by markSent and never cleared: a pending entry with wasSent true is a re-publish (the summary counter). */
  wasSent: boolean;
};
export class Ledger {
  add(input: { args: PublishArgs; onConfirmed: () => void }): LedgerEntry;
  /** Pending entries in insertion order. */
  pending(): LedgerEntry[];
  markSent(entry: LedgerEntry, generation: number): void;
  /** Removes the entry and calls its onConfirmed; a second call for the same entry does nothing. */
  confirm(entry: LedgerEntry): void;
  /** Every sent entry becomes pending. */
  lose(): void;
  readonly size: number;
  readonly sentCount: number;
}
export class StallClock {
  /** Called after an entry was marked sent. Starts the wait when sentCount rises from zero. */
  onSent(now: number, sentCount: number): void;
  /** Called after an ack. Restarts the wait while entries remain sent, stops it otherwise. */
  onAck(now: number, sentCount: number): void;
  /** On entering ready and on unblocked. */
  restart(now: number): void;
  isStalled(now: number, timeoutMs: number): boolean;
}
```

The ledger is a `Map<number, LedgerEntry>` (insertion order) plus a counter; `sentCount` is maintained incrementally, not by scanning. `confirm` on an entry that is no longer in the map is a no-op (a stale callback from an old generation is filtered earlier, but the ledger stays safe on its own). `StallClock` keeps one `startedAt: number | null`; `isStalled` is `startedAt !== null && now - startedAt > timeoutMs`.

- [ ] Write failing tests: (1) `pending()` keeps insertion order across `markSent` of some entries and a `lose()`; (2) `confirm` calls `onConfirmed` exactly once, removes the entry, and a second `confirm` of the same entry calls nothing; (3) `lose()` turns `sent` into `pending` and leaves `pending` alone; (4) `size` and `sentCount` after every transition of a three-entry sequence; (5) the stall clock does not start on `onSent` when `sentCount` was already above zero before, starts when it rises from zero, restarts on `onAck` with entries left, stops on `onAck` with none, and `isStalled` is false at exactly `timeoutMs` and true one millisecond later; (6) `restart` sets a new start time even while nothing is sent, and `isStalled` past the timeout is then true: the clock itself ignores `sentCount`; the caller (Task 10) checks `sentCount > 0` before it acts, and this case documents that split; (7) `wasSent` is false on `add`, true after `markSent`, and stays true after `lose()`.
- [ ] Verify tests fail
- [ ] Implement
- [ ] Verify tests pass
- [ ] Commit: `Add the ingest unconfirmed ledger and its stall clock`

### Task 8: The publisher state machine [mechanical]

**Files:** Create `apps/ingest/src/publisher-state.ts`, `apps/ingest/src/publisher-state.test.ts`
**Invariant:** 2 and 6 — every generation increase emits `lose` (case 4), so a `sent` entry can never be stranded; nothing in the state is keyed by device.
**Verify:** `pnpm --filter @telemetry/ingest test && pnpm --filter @telemetry/ingest typecheck && pnpm --filter @telemetry/ingest lint`

The types are the spec's, verbatim (`PublisherState`, `PublisherEvent`, `Effect` in "The publisher"), plus:

```ts
export const BACKOFF_RESET_AFTER_MS = 10_000;
export const INITIAL_STATE: PublisherState = {
  name: 'backoff',
  generation: 0,
  attempt: 0,
  reason: 'start',
};
export type Transition = { state: PublisherState; effects: Effect[] };
export function transition(state: PublisherState, event: PublisherEvent): Transition;
/** True only in `ready` with `blocked` false. */
export function isReady(state: PublisherState): boolean;
```

Rules: the spec's transition table, row by row, with `switch` on `state.name` and `assertNever` defaults (the `switch-exhaustiveness-check` lint rule). A generation-carrying event whose generation is not `state.generation` returns `{ state, effects: [] }`. A current-generation pair with no row returns the same. `log` effects carry `level`, `message` and `fields` (the reason, the attempt). The `stop` event from `backoff` emits no `close_model`.

- [ ] Write failing tests, each as a sequence of events with the expected state and the exact effect list in order: (1) every row of the table (one `it` per row, 14 rows); (2) stale generation: for every state, an event carrying `generation - 1` changes nothing; (3) the no-row rule: a loop over every state × every event type (with the current generation) asserts that pairs not in the table return the same state and no effects — the table rows are listed once in the test as `(stateName, eventType)` pairs and the loop skips them; (4) `lose` appears in the effects of `backoff_elapsed` and of `trigger` from `ready`, and nowhere else; (5) trigger during `connecting`: `trigger` then `attempt_succeeded` ends in `backoff` with `close_model` and `start_backoff`, never `ready`; (6) `blocked` during `connecting` then `attempt_succeeded` gives `ready` with `blocked` true and `isReady` false; `blocked` then `unblocked` during `connecting` gives a ready `ready`; the next `backoff_elapsed` starts `blocked` false; (7) the backoff reset: `trigger` from `ready` with `now - readySince` equal to 10 000 gives `attempt` 0, with 9 999 gives `attempt + 1`; (8) `stop` from every state ends in `stopped` and every later event returns `stopped` unchanged; (9) `isReady` for every state variant; (10) `close_finished` from `recycling` emits `start_backoff` with the recycle's reason and attempt.
- [ ] Verify tests fail
- [ ] Implement
- [ ] Verify tests pass
- [ ] Commit: `Add the ingest publisher state machine`

### Task 9: Readiness endpoint [integration]

**Files:** Create `apps/ingest/src/health.ts`, `apps/ingest/src/health.test.ts`
**Invariant:** none touched.
**Verify:** `pnpm --filter @telemetry/ingest test && pnpm --filter @telemetry/ingest typecheck && pnpm --filter @telemetry/ingest lint`

```ts
export type ReadinessReport =
  { ready: true } | { ready: false; reason: 'connecting' | 'blocked' | 'shutting_down' };
export function readinessReport(input: {
  publisherState: PublisherState;
  shuttingDown: boolean;
}): ReadinessReport;
export type HealthServer = { port: number; close(): Promise<void> };
export function startHealthServer(options: {
  port: number;
  report: () => ReadinessReport;
  logger: Logger;
}): Promise<HealthServer>;
```

Rules: `readinessReport` — `shutting_down` first, then `blocked` for `ready` with `blocked` true, then `connecting` for every other state, `ready: true` only for `ready` unblocked. The server is `node:http` on all interfaces; `GET /readyz` answers `200 {"status":"ready"}` or `503 {"status":"not_ready","reason":"<reason>"}` with `content-type: application/json`; anything else is `404` with an empty JSON body `{}`. `close()` calls `server.close()` and then `server.closeAllConnections()` and resolves when the close callback fires. A listen error rejects the returned promise (`main.ts` logs it at `fatal`). No request logging.

- [ ] Write failing tests: (1) `readinessReport` for every state variant × `shuttingDown`; (2) a real `fetch` to a server started on port 0 gets 200 and the JSON body when the report is ready, 503 with `reason` when not; (3) `GET /other` and `POST /readyz` get 404; (4) `close()` resolves within the test timeout while a client holds a keep-alive connection open (open a `net` connection to the port, send nothing, then `close()`).
- [ ] Verify tests fail
- [ ] Implement
- [ ] Verify tests pass
- [ ] Commit: `Add the ingest readiness endpoint`

### Task 10: The amqplib publisher shell [integration]

**Files:** Create `apps/ingest/src/publisher.ts`
**Invariant:** 2 — every path out of `ready` republishes the ledger (via `lose` + `send_pending`); 6 — one connection per instance, nothing per device. Proven by Task 13's scripted run (broker restart, queue deleted, resource alarm) and by Task 8's tests of the machine it obeys; no mock of amqplib (`CLAUDE.md`).
**Verify:** `pnpm --filter @telemetry/ingest typecheck && pnpm --filter @telemetry/ingest lint && pnpm --filter @telemetry/ingest test`

```ts
export type PublishRequest = {
  message: TelemetryMessage;
  receivedAt: number;
  onConfirmed: () => void;
};
export type PublishPort = {
  publish(request: PublishRequest): void;
  readonly isReady: boolean;
  onReadyChange(listener: (ready: boolean) => void): () => void;
  readonly unconfirmed: number;
  /** Resolves within AMQP_CLOSE_TIMEOUT_MS whatever the state. */
  stop(): Promise<void>;
};
export type PublisherStats = {
  confirmed: number;
  unconfirmed: number;
  republished: number;
  returned: number;
};
export type AmqpPublisherOptions = {
  url: string;
  heartbeatSeconds: number;
  logger: Logger;
  /** For `connection_name`; defaults to os.hostname(). */
  hostname?: string;
};
export const AMQP_CONNECT_TIMEOUT_MS = 10_000;
export const AMQP_SETUP_TIMEOUT_MS = 10_000;
export const AMQP_CLOSE_TIMEOUT_MS = 2_000;
export const AMQP_RECONNECT_BASE_MS = 500;
export const AMQP_RECONNECT_MAX_MS = 10_000; // equals BACKOFF_RESET_AFTER_MS on purpose (decision 13)
export class AmqpPublisher implements PublishPort {
  constructor(options: AmqpPublisherOptions);
  /** Dispatches backoff_elapsed; never throws; every failure goes to backoff. */
  start(): void;
  publish(request: PublishRequest): void;
  get isReady(): boolean;
  onReadyChange(listener: (ready: boolean) => void): () => void;
  get unconfirmed(): number;
  get state(): PublisherState;
  stats(): PublisherStats;
  stop(): Promise<void>;
}
```

The shell is the spec's section "The publisher", bullet by bullet. Fixed points the implementer must not vary:

- `#dispatch(event)` runs `transition`, stores the state, notifies `onReadyChange` listeners when `isReady` changed, then runs the effects in order. It never calls into amqplib synchronously: `close_model` starts on `setImmediate`, `start_attempt` starts on `queueMicrotask`.
- The connect sequence (decision 10): the URL is `new URL(url)` with `searchParams.set('heartbeat', String(heartbeatSeconds))`; `connect(href, { timeout: AMQP_CONNECT_TIMEOUT_MS, clientProperties: { connection_name } })` where `connection_name` is the string `ingest@` followed by the hostname; then, under one `AMQP_SETUP_TIMEOUT_MS` budget implemented with `Promise.race` against a timer that is cleared afterwards: `createConfirmChannel()`, listeners, `assertExchange(TELEMETRY_EXCHANGE, TELEMETRY_EXCHANGE_TYPE, TELEMETRY_EXCHANGE_OPTIONS)`, `assertExchange(DEAD_LETTER_EXCHANGE, DEAD_LETTER_EXCHANGE_TYPE, DEAD_LETTER_EXCHANGE_OPTIONS)`, `assertQueue(TELEMETRY_QUEUE, TELEMETRY_QUEUE_OPTIONS)`, `assertQueue(DEAD_LETTER_QUEUE, DEAD_LETTER_QUEUE_OPTIONS)`, `bindQueue(TELEMETRY_QUEUE, TELEMETRY_EXCHANGE, TELEMETRY_ROUTING_KEY)`, `bindQueue(DEAD_LETTER_QUEUE, DEAD_LETTER_EXCHANGE, '')`. After every `await` the sequence checks `#state` is still `connecting` with its generation and `failed` false; if `stopped`, it closes what it opened and returns; if failed or another state, it closes what it opened and dispatches `attempt_failed`. Every throw is caught (`err` logged in the `start_backoff` line), never propagated: `start()` and the sequence are `void`-safe.
- Listeners (attached with the generation captured in a closure; each checks `generation === this.#state.generation` before acting): model `close` → `trigger` reason `connection_closed`; model `error` → log `error`; channel `close` → `trigger` reason `channel_closed`; channel `error` → log `error`; channel `return` → log `error` with `messageLogger` fields parsed from `message.properties.messageId` (a string `deviceId:sessionId:seq` split on `:`; when it does not split into three parts, log with `messageId` raw) then `trigger` reason `returned` and `returned += 1`; `handler-error` on both → log `error`, `trigger` reason `handler_error`; `blocked` → `blocked` event; `unblocked` → `unblocked` event.
- `#send(entry)`: `const generation = this.#state.generation; try { channel.publish(args.exchange, args.routingKey, args.content, args.options, (err: unknown) => this.#onPublishCallback(entry, generation, err)); } catch (error) { this.#dispatch(trigger 'publish_threw'); return; } if (this.#state.generation === generation) { ledger.markSent(entry, generation); stallClock.onSent(now, ledger.sentCount); }`. The callback: ignored unless `generation === this.#state.generation`; `err === null || err === undefined` → `ledger.confirm(entry)`, `confirmed += 1`, `stallClock.onAck`; otherwise `trigger` reason `nacked` (the error message is logged at `debug`). `republished` counts the entries `send_pending` sends whose `wasSent` is already true (Task 7's field).
- `send_pending` iterates `ledger.pending()` and stops as soon as the state is no longer `ready` with the same generation (a throw in the loop dispatched a trigger).
- `close_model`: as the spec says — four paths, one `close_finished` dispatch, model reference dropped on every path; `AMQP_CLOSE_TIMEOUT_MS` via `Promise.race`; a `modelClosed` flag set by the model's `close` listener decides the skip path.
- `start_backoff`: `backoffDelay({ attempt, baseMs: AMQP_RECONNECT_BASE_MS, maxMs: AMQP_RECONNECT_MAX_MS, random: Math.random })`, the `warn` line, then a `setTimeout` that dispatches `backoff_elapsed` with the current generation.
- `stop()`: dispatches `stop`; returns `Promise.race([closeDone, timer(AMQP_CLOSE_TIMEOUT_MS)])` where `closeDone` resolves when the pending `close_model` completes (or at once when the state was `backoff` or `stopped`); all timers are cleared; the stall interval is cleared.
- The stall check: `setInterval(check, Math.floor(confirmTimeoutMs / 3)).unref()` where `confirmTimeoutMs = 3 * heartbeatSeconds * 1000`; `check` dispatches `trigger` reason `confirm_stall` only when the state is `ready`, not blocked, and `stallClock.isStalled(Date.now(), confirmTimeoutMs)` with `ledger.sentCount > 0`.
- Logs: `info` `publisher connected` (generation, attempt); `warn` from `start_backoff` (`reason`, `attempt`, `delayMs`, `err` when the reason came from an error); `warn` `connection blocked` (reason); `info` `connection unblocked`; `debug` per published and per confirmed message through `messageLogger` created only when `logger.isLevelEnabled('debug')`; every `error` event at `error` with `err`.

No unit test file: the state machine is Task 8's; the shell is exercised by Task 13. The scoped verify runs typecheck, lint and the existing tests.

- [ ] Implement `publisher.ts`
- [ ] Verify typecheck and lint pass (the `no-unsafe-*` rules against amqplib's `any`-typed callback error and `headers`)
- [ ] Commit: `Add the amqplib publisher shell`

### Task 11: The socket server and its flow control [integration]

**Files:** Create `apps/ingest/src/connection.ts`, `apps/ingest/src/server.ts`, `apps/ingest/src/test-publisher.ts`, `apps/ingest/src/test-device.ts`, `apps/ingest/src/server.test.ts`
**Invariant:** 4 — connections are independent, nothing is serialised per device (case 9: the instance window pauses every socket, a connection window pauses one); 5 — a socket pauses only for a full window or a not-ready publisher (cases 6–9); 6 — nothing survives a connection except its ledger entries (case 11).
**Verify:** `pnpm --filter @telemetry/ingest test && pnpm --filter @telemetry/ingest typecheck && pnpm --filter @telemetry/ingest lint`

```ts
// test-publisher.ts — the in-memory PublishPort (spec decision 24)
export type TestPublisher = {
  port: PublishPort;
  requests: PublishRequest[];
  setReady(ready: boolean): void;
  /** Calls onConfirmed of the request at `index` once. */
  confirm(index: number): void;
  confirmAll(): void;
  /** Resolves once requests.length >= count; the vitest timeout bounds it. */
  waitForRequests(count: number): Promise<PublishRequest[]>;
};
export function createTestPublisher(options?: { ready?: boolean }): TestPublisher;

// test-device.ts — a real net client
export type TestDevice = {
  socket: net.Socket;
  write(frame: string | Buffer): boolean;
  writeMessage(message: TelemetryMessage): boolean;
  /** Resolves when the server's FIN has been received ('end'). */
  ended: Promise<void>;
  closed: Promise<void>;
  end(): void;
  destroy(): void;
};
export function connectTestDevice(options: {
  port: number;
  allowHalfOpen?: boolean;
}): Promise<TestDevice>;
```

```ts
// connection.ts
export type CloseReason = 'end' | 'error' | 'idle' | 'frame_too_long' | 'shutdown';
export type DeviceConnectionOptions = {
  connectionId: number;
  socket: net.Socket;
  publisher: PublishPort;
  window: Window; // this connection's window, cap INGEST_MAX_UNCONFIRMED
  instanceWindow: Window;
  idleMs: number;
  logger: Logger;
  /** Called after a chunk when this connection's window closed, and by onConfirmed when it reopened. */
  onWindowChange: (connection: DeviceConnection) => void;
  /** Called by onConfirmed when the instance window reopened, and after a chunk when it closed. */
  onInstanceWindowChange: () => void;
  /** Called on EVERY confirm of this connection's messages, after the window callbacks, whether or not a window reopened; the server re-checks the shutdown drain here. */
  onMessageConfirmed: () => void;
  onClose: (connection: DeviceConnection, reason: CloseReason) => void;
};
export class DeviceConnection {
  constructor(options: DeviceConnectionOptions);
  readonly connectionId: number;
  readonly remote: string;
  readonly socket: net.Socket;
  readonly window: Window;
  get isReading(): boolean;
  get lastDeviceId(): string | undefined;
  get received(): number;
  get rejected(): number;
  /** Applies the reading rule with the given publisher readiness; idempotent. */
  applyReadingRule(input: { publisherReady: boolean; instanceWindowOpen: boolean }): void;
  halfClose(): void;
  destroy(reason: CloseReason): void;
}
```

```ts
// server.ts
export type IngestServerOptions = { config: IngestConfig; publisher: PublishPort; logger: Logger };
/** `received` and `rejected` are running instance-lifetime totals kept by the server (a connection's own counters die with it, decision 21). */
export type ServerStats = { open: number; reading: number; received: number; rejected: number };
export type DrainResult = { openConnections: number; unconfirmed: number };
export class IngestServer {
  constructor(options: IngestServerOptions);
  listen(): Promise<{ port: number }>;
  /** Live connections, for tests and the summary line. */
  connections(): readonly DeviceConnection[];
  stats(): ServerStats;
  /** Decision 19 steps 1–4: stop accepting, half-close, wait, destroy the rest. Idempotent. */
  shutdown(): Promise<DrainResult>;
}
```

Rules, all from the spec: `net.createServer({ pauseOnConnect: true, keepAlive: true, keepAliveInitialDelay: 30_000 })`. A new connection is registered, logged at `info` (`connectionId`, `remote`), and the rule is applied once. Turning reading on is `socket.resume()` then `socket.setTimeout(idleMs)`; off is `socket.pause()` then `socket.setTimeout(0)`; the `isReading` flag makes it idempotent. The `data` handler is the spec's "One frame, from socket to ledger" list: `decoder.push`, `decodeTelemetryMessage`, rejected → `rejectedMessageLogger(logger, result.identity).warn({ connectionId, reason, detail }, 'frame rejected')`, valid → both windows `add()`, `publisher.publish({ message, receivedAt: Date.now(), onConfirmed })`; `ok: false` → `warn` with `connectionId`, `remote`, `bytes`, `limit`, then `destroy('frame_too_long')`. The `onConfirmed` closure handed to `publisher.publish` calls `instanceWindow.remove()` always and `window.remove()` only while the connection is still open (`#open` flag cleared on close), calls the two change callbacks when a window reopened, and then always calls `options.onMessageConfirmed` — the unconditional hook the drain needs, since a confirm below a window boundary crosses no edge. The server applies the rule per the spec's table (that socket / every socket) and subscribes to `publisher.onReadyChange`. `'timeout'` → `destroy('idle')`; `'error'` → `warn` and reason `error`; `'end'` with reading on ends the socket (`allowHalfOpen` is false, Node does it); `'close'` → `onClose` → the server removes it, logs `info` (`connectionId`, `remote`, `lastDeviceId`, `received`, `rejected`, `pendingBytes`, `reason`), and re-checks the drain. `shutdown()`: `server.close()`, `halfClose()` on every connection, resolve when `connections().length === 0 && publisher.unconfirmed === 0` — checked immediately, on every close and in every connection's unconditional `onMessageConfirmed` hook — or after `SHUTDOWN_TIMEOUT_MS`; then `warn` with `openConnections` and `unconfirmed` and `destroy('shutdown')` on the rest; the timer is cleared on the early path. The unconfirmed check reads `publisher.unconfirmed` through the port.

- [ ] Write failing tests in `server.test.ts`, each with its own server on `INGEST_PORT: 0` (`listen()` returns the port) and its own `createTestPublisher`, using `exampleMessages` from `./fixtures.js` and `encodeFrame` from `@telemetry/shared`: (1) two valid frames reach the publisher in order with a numeric `receivedAt`; (2) an invalid JSON line and a schema violation are logged at `warn` with `reason` `invalid_json` / `invalid_schema` and the connection stays open (a later valid frame arrives); (3) a 64 KiB + 1 line closes the connection with reason `frame_too_long` after the valid frame before it was published; (4) a frame split across two `write` calls is published once; (5) while the publisher is not ready the server-side socket has `readableFlowing === false` and `timeout === 0`, and after `setReady(true)` a frame is published; (6) with `INGEST_MAX_UNCONFIRMED: 2` the socket pauses after the second message (`isReading` false, third frame not published) and resumes after `confirm(0)` — cap 2 reopens at 1; (7) with `INGEST_MAX_UNCONFIRMED_TOTAL: 2` and two connections, the second message pauses both, and confirming one resumes both; (8) with `INGEST_SOCKET_IDLE_MS: 50` a silent reading socket is closed with reason `idle`, and a paused socket is not closed after 200 ms (a `setTimeout` bounded wait that asserts the connection is still open — the one timed wait in the file, justified because the absence of an event is the assertion); (9) `onConfirmed` after the device disconnected still frees the instance window (with total cap 1: device A sends one message and disconnects, device B's socket is paused, `confirm(0)` resumes B); (10) `shutdown()` half-closes every connection: a `TestDevice` that closes on `end` lets the drain finish before the budget with `openConnections` 0, and a device created with `allowHalfOpen: true` that never closes is destroyed at the budget (`SHUTDOWN_TIMEOUT_MS: 100`) with the `warn` line; (11) a `shutdown()` with no connections and an empty ledger resolves at once (measure `< 50 ms`) without the `warn` line; (11b) with `INGEST_MAX_UNCONFIRMED: 256`, one device sends 3 messages and closes; `shutdown()` with `SHUTDOWN_TIMEOUT_MS: 2000` resolves right after `confirmAll()` (measure `< 500 ms`), which proves the drain re-checks on a confirm that crosses no window boundary; (12) the close log line carries `lastDeviceId`, `received`, `rejected`, `pendingBytes` and `reason`.
- [ ] Verify tests fail
- [ ] Implement `test-publisher.ts`, `test-device.ts`, `connection.ts`, `server.ts`
- [ ] Verify tests pass
- [ ] Commit: `Add the ingest socket server and its flow control`

### Task 12: Entrypoint [integration]

**Files:** Modify `apps/ingest/src/main.ts`
**Invariant:** none touched.
**Verify:** `pnpm --filter @telemetry/ingest test && pnpm --filter @telemetry/ingest typecheck && pnpm --filter @telemetry/ingest lint && pnpm --filter @telemetry/ingest build`

`main.ts` keeps `export const SERVICE_NAME = 'ingest'` and adds `main()` in the spec's startup order: `loadIngestConfig()` (not wrapped); `createLogger`; `logger.info({ ...config }, 'ingest starting')` (the logger redacts `RABBITMQ_URL`); the lifecycle handlers from shared; `startHealthServer` first (a listen failure is logged at `fatal` and exits 1); `new AmqpPublisher(...)` and `start()`; `new IngestServer(...)` and `listen()` (same failure handling); the unref'd summary interval every 10 000 ms logging `server.stats()` and `publisher.stats()` at `info`. `shutdown()` sets `shuttingDown = true` (the report closure reads it), then `await server.shutdown()`, `await publisher.stop()`, `await health.close()`. The direct-run guard from the emulator's `main.ts` is kept so tests can import siblings.

- [ ] Implement `main.ts`
- [ ] Manually verify without a broker: `pnpm --filter @telemetry/ingest build && RABBITMQ_URL=amqp://127.0.0.1:1 node apps/ingest/dist/main.js` logs the config line (URL redacted), `warn` lines with growing delays, `curl -s localhost:8080/readyz` returns 503 with reason `connecting`, a `nc localhost 4000` connection is accepted and stays open, and `Ctrl+C` exits 0 within the budget.
- [ ] Commit: `Wire the ingest entrypoint and its readiness signal`

### Task 13: Scripted run against RabbitMQ 4.3 [integration]

**Files:** Create `.local/research/2026-09-13-ingest-scripted-run.mjs` (gitignored); modify this plan's header with the evidence
**Invariant:** 2 — every scenario ends with every sent message in the queue (duplicates allowed, none missing); the run counts distinct `messageId`s in the queue against the frames sent.
**Verify:** `docker info` (OrbStack up), then `node .local/research/2026-09-13-ingest-scripted-run.mjs` exits 0

The script, driven from Node like the emulator's manual run (`.local/research/2026-09-12-emulator-manual-run.mjs`), never from a shell wrapper (the harness artifact recorded in the emulator plan): it starts `docker run -d --rm --name ingest-probe-rabbit -p 5672:5672 -p 15672:15672 rabbitmq:4.3-management`, waits until `docker exec ingest-probe-rabbit rabbitmq-diagnostics -q check_running` exits 0, spawns `apps/ingest/dist/main.js` with `RABBITMQ_URL` set to the container's default credentials (kept in the script, never printed; the log redacts them), `AMQP_HEARTBEAT_S=2`, `LOG_LEVEL=debug`, `INGEST_PORT=4000`, `HEALTH_PORT=8080`, connects two `net` clients that write `exampleMessages`-shaped frames with increasing `seq`, and runs the spec's six scenarios in order, reading the queue through the management API (`GET /api/queues/%2F/telemetry.events` for `messages`, `POST .../get` with `{ count, ackmode: 'ack_requeue_true', encoding: 'auto' }` for the properties). Each scenario prints one line `PASS`/`FAIL` with the numbers:

1. **Normal publish** — 20 frames; the queue holds 20 messages; a peeked message has `properties.message_id` equal to the identity, `content_type` `application/json`, `delivery_mode` 2, `timestamp` in seconds and `headers['x-received-at']` a number in milliseconds.
2. **Broker restart while devices send** — the clients keep writing 10 frames/s; `docker restart ingest-probe-rabbit`; `/readyz` answers 503 during the restart; after reconnect, the ingest log shows one `warn` line with reason `connection_closed` and a delay, the `republished` counter is at least the number of unconfirmed at the restart, and the queue holds at least one message per distinct frame sent (duplicates allowed). The recycle took the "model already closed" path (the `debug` line says `skipped`).
3. **Queue deleted while running** — `DELETE /api/queues/%2F/telemetry.events`; the next frame produces an `error` line `message returned` with the identity, a `warn` recycle line with reason `returned`, and after the reconnect the queue exists again and holds the returned message.
4. **Resource alarm** — `docker exec ingest-probe-rabbit rabbitmqctl set_vm_memory_high_watermark 0.0000001`; a frame is written (the alarm blocks a connection only once it publishes); the log shows `warn` `connection blocked`, `/readyz` answers 503 with `blocked`, the server-side sockets stop reading (the client's `write()` eventually returns `false`); the alarm stays on for 8 s (`> 2 × AMQP_HEARTBEAT_S`); the script records whether a `warn` recycle line appeared during the alarm (spec decision 14: both outcomes are safe) and which; then `set_vm_memory_high_watermark 0.6`; `unblocked` is logged, the frames written during the alarm are in the queue.
5. **SIGTERM with devices connected** — `child.kill('SIGTERM')` with two clients connected; the clients receive `end` and close; the ingest log shows the drain finishing before the budget with `openConnections` 0, `unconfirmed` 0, and the exit code is 0 within `SHUTDOWN_TIMEOUT_MS + AMQP_CLOSE_TIMEOUT_MS`.
6. **Invalid frame** — after a restart of the ingest child: a line `{"type":"bogus"}` and a line `not json` produce two `warn` `frame rejected` lines, the queue message count does not change, and the connection stays open (a valid frame after them is queued).

The script stops the container at the end (`docker stop`), also on failure (`finally`).

- [ ] Write and run the script; fix whatever it finds in `publisher.ts` (each fix is its own commit with the scenario in the subject)
- [ ] Record the evidence in this plan's header: the date, the RabbitMQ version reported by `GET /api/overview` (`rabbitmq_version`), one line per scenario with the numbers, and the observed outcome of scenario 4's heartbeat question
- [ ] Commit: `Record the ingest publisher's scripted run against RabbitMQ`

### Task 14: Ledger and trade-offs [mechanical]

**Files:** Modify `TODO.md`, `docs/specs/2026-09-11-telemetry-consistency-design.md`
**Invariant:** none touched.
**Verify:** `pnpm format:check && pnpm lint && pnpm typecheck && pnpm test`

- [ ] Tick all eight boxes under `## 4. Socket ingest služba` and add a one-line note above them naming this plan and the commit range, in the style steps 2 and 3 use.
- [ ] Append rows T26–T37 from the design spec's "Trade-offs added to the running list" to the consistency spec's running trade-off table, preserving its column order and pointing the Decision column at "ingest spec, N".
- [ ] Full pre-flight green.
- [ ] Commit: `Mark the ingest step done and record its trade-offs`

## Verification Criteria

| #   | Criterion (TODO step 4 item, or invariant)                                                                                       | How to verify                                                                                                                                                         |
| --- | -------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Socket server accepts long-lived device connections and keeps them open across many frames                                       | `server.test.ts` cases 1, 2, 4; Task 12 manual `nc`                                                                                                                   |
| 2   | Every frame is validated with the shared schema; an invalid one is logged with its reason and dropped, the connection stays open | `server.test.ts` case 2; scripted scenario 6                                                                                                                          |
| 3   | A valid message reaches RabbitMQ with the routing and order metadata (`messageId`, `timestamp`, `x-received-at`, body unchanged) | `amqp-message.test.ts` cases 1–4; scripted scenario 1 reads the properties back from the queue                                                                        |
| 4   | Ingest holds no per-device state; a device can reconnect to any instance                                                         | `grep -rn "deviceId" apps/ingest/src/*.ts` shows it only in log fields and `lastDeviceId`; `server.test.ts` case 9 (entries outlive the connection, keyed by counter) |
| 5   | A broker outage pauses devices instead of disconnecting them, and publishing resumes with nothing lost (duplicates allowed)      | `server.test.ts` cases 5 and 8 (paused socket has no idle timer); `publisher-state.test.ts` cases 4, 5; scripted scenarios 2, 3, 4                                    |
| 6   | Every `sent` entry is republished after a recycle; none is stranded                                                              | `publisher-state.test.ts` case 4 (`lose` on every generation increase); `ledger.test.ts` case 3; scripted scenario 2 (`republished` counter, queue count)             |
| 7   | Graceful shutdown finishes in-flight messages and closes device sockets cleanly, within the budget                               | `server.test.ts` cases 10, 11; scripted scenario 5 (exit 0, FIN received by the clients, drain numbers)                                                               |
| 8   | Readiness for Docker Compose: 503 until the broker is ready, 200 after, 503 with a reason when blocked or shutting down          | `health.test.ts` cases 1–3; Task 12 manual `curl`; scripted scenarios 2 and 4                                                                                         |
| 9   | Unit tests cover validation and the message-to-queue mapping                                                                     | `server.test.ts` case 2; `amqp-message.test.ts`                                                                                                                       |
| 10  | Invariant 5: a socket pauses only for a full window or a not-ready publisher, and windows reopen at half                         | `flow.test.ts` cases 1–3; `server.test.ts` cases 6, 7                                                                                                                 |
| 11  | The publisher state machine has no undefined pair and no stranded state                                                          | `publisher-state.test.ts` cases 2, 3, 8, 10                                                                                                                           |
| 12  | `stop()` is bounded and the whole stop fits in `SHUTDOWN_TIMEOUT_MS + AMQP_CLOSE_TIMEOUT_MS`                                     | scripted scenario 5 measures the exit time                                                                                                                            |
| 13  | An invalid configuration fails at startup naming the variable, never its value; `RABBITMQ_URL` must be an AMQP URL               | `config.test.ts` (shared cases 1–6, ingest cases 2–4)                                                                                                                 |
| 14  | The emulator's seeded runs replay unchanged after the helper move                                                                | Task 2: every emulator test green, 311 tests total before the ingest tests are added                                                                                  |
| 15  | No `console.*`; every line about a message carries the identity                                                                  | `pnpm --filter @telemetry/ingest lint`; `grep -rn 'console\.' apps/ingest/src` returns nothing                                                                        |

## Test Plan

- Per task: the scoped verify command of the task (`@telemetry/shared`, `@telemetry/emulator` or `@telemetry/ingest`).
- **No Docker is needed for Tasks 1–12.** The socket tests use real `net` clients and servers inside the test process; the amqplib shell has no unit test (spec T36). These files live in `src/` and run in the `unit` project.
- **Task 13 needs OrbStack** (`docker info`) and pulls `rabbitmq:4.3-management`; it is a scripted run, not a vitest test — the automated version is the step 7 item added to `TODO.md`.
- Every socket test waits on an event (`waitForRequests`, `ended`, `closed`, a log line), never a sleep; the one bounded timed wait is `server.test.ts` case 8, where the absence of a close is the assertion.
- Full pre-flight before reporting done: `pnpm lint && pnpm typecheck && pnpm test && pnpm format:check`.
- Expected count after Task 14: about 90 new cases on top of the existing 311.

## Checkpoint Recovery

If interrupted mid-implementation, resume by:

1. Read this plan.
2. `git log --oneline` — each task ends with exactly one commit whose subject is quoted in the task (Task 13 may add fix commits before its own).
3. Pick up from the first task whose commit is missing. Tasks run in numeric order: Task 2's `backoffDelay` and lifecycle handlers are imported by Tasks 10 and 12; Task 3's `healthEnv` by Task 4; Task 4's `IngestConfig` by Task 11; Task 5's `PublishArgs` by Task 7; Task 7's `Ledger` and Task 8's `transition` by Task 10; Task 9's `readinessReport` by Task 12; Task 11 depends on Task 10's `PublishPort` type only. Task 13 needs Task 12's built entrypoint.
