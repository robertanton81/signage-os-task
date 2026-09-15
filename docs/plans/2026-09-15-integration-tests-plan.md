> **STATUS: SHIPPED 2026-09-15.** Landed as 19 commits, `d5d858d..602d365`: the plan commit with the spec amendments (`d5d858d`, Task 1), one commit per task for Tasks 2–10 (`599da14`, `e558497`, `e27a3c2`, `dc21643`, `f3da35b`, `c48b095`, `ceda214`, `11859bd`, `c6b1f27`), the seven review-fix commits (`94fd90f`, `7cf3ac9`, `b6d4b83`, `909595a`, `5cd6241`, `af73138`, `9c7b5ba`), the ledger and trade-off commit (`24c4937`, Task 11) and the CI workflow (`602d365`, Task 12). The unchecked `- [ ]` boxes below are historical — work is done. **Do not re-execute this plan.** If you are modifying the integration tests or their harness, work directly in `test/harness/*.ts`, `test/integration/*.test.ts`, `docker-compose.test.yml` and `vitest.config.ts`.
>
> **Process notes:** the plan file had been committed before the implementing session as `46ffb4d` under an unrelated subject ("Implement new feature for user authentication and improve error handling") and pushed. Task 1 amended that commit into `d5d858d` (the same file plus the five spec amendments, the subject the plan prescribes), so the local `main` diverged from `origin/main` by that one rewrite; the push needs `--force-with-lease`. Every file the plan gives in full was copied from its code block and proven byte-identical with `cmp` before its commit; the hand-applied edits (imports, appended blocks) were checked by the spec-compliance reviewer.
>
> **Plan-vs-reality corrections discovered during execution:**
>
> **Library/version drift:** none. amqplib 2.0.1, mongodb 7.6.0, ws 8.21.3, vitest 4.1.11, TypeScript 6.0.3, Docker Engine 29.4.0, Compose v5.1.2, `rabbitmq:4.3-management` (4.3.5) and `mongo:8.0` are as the spec measured; `pnpm install --offline` added the five root devDependencies with one `link:packages/shared` line and no new resolution.
>
> **Plan code prescriptions that needed adjustment:** (1) Task 3's `pnpm typecheck` fails on the plan's `test/harness/global-setup.ts` alone: TypeScript adds an augmented module (`declare module 'vitest'`) to the program only when some file imports it, and nothing under `test/` imported `vitest` before Task 4; a type-only `import type {} from 'vitest';` with a comment keeps the augmentation valid on its own (the plan's probe had every file assembled at once). (2) Task 9's block declares `AMQP_CLOSE_TIMEOUT_MS`, `identities`, `rotating` and imports `MessageBuilder` for Task 10's tests only, so `pnpm lint` fails at that commit; Task 9 shipped without them and Task 10 restored the plan's exact file before its edits. (3) `pnpm exec prettier --check .dockerignore` (Task 2) errors with "No parser could be inferred"; `pnpm format:check` skips the file, so only the Compose file was checked. (4) Prettier re-wraps one over-long line of the P6 block once it is indented inside the `describe`; the plan expected indentation changes only. (5) `docker compose ps --services --status paused` prints one empty line when nothing is paused, so the plan's `| wc -l → 0` reads 1; the checks used `grep -c .` (the `pause()` recovery's `split('\n').includes(service)` is unaffected). (6) The `mongosh` ping right after Task 2's cold `up --wait` was refused once: the mongo image starts a temporary `mongod` to create the root user, the health check passes against it, and the real server listens a moment later (two "Waiting for connections" lines); a retry answered `1`, and the harness's 5 s server selection bridges the gap. (7) `pnpm test --reporter=verbose` hands the flag to pnpm's own `--reporter` option; the order proof of criterion 12 used `pnpm exec vitest run --reporter=verbose` (45 unit files listed before the 3 integration files). (8) Prettier's parser for the fenced `ts` blocks is not invoked on a plan, so the edit scripts extracted the blocks by line range before any edit touched the plan file.
>
> **Corrections applied during review:** Stage 1 (spec compliance) PASS for every task. Stage 2, the harness code review: six BLOCKING findings — the harness's two `amqpConnect` calls had no timeout, the direct publisher's close recovery was unbounded, `createEnvironment` and both connects rethrew driver errors with the URL, `parseComposeConfig` and `LogCapture` had no unit test (fixed in `7cf3ac9` and `909595a`: `HARNESS_TIMEOUT_MS` on the connects and the close, `describeError` on every rethrow, `test/harness/stack.test.ts` and `test/harness/wait.test.ts`), and `awaitAcked`'s exact count called unsafe under redelivery — rejected and withdrawn by the reviewer after tracing every call site (no `awaitAcked` site closes a link mid-test, C10 uses `awaitEndState`, `acked` never decreases, an overshoot fails with the counts in the text, and `>=` would hide a lost acknowledgement). The load-generator test-quality review: the case "computes the expectation from the sends alone" compared `expectationOf(sends)` with `generateLoad`'s own call of it (a tautology) — rewritten to drop a device's last metrics message and assert the reduced oracle, with five suggestions applied (`94fd90f`, `load.test.ts` now 10 cases). The integration test-quality review: PASS, 25 of 25 meaningful; its suggestion for I4 (no `confirm_stall` recycle while blocked) landed in `5cd6241`; C9's timing bound kept, it measures from the fault's start. The integration code review: one BLOCKING `needs docs` on the watermark default 0.6, resolved with the RabbitMQ memory guide and a live `rabbitmqctl eval` (`{ok,0.6}` on 4.3.5), both cited in `9c7b5ba`; its three suggestions in `af73138` (a `describe` on I2's last wait, `env.track(restart(...))` in I2 and C10, one shared recovery bound in `dispose()` so C11c's two faults fit the hook budget). Conventions: `mergeExpected({ first, second })` and `userinfo({ user, password })` (`b6d4b83`, `7cf3ac9`); the global setup names a failed teardown next to the setup error; the spawned child's SIGKILL recovery awaits the exit; the C11b store gate is released when the test's signal aborts. Unit tests moved from 889 to 906 (26 in the harness); the full suite is 931 tests in 48 files.
>
> **Deferrals worth tracking:** (1) T70 — the consumer's `#closeLink` closes the connection right after the last acknowledgement and the broker redelivers that message; C11b tolerates it as `150 + n`; the fix (a channel close before the connection close) is a processing-spec decision for a later step. (2) T65 — the signal path with deliveries in flight is proven in-process only (C11b); I5 and C11 cover the process boundary with the service idle. (3) The suggestion to fail fast on an unbound `env.signal` was not applied: the accessor `environment(signal)` is the only way a test obtains `env`. (4) T63/T64 — one test stack per machine and `pnpm test` needs Docker; `pnpm test:unit` and the scoped verifies do not. (5) The mongo image's init restart after a cold start: a client without retries can be refused for about a second after `up --wait` reports healthy — the README's run instructions should not promise an immediate `mongosh` answer.
>
> **Plan history below is preserved as-written for context. Treat the live code as authoritative.**
>
> **Run record (Task 11), 2026-09-15.** `pnpm test:integration` twice on the final code of this plan (after the review fixes), from a state with no `telemetry-test` container, the stack started and removed by the global setup each time, nothing left behind: 68.5 s and 68.0 s wall time, 25 tests in 3 files. Per file, the sum of the test durations of the second run: `pipeline.test.ts` 6 tests 2.5 s, `ingest-publisher.test.ts` 7 tests 16.7 s, `processing-consumer.test.ts` 12 tests 42.4 s (the reporter prints no per-file line in this mode). The five slowest tests of that run: C9 14.0 s, I2 7.6 s, C8 6.1 s, C10 5.9 s, C15 5.0 s. Full pre-flight (`pnpm format:check && pnpm lint && pnpm typecheck && pnpm test`): 931 tests in 48 files, 80 s wall time, the unit project's 45 files listed before the 3 integration files. Docker Engine 29.4.0, Docker Compose v5.1.2 (the versions the spec measured with).

# Integration Tests Implementation Plan

**Goal:** Turn the two scripted runs and the ledger's six behaviour items of TODO step 7 into automated integration tests that run against a real RabbitMQ and MongoDB from `pnpm test`, with a harness that starts and removes its own Docker Compose stack, isolates every test in its own virtual host and database, injects the same faults the scripted runs did, and leaves nothing behind.

**Approach:** Twelve tasks in dependency order. Task 1 records the spec's four amendments in the earlier specs, adds the three the plan's probe found (A18), and commits this plan. Task 2 transcribes the test stack from the spec and runs it. Task 3 wires the root (`package.json`, `test/tsconfig.json`, `vitest.config.ts`) and lands the global setup that starts the stack. Tasks 4 and 5 build the harness bottom-up (management client, per-test environment, waits; then the in-process services, the clients and the seeded load generator with its unit test). Tasks 6 to 10 add the three test files in the order the spec's catalogue lists them, each task ending with a live run of the file. Task 11 measures the suite, ticks the ledger and appends the trade-off rows T61–T68 and T70. Task 12 is the optional CI workflow. No file under `apps/` or `packages/` changes; the 880 unit tests of `9f6d072` stay as they are, and the harness gains one unit-tested module (the load generator, 9 cases). Every code block below was assembled and run in a throwaway worktree before review: typecheck, lint, Prettier, the 889 unit tests, and the 25 integration tests against the real stack twice, 72 s per run with nothing left behind (Research, probe).

Every task gives exact paths and the full content of every new file. The Compose file, `test/tsconfig.json` and the Vitest project block are the spec's, verbatim; the harness modules follow the spec's signatures and the sources they wrap (`apps/*/src/main.ts`, the unit tests' child-process and capture patterns).

**Design spec:** `docs/specs/2026-09-14-integration-tests-design.md` (committed as `9d78a2f`, revised in `2d424ba`; two `design-reviewer` rounds plus three of the user's reviews, all fixed). Binding above it: `docs/specs/2026-09-11-telemetry-consistency-design.md` (the invariants the tests prove and the trade-off list this plan extends), `docs/specs/2026-09-13-ingest-design.md` decision 25 and `docs/specs/2026-09-13-processing-design.md` decision 27 (the scripted runs these tests replace), `docs/specs/2026-09-14-docker-compose-design.md` (the development stack the test stack must not collide with), `docs/specs/2026-09-08-monorepo-tooling-design.md` decision 8 (the `integration` project this plan fills).
**TODO items:** `7. Integrační testy` — all eleven items: the infrastructure (Tasks 2–5), the six behaviour tests (Tasks 6, 7, 9), the publisher scenarios (Task 8), the consumer scenarios including C11c (Tasks 9–10), the root `test` script (Task 3), the optional CI pipeline (Task 12). Task 11 ticks them.
**Branch:** `main`, no worktree, as the user chose for this step on 2026-09-14 (the spec was written and committed on `main`). Small atomic commits, imperative subjects, no `Co-Authored-By`, no AI mention. Before the first commit, `/implement` checks `git status`, `git log -1` (must be `9f6d072` or a descendant) and `ListAgents` for another session on this repository (standing rule: no parallel sessions on `main`).
**Scope:** New: `docker-compose.test.yml`, `test/tsconfig.json`, `test/harness/*.ts` (eight modules and one unit test), `test/integration/*.test.ts` (three files), `.github/workflows/ci.yml` (optional). Changed: `vitest.config.ts`, `package.json`, `pnpm-lock.yaml` (the root importer), `.dockerignore`, `.env.example`, `TODO.md`, five specs (Task 1), the consistency spec's trade-off list (Task 11), this plan's header (Task 11). Nothing under `apps/` or `packages/`.

## Assumptions decided without asking (standing instruction: work autonomously, log every decision)

| #   | Assumption                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Basis                                                                                                                                                                                                                                                                                                                                                                                      |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| A1  | The work lands on `main` directly, one commit per task (two where a task says so). The `/plan` session leaves this file uncommitted; Task 1 commits it together with the spec amendments.                                                                                                                                                                                                                                                                                                                  | The user's choice for step 7 (spec written on `main`); commits happen only inside an approved plan (feedback: autonomy, but commits on request).                                                                                                                                                                                                                                           |
| A2  | The harness keeps the spec's seven modules and adds one: `test/harness/load.ts` holds `generateLoad`, `mergeExpected` and `expectationOf` (the spec lists them under `clients.ts`), with a unit test `test/harness/load.test.ts` run by the `unit` project, whose `include` gains `test/harness/**/*.test.ts`.                                                                                                                                                                                             | The spec: "the module split under `test/harness/` is the shape, not a contract". The generator's `expected` is the oracle of P6, C6, C10, C11b and C15; an error in it fails a correct pipeline or passes a broken one, and the test-quality reviewer rejects an oracle without a test of its own (the compose plan's `9cceec8` precedent).                                                |
| A3  | `load.ts` reuses the emulator's seeded PRNG (`apps/emulator/src/random.ts`, `createRandom`), so `test/tsconfig.json` references `apps/emulator` as well; the spec's "not referenced because the tests do not import it" no longer holds once the generator imports it.                                                                                                                                                                                                                                     | Spec decision 17 allows the reuse ("the emulator's `random.ts` PRNG may be reused"); a copy of mulberry32 in the harness would be the duplication the reviewers flag.                                                                                                                                                                                                                      |
| A4  | C8 runs with `MONGODB_TIMEOUT_MS=1000` and `PROCESSING_TRANSIENT_ATTEMPTS=3` (C9 with the same two), not the defaults 5 000 and 5; C11c runs with `MONGODB_TIMEOUT_MS=1000` as well, so the store's start loop notices the restarted MongoDB within a second instead of five.                                                                                                                                                                                                                              | Against a stopped MongoDB every handler attempt waits the full server-selection timeout before it fails, so five attempts at 5 s plus the jittered backoff put the pause after the 30 s test budget; the processing scripted run (plan header of `2026-09-13-processing-plan.md`) used exactly these two values for its scenarios 8 and 9 and saw the pause within seconds.                |
| A5  | I2, C8, C9, C10, C11b, C11c and C15 get a per-test timeout of 45 s (the third argument of `it`), P6 and C6 60 s; every other test keeps the project's 30 s.                                                                                                                                                                                                                                                                                                                                                | The arithmetic in each task: a stop-and-start of MongoDB plus the store watcher's backoff (up to 10 s after several failed pings) plus the consumer's reconnect backoff (up to 10 s after a broker restart) can add up to 25–30 s on a slow machine; a bound that a correct run can hit is a flaky test. The spec's Scaling table estimates, not fixes, the durations.                     |
| A6  | In I2 the "one `warn` line with the recycle trigger" is asserted as: at least one `publisher reconnect scheduled` line whose `reason` is `channel_closed` or `connection_closed`, and every such line's reason is one of those two or `connect_failed`.                                                                                                                                                                                                                                                    | While the broker is down, every failed connect attempt writes its own `publisher reconnect scheduled` line with `reason: 'connect_failed'` (`apps/ingest/src/publisher.ts`, `#startBackoff`), so "exactly one line" would fail a correct run; the recycle reason is `channel_closed` because the channel's prepended close listener runs first (processing plan header, scenario 10 note). |
| A7  | The I4 wait for the block is `logs.waitForLine(byMsg('connection blocked'))`: the publisher's state machine logs `connection blocked`, not `blocked` (spec catalogue shorthand).                                                                                                                                                                                                                                                                                                                           | `apps/ingest/src/publisher-state.ts`, `fromReady`, case `blocked`: `log({ level: 'warn', message: 'connection blocked', … })`. The spec says the plan fixes the exact `msg` strings from the source.                                                                                                                                                                                       |
| A8  | No red check runs in the main tree. Each test task names, in a "What fails it" line, the regression the test would catch, traced through `#settle`, `runAttempt` and `classifyOutcome`; the tests prove shipped behaviour, so the skill's "verify the test fails" step is replaced by that trace.                                                                                                                                                                                                          | Feedback rule: a temporary revert in the shared checkout is a mutant, even when restored; the spec's catalogue was already traced assertion by assertion in the user's three reviews.                                                                                                                                                                                                      |
| A9  | The direct publisher's `publish()` resolves on the broker's confirm and rejects when the confirm fails or the channel throws; it carries no reconnect logic. C10 and C15 open a fresh publisher or connection after a restart.                                                                                                                                                                                                                                                                             | Spec decision 24 and the Clients section.                                                                                                                                                                                                                                                                                                                                                  |
| A10 | Every in-body Docker command carries the test's `AbortSignal` (`env.signal`) plus an `execFile` ceiling that is a safety net for a run without a signal: 10 s for `pause` and the `rabbitmqctl` alarm, 20 s for `stop`, `restart` and the `up --wait --wait-timeout 15` that follows a restart; every recovery in `dispose()` runs under its own `AbortSignal.timeout(50_000)`.                                                                                                                            | Spec decision 12 and the `stack.ts` table; `stop` gets 20 s rather than the spec's 10 s because a container stop waits for the process to exit (up to Docker's 10 s grace), which is not sub-second on a loaded machine.                                                                                                                                                                   |
| A11 | `dispose()` aborts an internal controller first, so a stray wait or an in-flight fault command of a timed-out test ends at once; the test's signal is combined with that controller through `AbortSignal.any`.                                                                                                                                                                                                                                                                                             | The spec asks `dispose()` to await in-flight commands (bounded at 5 s) before it recovers; aborting them first makes the bound a formality on the happy path and a real bound on a hung command.                                                                                                                                                                                           |
| A12 | The `hostname` option of `startProcessing` names the AMQP connection (`connection_name: processing@<hostname>`) only; the two C6 instances are told apart by their separate `LogCapture` objects, not by a log field.                                                                                                                                                                                                                                                                                      | `apps/processing/src/consumer.ts` uses `hostname` for `connection_name` only; the logger's `hostname` binding is `os.hostname()` (`packages/shared/src/logger.ts`).                                                                                                                                                                                                                        |
| A13 | Test names carry the catalogue ids (`P1 one message of each type reaches MongoDB`), so a failure in the reporter maps to the spec's row.                                                                                                                                                                                                                                                                                                                                                                   | The catalogue is what the technical discussion will refer to.                                                                                                                                                                                                                                                                                                                              |
| A14 | The CI workflow pins the current majors `actions/checkout@v7`, `pnpm/action-setup@v6` (no `version` input: it reads `packageManager`), `actions/setup-node@v7` (`node-version: 24`, `cache: pnpm`), and runs `pnpm format:check`, `pnpm lint`, `pnpm typecheck`, `pnpm test` as separate steps so the log names the failing one.                                                                                                                                                                           | Checked on 2026-09-14 with the GitHub releases API (Research); the pnpm action's README: `version` is optional with `packageManager`, and the action "does not set up Node.js".                                                                                                                                                                                                            |
| A15 | The suite's wall time is measured in Task 11 on this machine and recorded in this plan's header and in `TODO.md`; the spec's estimate (60–120 s) is not a criterion, 180 s is (Verification Criteria).                                                                                                                                                                                                                                                                                                     | Spec, Scaling: "Whole suite ≈ 60–120 s; the plan measures it."                                                                                                                                                                                                                                                                                                                             |
| A16 | The unit test count moves from 880 to 889 (nine cases in `load.test.ts`); any other number is a regression to investigate, not to accept.                                                                                                                                                                                                                                                                                                                                                                  | `pnpm test:unit` at `9f6d072`: 880 tests in 42 files. This plan adds no test under `apps/` or `packages/`.                                                                                                                                                                                                                                                                                 |
| A17 | Docker Engine and Compose on the implementing machine are the ones the spec measured (29.4.0, v5.1.2 on 2026-09-14); the floors are Engine 25 and Compose 2.20.2. Task 2 checks `docker info` before anything else.                                                                                                                                                                                                                                                                                        | Compose spec decision 13 (`start_interval`); checked again while writing this plan.                                                                                                                                                                                                                                                                                                        |
| A18 | C11b asserts `b.received === 150 + n`, where `n` is the number of deliveries b saw with `redelivered: true`, each of them `duplicate: true` and `stale`, instead of the spec's `b.received === 150` with no redelivery; the consumer is not changed in this step, the finding is recorded as T70 and in the spec amendments of Task 1. Whether to fix the consumer (a channel close before the connection close in `#closeLink`, plus a unit test and a processing-spec amendment) is the user's decision. | Measured in the plan's probe (Research): the real broker redelivered the message acknowledged right before the connection close in three runs of three, and two consumer-side variants removed it. The spec's assertion would fail a correct pipeline on a broker behaviour, and the scope rule ("no change under `apps/`") is the user's, not the plan's, to lift.                        |

## Research (source links)

The design spec's Research section (checked 2026-09-14) covers Vitest 4.1.11 (`globalSetup`, `provide`/`inject`, `passWithNoTests`, `fileParallelism`, `sequence.groupOrder`, the test context `signal`, projects), Docker Compose (`-p`, `ports`, `pause`/`unpause`/`restart`/`stop`/`start`, `ps --services --status`, `up --wait`, `down -v`, `exec -T`, `config --format json`), RabbitMQ 4.3 (the vhost and permission endpoints, `GET/DELETE /api/queues/{vhost}/{name}`, `POST …/get`, the alarm endpoint, the memory watermark, blocked connections, dead-letter reasons, the statistics interval), amqplib 2.0.1 (`connect` and vhost escaping, heartbeats, failure semantics, `checkQueue`, `cancel`, pending replies on close, `close()` on a dead connection), the MongoDB driver's `dropDatabase`, Node's `execFile`/`AbortSignal.timeout`/`fetch` credential rule, and the source facts behind decisions 13, 23 and 24. Those links are not repeated. This plan adds what the harness code and the CI file need.

- [pnpm workspaces, the `workspace:` protocol](https://pnpm.io/workspaces#workspace-protocol-workspace) (read 2026-09-14) — "pnpm will refuse to resolve to anything other than a local workspace package"; `"foo": "workspace:*"` is the usual form. The root `package.json` is a workspace project like any other, so `"@telemetry/shared": "workspace:*"` in its `devDependencies` links `packages/shared` into the root `node_modules`; Task 3 verifies it by `tsc` resolving the import from `test/harness/`. Decision 10.
- [`pnpm/action-setup` README](https://github.com/pnpm/action-setup) (read 2026-09-14) — `version` is "Optional when there is a `packageManager` or `devEngines.packageManager` field in the `package.json`"; example `uses: pnpm/action-setup@v6` with no inputs; "This action does not set up Node.js. Use actions/setup-node yourself." A14, Task 12.
- [GitHub Docs, Building and testing Node.js, "Example caching dependencies"](https://docs.github.com/en/actions/tutorials/build-and-test-code/nodejs#example-caching-dependencies) (read 2026-09-14) — the pnpm example runs `pnpm/action-setup` first and then `actions/setup-node` with `cache: 'pnpm'`, which is the order Task 12 uses; the docs' own example still pins `actions/checkout@v6` and `actions/setup-node@v4`. A14.
- GitHub releases API, 2026-09-14 (`gh api repos/<owner>/<repo>/releases/latest --jq .tag_name`): `actions/checkout` v7.0.1, `actions/setup-node` v7.0.0, `pnpm/action-setup` v6.1.0. The workflow pins the majors `v7`, `v6`, `v7`. A14.
- [MongoDB Node.js driver API, `Collection` (docs 7.x)](https://github.com/mongodb/node-mongodb-native/blob/main/docs/7.5/classes/Collection.html) (Context7, 2026-09-14) — `find(filter, options?)` returns `FindCursor<WithId<TSchema>>`, chained with `.sort()` and `.toArray()`; `findOne(filter)`; `deleteOne(filter)`; [`Db.dropDatabase()`](https://github.com/mongodb/node-mongodb-native/blob/main/docs/7.5/classes/Db.html) "Drop a database, removing it permanently from the server", returns `Promise<boolean>`. The readers of `clients.ts`, the deletions of C13/C14, the `dispose()` drop.
- Node 24: [`AbortSignal.any(signals)`](https://nodejs.org/docs/latest-v24.x/api/globals.html#static-method-abortsignalanysignals) — "Returns a new `AbortSignal` which will be aborted if any of the provided signals are aborted" (the environment's combined signal, A11); [`timersPromises.setTimeout(delay, value, { signal })`](https://nodejs.org/docs/latest-v24.x/api/timers.html#timerspromisessettimeoutdelay-value-options) rejects with an `AbortError` when the signal aborts (the poll of `waitFor`, the same call the services use); [`child_process.execFile` `signal`](https://nodejs.org/docs/latest-v24.x/api/child_process.html#child_processexecfilefile-args-options-callback) — "The signal option allows aborting the child process using an AbortSignal", the promisified form rejects with an `AbortError`; `Promise.withResolvers` is already used by `apps/processing/src/consumer.ts`.
- Docker on this host (checked 2026-09-14 while writing this plan): Engine 29.4.0, Compose v5.1.2, the versions the spec measured with. A17.
- Log message strings the tests wait for, read from the sources on 2026-09-14 (the spec asked the plan to fix them): ingest — `ingest starting`, `connection accepted` (`apps/ingest/src/server.ts:212`), `message rejected` with `reason` (`apps/ingest/src/connection.ts:233`), `publisher connected` (info) and `connection blocked` (warn, `reason`) and `connection unblocked` (`apps/ingest/src/publisher-state.ts`), `publisher reconnect scheduled` (warn, `reason`, `attempt`, `delayMs`; `apps/ingest/src/publisher.ts:649`), `message returned` (error; `publisher.ts:481–483`), `publisher stopping`, `shutdown drain ended at its budget` (`server.ts:279`), `shutting down` and `stopped` (`packages/shared/src/lifecycle.ts`); processing — `processing starting`, `consumer connected` (`apps/processing/src/consumer.ts:369`), `consumer registered` (`:598`), `consumer reconnect scheduled` (warn; `:869`), `consumer stopping` (`:232`), `consumer cancel` (debug, `outcome`; `:749`), `consumer paused` (warn, `returned`; `:784`), `shutdown drain ended at its budget` (`:244`), `shutdown ended before the link closed` (`:263`), `store ready` and `store not ready` (`apps/processing/src/store.ts:257,271`), `transient store failure` (warn, `failure`, `step`, `attempt`; `apps/processing/src/handler.ts:144`), `message rejected` (warn, `reason`; `handler.ts:102`), `delivery processed` (`redelivered`, `outcome`, `duplicate`; `handler.ts:128–130`).
- Counter semantics the assertions rest on (`apps/processing/src/consumer.ts` `#settle`, lines 662–709): `acked` and the outcome counter (`created`/`applied`/`stale`) move together with `channel.ack`; `duplicate` counts duplicate event inserts of any cause; `alerts` counts created alerts; `failed` counts permanent rejections, `rejected` the decode rejections; `abandoned` counts deliveries left unacknowledged; `received` counts deliveries; `inFlight` is the number of running handlers. `ServerStats.rejected` (`apps/ingest/src/server.ts:121–133`) counts rejected frames over the instance's life; `PublisherStats` (`publisher.ts:201–208`): `confirmed`, `unconfirmed` (ledger size), `republished`, `returned`.
- The readiness reasons: ingest `connecting` | `blocked` | `shutting_down` (`apps/ingest/src/health.ts`), processing `connecting` | `mongodb` | `shutting_down` (`apps/processing/src/health.ts`); the health server binds every interface on the requested port and reports the bound port (`packages/shared/src/health.ts`, `HealthServer.port`).
- `apps/ingest/src/test-device.ts` — `connectTestDevice({ port })` resolves with `{ ws, socket, send, sendBinary, sendMessage, pings, closed, close, terminate }`; `closed` resolves with `{ code, reason }`. `apps/ingest/src/amqp-message.ts` — `toPublishArgs(message, receivedAt)` returns `{ exchange, routingKey, content, options }` with `messageId`, `contentType`, `persistent`, `mandatory`, `timestamp` (seconds) and the `x-received-at` header. `apps/emulator/src/random.ts` — `createRandom(seed)` returns `{ float, int, bool, pick, range }`.
- Probe of 2026-09-15, in a throwaway worktree (`plan-probe`, removed afterwards; the shared checkout was not touched): the code blocks of Tasks 2–10 and 12 were assembled as the tasks say, with the root `package.json` change of Task 3. `pnpm install --offline` updated the lockfile with exactly one `link:packages/shared` line and no new resolution; `pnpm typecheck` passed; `pnpm lint` passed after two fixes that are now in the blocks (`no-base-to-string` in the direct publisher's confirm callback, `unbound-method` on the gate's `wrap`); the nine cases of `load.test.ts` passed after two assertions were made order-independent; Prettier accepted every block verbatim, except that the two test blocks appended inside a `describe` (Tasks 7 and 10) need re-indenting by `prettier --write`. The whole integration suite then ran against the real stack (Docker Engine 29.4.0, Compose v5.1.2, `rabbitmq:4.3-management`, `mongo:8.0`): 24 of 25 tests passed on the first run, 95 s wall time including the stack's start and removal, nothing left behind. C11b failed on the spec's exact-remainder assertion with `acked 151 of 150`: in three runs of three, the message the first instance acknowledged last (`A last processed` equals b's one `redelivered: true` delivery, `duplicate: true`, `stale`) was redelivered to the second instance, while the first instance's own counters were exact (`received 50, acked 50, abandoned 0`, no warn line, `amqp connection close` outcome `closed`). Two throwaway variants of `apps/processing/src/consumer.ts` in the probe, each run twice: a 200 ms pause before `model.close()` → 2 of 2 passed; `await settleWithin(link.channel.close(), AMQP_CLOSE_TIMEOUT_MS)` before the connection close in `#closeLink` → 2 of 2 passed. The consumer's shipped shutdown therefore loses the last acknowledgement to the broker's connection teardown; the test records it (A18, T70), the consumer stays as it is. With C11b changed to `150 + n` (A18) the whole suite passed twice in a row, 25 of 25, 72.6 s and 71.8 s wall time including the stack's start and removal; after the review fixes of the same day (I2's `BACKOFF_REASONS`, C10's readiness poll, the shared level constants) it passed once more, 25 of 25 in 71.4 s, again with no container or volume left.
- The MongoDB driver waits the whole `serverSelectionTimeoutMS` when the one server is unreachable (`apps/processing/src/store.test.ts` needs `timeoutMs: 200` "against a closed port" for a fast failure; the processing scripted run used `MONGODB_TIMEOUT_MS=1000`). A4.

## File Changes

| Action | Path                                                    | Purpose                                                                                                                                                               |
| ------ | ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Modify | `docs/specs/2026-09-08-monorepo-tooling-design.md`      | Decision 8: the `integration` project's `include`, `passWithNoTests` gone, `typecheck` covers `test/` (Task 1)                                                        |
| Modify | `docs/specs/2026-09-14-docker-compose-design.md`        | The forward note for step 7 is resolved (Task 1)                                                                                                                      |
| Modify | `docs/specs/2026-09-13-ingest-design.md`                | Decision 25: the step 7 test file is named (Task 1)                                                                                                                   |
| Modify | `docs/specs/2026-09-13-processing-design.md`            | Decision 27: the step 7 test files are named; decision 20: the lost last acknowledgement is measured (Task 1)                                                         |
| Modify | `docs/specs/2026-09-14-integration-tests-design.md`     | Decision 24 and the C11b row: the broker redelivers the last acknowledged message, C11b counts it (Task 1, A18)                                                       |
| Create | `docker-compose.test.yml`                               | The test stack: RabbitMQ and MongoDB, fixed loopback ports, no volumes (Task 2)                                                                                       |
| Modify | `.env.example`                                          | The three `TEST_*_PORT` names (Task 2)                                                                                                                                |
| Modify | `.dockerignore`                                         | `test` (Task 2)                                                                                                                                                       |
| Modify | `package.json`                                          | Five dev-dependencies; `typecheck` covers `test/` (Task 3)                                                                                                            |
| Modify | `pnpm-lock.yaml`                                        | The root importer's new dependencies (Task 3, `pnpm install`)                                                                                                         |
| Create | `test/tsconfig.json`                                    | Type-checks `test/**` against the built declarations of the four projects; emits nothing (Task 3)                                                                     |
| Modify | `vitest.config.ts`                                      | The `integration` project: `include`, `globalSetup`, `sequence.groupOrder`, no `passWithNoTests`; the `unit` project includes `test/harness/**/*.test.ts` (Task 3)    |
| Create | `test/harness/stack.ts`                                 | `docker compose` on the test file, the provided `TestStack` and its parser (Task 3); the fault helpers `pause`, `stop`, `restart`, `raiseMemoryAlarm` (Task 8)        |
| Create | `test/harness/global-setup.ts`                          | Starts the stack, provides the connection details, removes what it started, also when a later step fails (Task 3)                                                     |
| Create | `test/harness/management.ts`                            | The RabbitMQ HTTP API: vhosts, permissions, queue info, `get`, delete queue, alarms (Task 4)                                                                          |
| Create | `test/harness/wait.ts`                                  | `waitFor`, `awaitAcked`, `awaitEndState`, `LogCapture`, `byMsg` (Task 4)                                                                                              |
| Create | `test/harness/environment.ts`                           | The per-test virtual host and database, the undo stack with retry-until-success, the in-flight command register, `dispose()`, the accessor `bindEnvironment` (Task 4) |
| Create | `test/harness/load.ts`                                  | The seeded load generator, its expectation, `mergeExpected` (Task 5)                                                                                                  |
| Create | `test/harness/load.test.ts`                             | Nine unit cases of the generator, run by the `unit` project (Task 5)                                                                                                  |
| Create | `test/harness/services.ts`                              | `startIngest`, `startProcessing` (in-process, optional store wrapper), `spawnService` (child process), `freePorts` (Tasks 5 and 8)                                    |
| Create | `test/harness/clients.ts`                               | Devices over `ws`, the message builder, the direct AMQP publisher, `queueDepth`, the `holdInserts` gate, MongoDB readers (Task 5)                                     |
| Create | `test/integration/pipeline.test.ts`                     | P1–P5 (Task 6), P6 (Task 7)                                                                                                                                           |
| Create | `test/integration/ingest-publisher.test.ts`             | I1–I7 (Task 8)                                                                                                                                                        |
| Create | `test/integration/processing-consumer.test.ts`          | C6, C7, C12, C13, C14 (Task 9); C8, C9, C10, C11, C11b, C11c, C15 (Task 10)                                                                                           |
| Modify | `docs/specs/2026-09-11-telemetry-consistency-design.md` | Rows T61–T68; T36 and T44 marked closed (Task 11)                                                                                                                     |
| Modify | `TODO.md`                                               | Step 7 ticked with the run numbers (Task 11)                                                                                                                          |
| Modify | `docs/plans/2026-09-15-integration-tests-plan.md`       | The suite's measured wall time in the header (Task 11); the `STATUS: SHIPPED` header (`/implement`)                                                                   |
| Create | `.github/workflows/ci.yml`                              | Format, lint, typecheck, unit and integration tests on every push (Task 12, optional)                                                                                 |

## Tasks

### Task 1: Record the spec amendments and commit the plan [mechanical]

**Files:** Modify `docs/specs/2026-09-08-monorepo-tooling-design.md`, `docs/specs/2026-09-14-docker-compose-design.md`, `docs/specs/2026-09-13-ingest-design.md`, `docs/specs/2026-09-13-processing-design.md`, `docs/specs/2026-09-14-integration-tests-design.md`; commit `docs/plans/2026-09-15-integration-tests-plan.md`
**Invariant:** none touched (documentation).
**Verify:** `pnpm format:check` (the five specs and this plan pass Prettier), then `git show --stat HEAD` lists exactly the six files.

The integration spec's section "Amendments to earlier specs" names four edits; the plan's probe adds three more (the C11b finding, A18: the integration spec's decision 24 and its C11b row, and the processing spec's decision 20). Each is appended inside the existing table cell or paragraph, so the original text stays for the record (the precedent of the ingest and processing plans' Task 1). Use the Edit tool with the exact old text; each old text occurs once in its file.

- [ ] Tooling spec, decision 8, decision cell: after the text `` `integration` (`*/test/integration/**/*.test.ts`, longer timeouts, no file parallelism) `` append ``**Amended 2026-09-15** (integration spec, decision 8): the `integration` project's `include` is `test/integration/**/*.test.ts` at the repository root, not per package; `passWithNoTests` is gone; the `unit` project also runs `test/harness/**/*.test.ts` (the harness's own unit test); `typecheck` is `tsc -b tsconfig.json test/tsconfig.json` and `build` stays `tsc -b`.``
- [ ] Compose spec, the paragraph that starts `**Forward note for step 7.**`: after `The seam is named here so that step is not surprised.` append ``**Resolved 2026-09-15** by the integration tests spec (`docs/specs/2026-09-14-integration-tests-design.md`, decisions 1 and 2): a file of its own, `docker-compose.test.yml`, under the project name `telemetry-test`, with the loopback ports 5673, 15673 and 27018 and no volumes, so both stacks run side by side.``
- [ ] Ingest spec, decision 25, decision cell: after `and step 7 adds automated integration tests for it (a new `TODO.md` item).` append ``**Named 2026-09-15** (integration spec, decision 18): those tests are `test/integration/ingest-publisher.test.ts`, scenarios I1–I7 of that spec's catalogue; T36 closes when they land.``
- [ ] Processing spec, decision 27, decision cell: after `the ingest trade-off T36, repeated as T44.` append ``**Named 2026-09-15** (integration spec, decision 18): the tests are `test/integration/processing-consumer.test.ts` (scenarios 6–12 as C6–C12, scenario 11 as C11, C11b and C11c, plus the recovery tests C13 and C14 and the durability test C15) and `test/integration/pipeline.test.ts` (scenarios 1–5 as P1–P5, driven through ingest); T44 closes when they land.``
- [ ] Integration spec, decision 24, decision cell: after `a second in-process instance then acknowledges exactly the other 150.` append ``**Amended 2026-09-15** (the plan's probe, A18): the second instance acknowledges the other 150 plus the message the first instance acknowledged right before its link closed, which the broker redelivers (three runs of three); C11b counts those `redelivered: true` deliveries, requires each to be `duplicate: true` and `stale`, and asserts `b.received === 150 + n`. The exact remainder needs a channel close before the connection close in the consumer (T70).``
- [ ] Integration spec, the C11b row of the consumer catalogue, assert cell: replace `` `b.received === 150` and no `delivery processed` line of `b` carries `redelivered: true` (the 150 were never delivered before) `` with `` `b.received === 150 + n` where `n` is the number of `delivery processed` lines of `b` with `redelivered: true`, each of them `duplicate: true` and `stale` (amended 2026-09-15: the broker redelivers the message acknowledged right before the link close, T70) ``.
- [ ] Processing spec, decision 20, reasoning cell: after `The whole stop takes at most `SHUTDOWN_TIMEOUT_MS + AMQP_CLOSE_TIMEOUT_MS` plus one MongoDB timeout.` append ``**Measured 2026-09-15** (integration plan, probe of C11b): closing the connection right after the last acknowledgement loses that acknowledgement — the broker redelivers the message to the next instance, absorbed as a duplicate (three runs of three); a `channel.close()` awaited before the connection close removed it (two runs of two). Recorded as T70; changing the close order is a decision for a later step.``
- [ ] `pnpm exec prettier --write docs/specs/2026-09-08-monorepo-tooling-design.md docs/specs/2026-09-14-docker-compose-design.md docs/specs/2026-09-13-ingest-design.md docs/specs/2026-09-13-processing-design.md docs/specs/2026-09-14-integration-tests-design.md docs/plans/2026-09-15-integration-tests-plan.md` (a table cell that grew re-aligns its whole table; that is the expected diff), then `pnpm format:check`.
- [ ] `grep -c 'Amended 2026-09-15' docs/specs/2026-09-08-monorepo-tooling-design.md` → 1; `grep -c 'Resolved 2026-09-15' docs/specs/2026-09-14-docker-compose-design.md` → 1; `grep -c 'Named 2026-09-15' docs/specs/2026-09-13-ingest-design.md docs/specs/2026-09-13-processing-design.md` → 1 each; `grep -c 'Amended 2026-09-15\|amended 2026-09-15' docs/specs/2026-09-14-integration-tests-design.md` → 2; `grep -c 'Measured 2026-09-15' docs/specs/2026-09-13-processing-design.md` → 1.
- [ ] Commit the five specs and this plan — subject: `Record the integration tests plan and the spec amendments`.

### Task 2: The test stack [integration]

**Files:** Create `docker-compose.test.yml`; modify `.env.example`, `.dockerignore`
**Invariant:** none touched (infrastructure); the isolation from the development stack is what the ledger's first item asks for.
**Verify:** the checks below against the real Docker daemon; `pnpm exec prettier --check docker-compose.test.yml .dockerignore`.

- [ ] `docker info --format '{{.ServerVersion}}'` prints a version (the daemon is up; A17). `docker compose version` prints v2.20.2 or newer.
- [ ] Create `docker-compose.test.yml` with exactly this content (the spec's block):

```yaml
# Integration-test stack (TODO step 7): RabbitMQ and MongoDB only. The vitest `integration`
# project starts it, runs the tests and removes it (test/harness/global-setup.ts).
#
#   pnpm test:integration                                      # starts it, runs the tests, removes it
#   docker compose -f docker-compose.test.yml up -d --wait     # keep it running between runs
#   docker compose -f docker-compose.test.yml down -v          # reset
#
# Separate from the development stack (docker-compose.yml) on purpose: its own project name, its
# own host ports, no volumes, so both can run at the same time and every test run starts from an
# empty broker and database. The credentials are the development placeholders, read through the
# same variable names, so one .env governs both stacks. The three port names exist only here.
name: telemetry-test

services:
  rabbitmq:
    image: rabbitmq:4.3-management
    environment:
      RABBITMQ_DEFAULT_USER: ${RABBITMQ_USER:-telemetry}
      RABBITMQ_DEFAULT_PASS: ${RABBITMQ_PASSWORD:-telemetry-dev}
    ports:
      # Fixed, not ephemeral: `docker compose restart` re-allocates an ephemeral host port, while
      # the services under test keep the URL they started with. Loopback only, as in the
      # development stack.
      - '127.0.0.1:${TEST_AMQP_PORT:-5673}:5672'
      - '127.0.0.1:${TEST_RABBITMQ_MANAGEMENT_PORT:-15673}:15672'
    healthcheck:
      test: ['CMD', 'rabbitmq-diagnostics', '-q', 'check_port_connectivity']
      interval: 10s
      timeout: 10s
      retries: 5
      start_period: 60s
      start_interval: 1s

  mongodb:
    image: mongo:8.0
    environment:
      MONGO_INITDB_ROOT_USERNAME: ${MONGODB_USER:-telemetry}
      MONGO_INITDB_ROOT_PASSWORD: ${MONGODB_PASSWORD:-telemetry-dev}
    ports:
      - '127.0.0.1:${TEST_MONGODB_PORT:-27018}:27017'
    healthcheck:
      test: ['CMD', 'mongosh', '--quiet', '--eval', "db.adminCommand('ping').ok"]
      interval: 10s
      timeout: 10s
      retries: 5
      start_period: 60s
      start_interval: 1s
# No `volumes:` section: the images' own volumes are anonymous and `down -v` removes them.
```

- [ ] Append to `.env.example`, after the `# --- docker compose only ---` block:

```
# --- integration tests (docker-compose.test.yml only) ---
# Read only when Compose interpolates docker-compose.test.yml; no service reads these names. Empty means the default in that file (5673, 15673, 27018).
# The test stack is separate from the development stack; change these only when another program already listens on a default port.
TEST_AMQP_PORT=
TEST_RABBITMQ_MANAGEMENT_PORT=
TEST_MONGODB_PORT=
```

- [ ] Append the line `test` to `.dockerignore` (after `scripts`): the image build neither compiles the tests nor needs them in its context (spec decision 9).
- [ ] The configuration renders with the defaults: `docker compose -f docker-compose.test.yml config --format json > /tmp/telemetry-test-config.json && node -e "const c=require('/tmp/telemetry-test-config.json');console.log(c.name,c.services.rabbitmq.ports.map(p=>p.published).join(','),c.services.mongodb.ports.map(p=>p.published).join(','))"` prints `telemetry-test 5673,15673 27018`; then `rm /tmp/telemetry-test-config.json` (the file holds the placeholder credentials). With `TEST_AMQP_PORT=5999` in the environment the first published port reads `5999`.
- [ ] Cold start: `docker compose -f docker-compose.test.yml ps -aq | wc -l` → 0, then `time docker compose -f docker-compose.test.yml up -d --wait --wait-timeout 120` exits 0 (the first run pulls the images if they are absent; with the images present the spec measured 3 s); `docker compose -f docker-compose.test.yml ps --services --status running` lists `rabbitmq` and `mongodb`; `curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:15673/api/overview` → `401` (the management listener answers on the test port; no credentials on the command line); `docker compose -f docker-compose.test.yml exec -T mongodb mongosh --quiet --eval 'db.adminCommand("ping").ok'` → `1`.
- [ ] Side by side with the development stack: `docker compose up -d --wait rabbitmq mongodb` (the development file) exits 0 while the test stack runs, `docker ps --format '{{.Names}}' | grep -c 'telemetry'` → 4; then `docker compose down -v` (development) leaves the two `telemetry-test-*` containers running.
- [ ] Teardown: `docker compose -f docker-compose.test.yml down -v` exits 0; `docker compose -f docker-compose.test.yml ps -aq | wc -l` → 0; `docker volume ls -q --filter name=telemetry-test | wc -l` → 0.
- [ ] `pnpm exec prettier --check docker-compose.test.yml .dockerignore` (Prettier does not check `.env.example`).
- [ ] Commit — subject: `Add the integration test stack`.

### Task 3: Root wiring, the global setup and the Compose helpers [mechanical]

**Files:** Modify `package.json`, `pnpm-lock.yaml`, `vitest.config.ts`; create `test/tsconfig.json`, `test/harness/stack.ts`, `test/harness/global-setup.ts`
**Invariant:** none touched (test infrastructure).
**Verify:** `pnpm install` (updates the lockfile), then `pnpm typecheck && pnpm lint && pnpm test:unit`, then the Docker-free checks below.

- [ ] `package.json`: change `"typecheck": "tsc -b"` to `"typecheck": "tsc -b tsconfig.json test/tsconfig.json"`; in `devDependencies` add, keeping the alphabetical order, `"@telemetry/shared": "workspace:*"`, `"@types/ws": "catalog:"`, `"amqplib": "catalog:"`, `"mongodb": "catalog:"`, `"ws": "catalog:"`. The `build`, `test`, `test:unit` and `test:integration` scripts keep their text (spec decision 16).
- [ ] `pnpm install` (not `--frozen-lockfile`: the root importer gains five entries). `git diff --stat pnpm-lock.yaml` shows one file; `git diff pnpm-lock.yaml | grep '^+' | grep -c 'link:packages/shared'` → 1; no new package version appears (`git diff pnpm-lock.yaml | grep -c '^+.*resolution'` → 0: every added dependency is already in the lockfile through the applications).
- [ ] Create `test/tsconfig.json`:

```json
{
  "extends": "../tsconfig.base.json",
  "compilerOptions": {
    "composite": false,
    "declaration": false,
    "declarationMap": false,
    "sourceMap": false,
    "noEmit": true
  },
  "include": ["**/*.ts"],
  "references": [
    { "path": "../packages/shared" },
    { "path": "../apps/ingest" },
    { "path": "../apps/processing" },
    { "path": "../apps/emulator" }
  ]
}
```

- [ ] Replace `vitest.config.ts` with:

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
          include: [
            '{apps,packages}/*/src/**/*.test.ts',
            // The pure helpers of the Compose check script (scripts/compose-check-lib.mjs).
            'scripts/**/*.test.mjs',
            // The integration harness's own pure logic (the seeded load generator).
            'test/harness/**/*.test.ts',
          ],
        },
      },
      {
        // Real RabbitMQ + MongoDB from docker-compose.test.yml, started and removed by the global
        // setup (integration spec, decisions 5, 8 and 15). After the unit project: the
        // heartbeat-timed scenarios must not share the CPU with its workers. Files run one at a
        // time because pause, restart and the memory alarm are broker-wide.
        extends: true,
        test: {
          name: 'integration',
          include: ['test/integration/**/*.test.ts'],
          globalSetup: ['test/harness/global-setup.ts'],
          sequence: { groupOrder: 1 },
          fileParallelism: false,
          testTimeout: 30_000,
          hookTimeout: 60_000,
        },
      },
    ],
  },
});
```

- [ ] Create `test/harness/stack.ts` (Task 8 appends the fault helpers to this file):

```ts
import { execFile as execFileCallback, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);

/**
 * `docker compose` on the test stack (integration spec, decisions 1, 5 and 12). The file is
 * resolved from this module, so Compose reads `.env` from the repository root whatever the working
 * directory (the pattern of `scripts/compose-check.mjs`).
 */
export const COMPOSE_FILE = fileURLToPath(
  new URL('../../docker-compose.test.yml', import.meta.url),
);

export const SERVICES = ['rabbitmq', 'mongodb'] as const;
export type Service = (typeof SERVICES)[number];

/** What the global setup provides to every test file (decision 6): host, ports, credentials. */
export type TestStack = {
  host: '127.0.0.1';
  amqpPort: number;
  managementPort: number;
  mongoPort: number;
  rabbitmq: { user: string; password: string };
  mongodb: { user: string; password: string };
};

/** Ceiling for a captured command that runs without a test signal (the setup's `ps` and `config`). */
const SETUP_COMMAND_TIMEOUT_MS = 180_000;
/** `config --format json` is a few kilobytes; the bound only keeps a runaway output from ending the child. */
const MAX_BUFFER_BYTES = 64 * 1024 * 1024;

export type ComposeOptions = {
  /** The test's own signal: an abort kills the Docker child and rejects at once (decision 12). */
  signal?: AbortSignal;
  /** A ceiling for a run without a signal, and a safety net under one. */
  timeoutMs?: number;
};

/** `docker compose -f docker-compose.test.yml <args>` with its output captured; rejects on a non-zero exit. */
export async function compose(
  args: readonly string[],
  options: ComposeOptions = {},
): Promise<string> {
  const { stdout } = await execFile('docker', ['compose', '-f', COMPOSE_FILE, ...args], {
    timeout: options.timeoutMs ?? SETUP_COMMAND_TIMEOUT_MS,
    maxBuffer: MAX_BUFFER_BYTES,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  return stdout;
}

/** The same with the terminal inherited, so an image pull on the first run shows its progress. */
export function composeInherit(args: readonly string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', ['compose', '-f', COMPOSE_FILE, ...args], { stdio: 'inherit' });
    child.once('error', reject);
    child.once('close', (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      const suffix = signal === null ? '' : ` after ${signal}`;
      reject(
        new Error(`docker compose ${args.join(' ')} ended with code ${String(code)}${suffix}`),
      );
    });
  });
}

type ComposePort = { target?: unknown; published?: unknown };
type ComposeService = { ports?: unknown; environment?: unknown };
type ComposeConfig = { services?: Record<string, ComposeService | undefined> };
type NamedService = { name: string; service: ComposeService };

/**
 * The published ports and the credentials from `docker compose config --format json` (decision 6):
 * `ports[].published` is a string there, `environment` the resolved map. A missing field is an
 * error that names the field; no message prints a map or a value.
 */
export function parseComposeConfig(json: string): TestStack {
  const config = JSON.parse(json) as ComposeConfig;
  const rabbitmq = serviceOf(config, 'rabbitmq');
  const mongodb = serviceOf(config, 'mongodb');
  return {
    host: '127.0.0.1',
    amqpPort: publishedPort(rabbitmq, 5672),
    managementPort: publishedPort(rabbitmq, 15672),
    mongoPort: publishedPort(mongodb, 27017),
    rabbitmq: {
      user: variable(rabbitmq, 'RABBITMQ_DEFAULT_USER'),
      password: variable(rabbitmq, 'RABBITMQ_DEFAULT_PASS'),
    },
    mongodb: {
      user: variable(mongodb, 'MONGO_INITDB_ROOT_USERNAME'),
      password: variable(mongodb, 'MONGO_INITDB_ROOT_PASSWORD'),
    },
  };
}

function serviceOf(config: ComposeConfig, name: string): NamedService {
  const service = config.services?.[name];
  if (service === undefined) {
    throw new Error(`docker compose config: service ${name} is missing`);
  }
  return { name, service };
}

function publishedPort({ name, service }: NamedService, target: number): number {
  const ports = Array.isArray(service.ports) ? (service.ports as ComposePort[]) : [];
  const mapping = ports.find((port) => port.target === target);
  const published = Number(mapping?.published);
  if (!Number.isInteger(published) || published <= 0) {
    throw new Error(
      `docker compose config: service ${name} publishes no host port for ${String(target)}`,
    );
  }
  return published;
}

function variable({ name, service }: NamedService, key: string): string {
  const environment = service.environment;
  const value =
    typeof environment === 'object' && environment !== null
      ? (environment as Record<string, unknown>)[key]
      : undefined;
  if (typeof value !== 'string' || value === '') {
    throw new Error(`docker compose config: service ${name} has no ${key}`);
  }
  return value;
}
```

- [ ] Create `test/harness/global-setup.ts`:

```ts
import type { TestProject } from 'vitest/node';

import { SERVICES, compose, composeInherit, parseComposeConfig, type TestStack } from './stack.js';

declare module 'vitest' {
  export interface ProvidedContext {
    stack: TestStack;
  }
}

/**
 * Starts the test stack before the first integration file and removes it after the last one
 * (integration spec, decision 5). Vitest calls this only when at least one integration test is
 * queued, so `pnpm test:unit` and the per-package scoped verify never touch Docker.
 *
 * Ownership rule: this run removes the stack only when it found it not already fully running
 * (none, or one service left behind by a crashed run). A developer who started the stack by hand
 * keeps it; a partial leftover counts as owned and goes away with what this run added.
 */
export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const running = (await compose(['ps', '--services', '--status', 'running'])).trim();
  const owned = running.split('\n').filter(Boolean).length < SERVICES.length;
  const teardown = async (): Promise<void> => {
    if (owned) {
      await composeInherit(['down', '-v']);
    }
  };
  try {
    await composeInherit(['up', '-d', '--wait', '--wait-timeout', '120']);
    project.provide('stack', parseComposeConfig(await compose(['config', '--format', 'json'])));
  } catch (error) {
    // A stack this run started must not outlive a failure of the steps after the `up`; the
    // original error is the one reported.
    await teardown().catch(() => undefined);
    throw error;
  }
  return teardown;
}
```

- [ ] `pnpm typecheck` exits 0 (both `tsc -b` projects; the leaf emits nothing: `git status --short` shows no file under `test/` besides the three new ones). `pnpm exec tsc -p test/tsconfig.json --listFilesOnly | grep -c 'test/harness/'` → 2 (the two harness files are in the program).
- [ ] `pnpm lint` exits 0, and `pnpm exec eslint --print-config test/harness/stack.ts | grep -c '"@typescript-eslint/no-floating-promises"'` → 1 (the type-aware rules apply under `test/`).
- [ ] `pnpm test:unit` → 880 tests in 42 files (unchanged). `pnpm test` → the same 880 (the `integration` project matches no file yet, so its global setup does not run): `docker compose -f docker-compose.test.yml ps -aq | wc -l` → 0 right after. `pnpm test:integration` still exits 1 with `No test files found` (as today, spec decision 15), and again no container exists.
- [ ] `pnpm exec prettier --check vitest.config.ts package.json test/tsconfig.json test/harness/stack.ts test/harness/global-setup.ts`.
- [ ] Commit `package.json`, `pnpm-lock.yaml`, `vitest.config.ts`, `test/tsconfig.json`, `test/harness/stack.ts`, `test/harness/global-setup.ts` — subject: `Wire the integration project and its global setup`.

### Task 4: Harness core — the load generator, the management client, the waits, the per-test environment [mechanical]

**Files:** Create `test/harness/load.ts`, `test/harness/load.test.ts`, `test/harness/management.ts`, `test/harness/wait.ts`, `test/harness/environment.ts`
**Invariant:** none touched (test infrastructure). The generator's expectation is the oracle later tasks use for invariants 1, 2 and 4; its own unit test is what makes that oracle trustworthy (A2).
**Verify:** `pnpm vitest run --project unit test/harness/load.test.ts` (9 tests), then `pnpm typecheck && pnpm lint && pnpm test:unit` (889 tests) and `pnpm exec prettier --check test/harness`.

The generator comes first, test first, because it has no dependency on the stack. The other three modules have no unit test of their own: they are proven by the integration files of Tasks 6–10, which cannot pass with a wrong vhost, a wrong wait or a wrong recovery.

- [ ] Create `test/harness/load.test.ts` (fails until `load.ts` exists):

```ts
import { messageIdentity, type TelemetryMessage } from '@telemetry/shared';
import { describe, expect, it } from 'vitest';

import {
  LOAD_SESSION_ID,
  expectationOf,
  generateLoad,
  loadDeviceId,
  mergeExpected,
} from './load.js';

const OPTIONS = {
  devices: 20,
  messages: 1000,
  hotShare: 0.25,
  duplicatePercent: 5,
  swapPercent: 5,
  seed: 1,
};
const SMALL = { ...OPTIONS, devices: 10, messages: 100, hotShare: 0 };
const TYPES = ['status', 'metrics', 'counters', 'diagnostic'] as const;

/** The distinct messages of one device, in send order. */
function streamOf(sends: readonly TelemetryMessage[], deviceId: string): TelemetryMessage[] {
  const seen = new Set<string>();
  const stream: TelemetryMessage[] = [];
  for (const message of sends) {
    const identity = messageIdentity(message);
    if (message.deviceId === deviceId && !seen.has(identity)) {
      seen.add(identity);
      stream.push(message);
    }
  }
  return stream;
}

describe('generateLoad', () => {
  it('is deterministic for a seed and differs for another', () => {
    expect(generateLoad(OPTIONS).sends).toEqual(generateLoad(OPTIONS).sends);
    expect(generateLoad({ ...OPTIONS, seed: 2 }).sends).not.toEqual(generateLoad(OPTIONS).sends);
  });

  it('sends every message once plus the injected duplicates, each right after its original', () => {
    const { sends, expected } = generateLoad(OPTIONS);
    expect(expected.identities.size).toBe(1000);
    expect(sends).toHaveLength(1000 + expected.duplicates);
    expect(expected.duplicates).toBeGreaterThan(0);
    const seen = new Set<string>();
    let adjacent = 0;
    sends.forEach((message, index) => {
      const identity = messageIdentity(message);
      if (seen.has(identity)) {
        adjacent += 1;
        expect(sends[index - 1]).toBe(message);
      }
      seen.add(identity);
    });
    expect(adjacent).toBe(expected.duplicates);
  });

  it('gives the hot device its share and spreads the rest evenly', () => {
    const { sends } = generateLoad(OPTIONS);
    expect(streamOf(sends, loadDeviceId('load', 1))).toHaveLength(250);
    const others = Array.from(
      { length: 19 },
      (_, index) => streamOf(sends, loadDeviceId('load', index + 2)).length,
    );
    expect(others.reduce((sum, count) => sum + count, 0)).toBe(750);
    expect(Math.max(...others) - Math.min(...others)).toBeLessThanOrEqual(1);
    const even = generateLoad(SMALL);
    for (let device = 1; device <= 10; device += 1) {
      expect(streamOf(even.sends, loadDeviceId('load', device))).toHaveLength(10);
    }
  });

  it('keeps every stream in order apart from adjacent swaps, and in exact order without swaps', () => {
    const { sends } = generateLoad(OPTIONS);
    let swapped = 0;
    for (let device = 1; device <= 20; device += 1) {
      const seqs = streamOf(sends, loadDeviceId('load', device)).map((message) => message.seq);
      const inOrder = seqs.map((_, index) => index + 1);
      expect([...seqs].sort((a, b) => a - b)).toEqual(inOrder);
      seqs.forEach((seq, index) => {
        expect(Math.abs(seq - (index + 1))).toBeLessThanOrEqual(1);
        if (seq !== index + 1) {
          swapped += 1;
        }
      });
    }
    expect(swapped).toBeGreaterThan(0);
    const ordered = generateLoad({ ...OPTIONS, swapPercent: 0, duplicatePercent: 0 });
    expect(ordered.expected.duplicates).toBe(0);
    expect(ordered.sends).toHaveLength(1000);
    for (let device = 1; device <= 20; device += 1) {
      const seqs = streamOf(ordered.sends, loadDeviceId('load', device)).map((m) => m.seq);
      expect(seqs).toEqual(seqs.map((_, index) => index + 1));
    }
  });

  it('rotates the four types and makes every tenth message an error diagnostic', () => {
    const { sends, expected } = generateLoad({ ...SMALL, swapPercent: 0, duplicatePercent: 0 });
    for (const message of sends) {
      if (message.seq % 10 === 0) {
        expect(message.type).toBe('diagnostic');
        expect(message.type === 'diagnostic' && message.payload.severity).toBe('error');
      } else {
        expect(message.type).toBe(TYPES[(message.seq - 1) % TYPES.length]);
      }
    }
    expect(expected.alerts.size).toBe(10);
    const errors = sends.filter((m) => m.seq % 10 === 0).map((m) => messageIdentity(m));
    expect(expected.alerts).toEqual(new Set(errors));
  });

  it('expects the highest key per section and per device', () => {
    const { sends, expected } = generateLoad(OPTIONS);
    for (let device = 1; device <= 20; device += 1) {
      const deviceId = loadDeviceId('load', device);
      const stream = streamOf(sends, deviceId);
      const sections = expected.sections.get(deviceId);
      expect(sections).toBeDefined();
      for (const type of TYPES) {
        const highest = Math.max(...stream.filter((m) => m.type === type).map((m) => m.seq));
        expect(sections?.get(type)).toEqual({ sessionId: LOAD_SESSION_ID, seq: highest });
      }
      expect(expected.lastEvent.get(deviceId)).toEqual({
        sessionId: LOAD_SESSION_ID,
        seq: stream.length,
      });
    }
  });

  it('computes the expectation from the sends alone', () => {
    const { sends, expected } = generateLoad(OPTIONS);
    expect(expectationOf(sends)).toEqual(expected);
    // A message dropped on the way changes the oracle: a comparison against stored data could not see it.
    expect(expectationOf(sends.slice(1)).identities.size).toBe(999);
  });

  it('namespaces devices by prefix, not by seed', () => {
    const a = generateLoad({ ...SMALL, seed: 3, deviceIdPrefix: 'c10a' });
    const b = generateLoad({ ...SMALL, seed: 4, deviceIdPrefix: 'c10b' });
    const sameIds = generateLoad({ ...SMALL, seed: 4, deviceIdPrefix: 'c10a' });
    expect([...a.expected.sections.keys()].every((id) => id.startsWith('c10a-'))).toBe(true);
    expect([...a.expected.identities].some((id) => b.expected.identities.has(id))).toBe(false);
    // The same ids; the map's insertion order follows the interleave, which the seed changes.
    expect(new Set(sameIds.expected.sections.keys())).toEqual(new Set(a.expected.sections.keys()));
  });

  it('merges disjoint expectations and rejects a shared device', () => {
    const a = generateLoad({ ...SMALL, seed: 3, deviceIdPrefix: 'c10a' });
    const b = generateLoad({ ...SMALL, seed: 4, deviceIdPrefix: 'c10b' });
    const merged = mergeExpected(a.expected, b.expected);
    expect(merged.identities.size).toBe(200);
    expect(merged.alerts.size).toBe(20);
    expect(merged.sections.size).toBe(20);
    expect(merged.lastEvent.size).toBe(20);
    expect(merged.duplicates).toBe(a.expected.duplicates + b.expected.duplicates);
    expect(() => mergeExpected(a.expected, a.expected)).toThrow(
      /^mergeExpected: device c10a-\d{4} is in both expectations$/,
    );
  });
});
```

- [ ] `pnpm vitest run --project unit test/harness/load.test.ts` fails: the module `./load.js` does not exist.
- [ ] Create `test/harness/load.ts`:

```ts
import {
  assertNever,
  isNewer,
  messageIdentity,
  type OrderKey,
  type TelemetryEventType,
  type TelemetryMessage,
} from '@telemetry/shared';

import { createRandom, type Random } from '../../apps/emulator/src/random.js';

/**
 * The seeded load generator of the load-shaped tests (integration spec, decision 17): the ordered
 * list of messages to send, duplicates and swaps included, together with the expectation computed
 * from that list alone. An expectation derived from what was stored could not see a message that
 * was dropped on the way; this one can.
 */
export type LoadOptions = {
  devices: number;
  messages: number;
  /** Share of all messages that go to the first device, the hot one; 0 spreads evenly. */
  hotShare: number;
  /** Percentage of sends that appear twice in a row. */
  duplicatePercent: number;
  /** Percentage of adjacent pairs of one device's stream that are swapped. */
  swapPercent: number;
  seed: number;
  /** Device ids are `${deviceIdPrefix}-NNNN` by index, independent of the seed; default `load`. */
  deviceIdPrefix?: string;
};

export type Expected = {
  /** Every distinct message identity string. */
  identities: Set<string>;
  /** Per device, per section, the highest `(sessionId, seq)` sent. */
  sections: Map<string, Map<TelemetryEventType, OrderKey>>;
  /** Per device, the highest key of any type. */
  lastEvent: Map<string, OrderKey>;
  /** How many sends are a second copy of an earlier one. */
  duplicates: number;
  /** The identity strings of the error diagnostics: the alerts. */
  alerts: Set<string>;
};

export type Load = { sends: TelemetryMessage[]; expected: Expected };

/** One session per device, inside the contract's window. */
export const LOAD_SESSION_ID = 1_700_000_000_000;
const TYPES = ['status', 'metrics', 'counters', 'diagnostic'] as const;
/** Every tenth message of a device is an error diagnostic, so the alerts are a known set. */
const ERROR_EVERY = 10;
const DEVICE_INDEX_PAD = 4;

/** `${prefix}-0001`: the emulator's id shape (`apps/emulator/src/config.ts`, `formatDeviceId`). */
export function loadDeviceId(prefix: string, index: number): string {
  return `${prefix}-${String(index).padStart(DEVICE_INDEX_PAD, '0')}`;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function buildMessage({
  deviceId,
  seq,
  random,
}: {
  deviceId: string;
  seq: number;
  random: Random;
}): TelemetryMessage {
  const base = {
    v: 1 as const,
    deviceId,
    sessionId: LOAD_SESSION_ID,
    seq,
    occurredAt: LOAD_SESSION_ID + seq * 1000,
  };
  if (seq % ERROR_EVERY === 0) {
    return {
      ...base,
      type: 'diagnostic',
      payload: {
        severity: 'error',
        code: 'E_OVERHEAT',
        message: `temperature above threshold at seq ${String(seq)}`,
      },
    };
  }
  const type = TYPES[(seq - 1) % TYPES.length] ?? 'status';
  switch (type) {
    case 'status':
      return { ...base, type, payload: { state: random.bool(0.1) ? 'degraded' : 'online' } };
    case 'metrics':
      return {
        ...base,
        type,
        payload: {
          temperatureC: round2(random.range(30, 60)),
          cpuPercent: round2(random.range(0, 100)),
          ramPercent: round2(random.range(0, 100)),
        },
      };
    case 'counters':
      // Cumulative per session (consistency spec, decision 6): monotonic in `seq`.
      return { ...base, type, payload: { operationsTotal: seq * 10, uptimeMs: seq * 1000 } };
    case 'diagnostic':
      return {
        ...base,
        type,
        payload: { severity: 'info', code: 'E_NET_RETRY', message: 'retrying' },
      };
    default:
      return assertNever(type, 'event type');
  }
}

/** The hot device takes `hotShare` of the messages; the rest is spread evenly, remainder first. */
function distribute({
  devices,
  messages,
  hotShare,
}: Pick<LoadOptions, 'devices' | 'messages' | 'hotShare'>): number[] {
  if (
    !Number.isInteger(devices) ||
    devices < 1 ||
    !Number.isInteger(messages) ||
    messages < devices
  ) {
    throw new Error('generateLoad: needs at least one device and one message per device');
  }
  const counts = new Array<number>(devices).fill(0);
  const hot =
    hotShare > 0 && devices > 1
      ? Math.min(Math.round(messages * hotShare), messages - (devices - 1))
      : 0;
  const first = hot > 0 ? 1 : 0;
  if (hot > 0) {
    counts[0] = hot;
  }
  const rest = messages - hot;
  const others = devices - first;
  for (let index = first; index < devices; index += 1) {
    counts[index] = Math.floor(rest / others) + (index - first < rest % others ? 1 : 0);
  }
  return counts;
}

/** One device's stream in `seq` order, with a share of adjacent pairs swapped; pairs never overlap. */
function deviceStream({
  deviceId,
  count,
  swapPercent,
  random,
}: {
  deviceId: string;
  count: number;
  swapPercent: number;
  random: Random;
}): TelemetryMessage[] {
  const stream = Array.from({ length: count }, (_, index) =>
    buildMessage({ deviceId, seq: index + 1, random }),
  );
  for (let index = 0; index + 1 < stream.length; index += 1) {
    if (random.bool(swapPercent / 100)) {
      const earlier = stream[index];
      const later = stream[index + 1];
      if (earlier !== undefined && later !== undefined) {
        stream[index] = later;
        stream[index + 1] = earlier;
      }
      index += 1;
    }
  }
  return stream;
}

/** A draw weighted by what each device still has to send, so the hot device stays hot throughout. */
function interleave(
  streams: readonly (readonly TelemetryMessage[])[],
  random: Random,
): TelemetryMessage[] {
  const cursors = streams.map(() => 0);
  const out: TelemetryMessage[] = [];
  let remaining = streams.reduce((sum, stream) => sum + stream.length, 0);
  while (remaining > 0) {
    let pick = random.int(1, remaining);
    for (let device = 0; device < streams.length; device += 1) {
      const stream = streams[device] ?? [];
      const cursor = cursors[device] ?? 0;
      const left = stream.length - cursor;
      if (pick <= left) {
        const message = stream[cursor];
        if (message !== undefined) {
          out.push(message);
        }
        cursors[device] = cursor + 1;
        break;
      }
      pick -= left;
    }
    remaining -= 1;
  }
  return out;
}

function withDuplicates(
  ordered: readonly TelemetryMessage[],
  { duplicatePercent, random }: { duplicatePercent: number; random: Random },
): { sends: TelemetryMessage[]; duplicates: number } {
  const sends: TelemetryMessage[] = [];
  let duplicates = 0;
  for (const message of ordered) {
    sends.push(message);
    if (random.bool(duplicatePercent / 100)) {
      sends.push(message);
      duplicates += 1;
    }
  }
  return { sends, duplicates };
}

/** The expectation computed from the sends alone: what the pipeline must end with. */
export function expectationOf(sends: readonly TelemetryMessage[]): Expected {
  const identities = new Set<string>();
  const sections = new Map<string, Map<TelemetryEventType, OrderKey>>();
  const lastEvent = new Map<string, OrderKey>();
  const alerts = new Set<string>();
  let duplicates = 0;
  for (const message of sends) {
    const identity = messageIdentity(message);
    if (identities.has(identity)) {
      duplicates += 1;
      continue;
    }
    identities.add(identity);
    const key: OrderKey = { sessionId: message.sessionId, seq: message.seq };
    const device = sections.get(message.deviceId) ?? new Map<TelemetryEventType, OrderKey>();
    const section = device.get(message.type);
    if (section === undefined || isNewer(key, section)) {
      device.set(message.type, key);
    }
    sections.set(message.deviceId, device);
    const last = lastEvent.get(message.deviceId);
    if (last === undefined || isNewer(key, last)) {
      lastEvent.set(message.deviceId, key);
    }
    if (message.type === 'diagnostic' && message.payload.severity === 'error') {
      alerts.add(identity);
    }
  }
  return { identities, sections, lastEvent, duplicates, alerts };
}

export function generateLoad({
  devices,
  messages,
  hotShare,
  duplicatePercent,
  swapPercent,
  seed,
  deviceIdPrefix = 'load',
}: LoadOptions): Load {
  const random = createRandom(seed);
  const streams = distribute({ devices, messages, hotShare }).map((count, index) =>
    deviceStream({ deviceId: loadDeviceId(deviceIdPrefix, index + 1), count, swapPercent, random }),
  );
  const { sends, duplicates } = withDuplicates(interleave(streams, random), {
    duplicatePercent,
    random,
  });
  const expected = expectationOf(sends);
  if (expected.duplicates !== duplicates || expected.identities.size !== messages) {
    throw new Error('generateLoad: the expectation does not match the sends');
  }
  return { sends, expected };
}

/** Two expectations of disjoint device populations as one; a shared device is a programmer error. */
export function mergeExpected(a: Expected, b: Expected): Expected {
  for (const deviceId of b.sections.keys()) {
    if (a.sections.has(deviceId)) {
      throw new Error(`mergeExpected: device ${deviceId} is in both expectations`);
    }
  }
  return {
    identities: new Set([...a.identities, ...b.identities]),
    sections: new Map([...a.sections, ...b.sections]),
    lastEvent: new Map([...a.lastEvent, ...b.lastEvent]),
    duplicates: a.duplicates + b.duplicates,
    alerts: new Set([...a.alerts, ...b.alerts]),
  };
}
```

- [ ] `pnpm vitest run --project unit test/harness/load.test.ts` → 9 passed.
- [ ] Create `test/harness/management.ts`:

```ts
/**
 * The RabbitMQ management HTTP API, for what AMQP cannot do (integration spec, decisions 7 and 12
 * and the harness section): virtual hosts, permissions, `get` from a queue, a queue delete, the
 * alarm check, and the queue object of the existence check. Credentials travel in a `Basic` header,
 * never in the URL: `fetch` rejects a URL with userinfo and echoes it in the error. No queue metric
 * read here is ever a wait target (decision 13): the statistics lag by up to 5 s.
 */
const REQUEST_TIMEOUT_MS = 10_000;

export type QueueInfo =
  { status: 404 } | { status: 200; messages: number | undefined; consumers: number | undefined };

/** One message of `POST /api/queues/{vhost}/{name}/get` with `encoding: 'auto'`. */
export type QueueMessage = {
  payload: string;
  payload_encoding: string;
  redelivered: boolean;
  properties: {
    message_id?: string;
    content_type?: string;
    delivery_mode?: number;
    timestamp?: number;
    headers?: Record<string, unknown>;
  };
};

/** The client scoped to one virtual host: what a test environment holds. */
export type ManagementApi = {
  /** The queue object, or 404 before the queue is declared; its metrics may be absent or stale. */
  queue(name: string): Promise<QueueInfo>;
  deleteQueue(name: string): Promise<void>;
  /** `ack_requeue_false`: the messages leave the queue. `count` is an upper bound the test derives from what it sent. */
  getMessages(name: string, count: number): Promise<QueueMessage[]>;
  /** 200 without an alarm in effect, 503 with one. */
  alarms(): Promise<number>;
};

export type ManagementClient = {
  createVhost(name: string): Promise<void>;
  deleteVhost(name: string): Promise<void>;
  grantAll(vhost: string, user: string): Promise<void>;
  vhost(name: string): ManagementApi;
};

type Call = {
  method: 'GET' | 'PUT' | 'POST' | 'DELETE';
  path: string;
  body?: unknown;
  ok: readonly number[];
};

type Reply = { status: number; body: unknown };

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined;
}

export function createManagementClient({
  host,
  port,
  user,
  password,
}: {
  host: string;
  port: number;
  user: string;
  password: string;
}): ManagementClient {
  const base = `http://${host}:${String(port)}/api`;
  const authorization = `Basic ${Buffer.from(`${user}:${password}`, 'utf8').toString('base64')}`;
  const encode = encodeURIComponent;

  const call = async ({ method, path, body, ok }: Call): Promise<Reply> => {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: { authorization, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    // The body is always read, so the connection returns to the pool; it never goes into an error.
    const text = await response.text();
    if (!ok.includes(response.status)) {
      throw new Error(`management API ${method} ${path}: HTTP ${String(response.status)}`);
    }
    return {
      status: response.status,
      body: text === '' ? undefined : (JSON.parse(text) as unknown),
    };
  };

  const vhost = (name: string): ManagementApi => {
    const queues = `/queues/${encode(name)}`;
    return {
      queue: async (queue) => {
        const reply = await call({
          method: 'GET',
          path: `${queues}/${encode(queue)}`,
          ok: [200, 404],
        });
        if (reply.status === 404) {
          return { status: 404 };
        }
        const object = reply.body as { messages?: unknown; consumers?: unknown };
        return {
          status: 200,
          messages: numberOrUndefined(object.messages),
          consumers: numberOrUndefined(object.consumers),
        };
      },
      deleteQueue: async (queue) => {
        await call({ method: 'DELETE', path: `${queues}/${encode(queue)}`, ok: [204] });
      },
      getMessages: async (queue, count) => {
        const reply = await call({
          method: 'POST',
          path: `${queues}/${encode(queue)}/get`,
          body: { count, ackmode: 'ack_requeue_false', encoding: 'auto' },
          ok: [200],
        });
        return reply.body as QueueMessage[];
      },
      alarms: async () =>
        (await call({ method: 'GET', path: '/health/checks/alarms', ok: [200, 503] })).status,
    };
  };

  return {
    createVhost: async (name) => {
      await call({
        method: 'PUT',
        path: `/vhosts/${encode(name)}`,
        body: { description: 'integration test' },
        ok: [201, 204],
      });
    },
    deleteVhost: async (name) => {
      await call({ method: 'DELETE', path: `/vhosts/${encode(name)}`, ok: [204] });
    },
    grantAll: async (name, grantee) => {
      await call({
        method: 'PUT',
        path: `/permissions/${encode(name)}/${encode(grantee)}`,
        body: { configure: '.*', write: '.*', read: '.*' },
        ok: [201, 204],
      });
    },
    vhost,
  };
}
```

- [ ] Create `test/harness/wait.ts`:

```ts
import { setTimeout as sleep } from 'node:timers/promises';

import {
  ALERTS_COLLECTION,
  DEVICE_STATE_COLLECTION,
  EVENTS_COLLECTION,
  messageIdentity,
  type AlertDocument,
  type DeviceStateDocument,
  type EventDocument,
} from '@telemetry/shared';
import type { Db } from 'mongodb';

import type { Expected } from './load.js';

export type WaitOptions = {
  /** Default 20 s; the test's `testTimeout` is the outer bound. */
  timeoutMs?: number;
  /** Default 50 ms. */
  intervalMs?: number;
  /** The failure text: counts and state names, never a URL. */
  describe?: () => string;
};

export type BoundWaitOptions = WaitOptions & { signal: AbortSignal };

export type Truthy<T> = Exclude<T, false | 0 | '' | null | undefined>;

const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_INTERVAL_MS = 50;
const LOG_WAIT_TIMEOUT_MS = 20_000;

/**
 * Polls `predicate` until it resolves truthy and returns that value (integration spec, decision
 * 13: every wait is bounded, and the bound is the test's own). Rejects with `describe()`'s text
 * after `timeoutMs`, and at once when `signal` aborts, so a test that timed out stops polling. A
 * predicate that throws propagates: a reader that fails is a failure, not "not yet".
 */
export async function waitFor<T>(
  predicate: () => T | Promise<T>,
  {
    signal,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    intervalMs = DEFAULT_INTERVAL_MS,
    describe = () => 'condition not met',
  }: BoundWaitOptions,
): Promise<Truthy<T>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (signal.aborted) {
      throw new Error(`wait aborted: ${describe()}`);
    }
    const value = await predicate();
    if (value) {
      return value as Truthy<T>;
    }
    if (Date.now() >= deadline) {
      throw new Error(`wait timed out after ${String(timeoutMs)} ms: ${describe()}`);
    }
    try {
      await sleep(intervalMs, undefined, { signal });
    } catch {
      throw new Error(`wait aborted: ${describe()}`);
    }
  }
}

export type AckCounter = { stats(): { acked: number; inFlight: number } };

/** The completion signal of decision 13: every delivery the test made is acknowledged and no handler runs. */
export function awaitAcked(
  instance: AckCounter,
  options: BoundWaitOptions & { count: number },
): Promise<void> {
  const { count, ...wait } = options;
  return waitFor(
    () => {
      const { acked, inFlight } = instance.stats();
      return acked === count && inFlight === 0;
    },
    {
      ...wait,
      describe: () => {
        const { acked, inFlight } = instance.stats();
        return `acked ${String(acked)} of ${String(count)}, inFlight ${String(inFlight)}`;
      },
    },
  ).then(() => undefined);
}

/**
 * What the database still lacks of `expected`: every identity as an event document, every section
 * at its key, every alert present; '' when it holds everything. A state that cannot regress, so it
 * is a sound completion signal where a redelivery could add deliveries the test did not make (C10).
 */
export async function missingFromEndState(db: Db, expected: Expected): Promise<string> {
  const events = await db
    .collection<EventDocument>(EVENTS_COLLECTION)
    .find({}, { projection: { deviceId: 1, sessionId: 1, seq: 1 } })
    .toArray();
  const stored = new Set(events.map((event) => messageIdentity(event)));
  let identities = 0;
  for (const identity of expected.identities) {
    if (!stored.has(identity)) {
      identities += 1;
    }
  }
  const states = await db
    .collection<DeviceStateDocument>(DEVICE_STATE_COLLECTION)
    .find({})
    .toArray();
  const byDevice = new Map(states.map((state) => [state._id, state]));
  let sections = 0;
  for (const [deviceId, keys] of expected.sections) {
    const state = byDevice.get(deviceId);
    for (const [type, key] of keys) {
      const section = state?.[type];
      if (section === undefined || section.sessionId !== key.sessionId || section.seq !== key.seq) {
        sections += 1;
      }
    }
  }
  const alertDocuments = await db
    .collection<AlertDocument>(ALERTS_COLLECTION)
    .find({}, { projection: { _id: 1 } })
    .toArray();
  const alertIds = new Set(alertDocuments.map((alert) => alert._id));
  let alerts = 0;
  for (const identity of expected.alerts) {
    if (!alertIds.has(identity)) {
      alerts += 1;
    }
  }
  if (identities === 0 && sections === 0 && alerts === 0) {
    return '';
  }
  return `${String(identities)} identities missing, ${String(sections)} sections not at their key, ${String(alerts)} alerts missing`;
}

export function awaitEndState({
  db,
  expected,
  signal,
  timeoutMs,
}: {
  db: Db;
  expected: Expected;
  signal: AbortSignal;
  timeoutMs?: number;
}): Promise<void> {
  let last = 'not read yet';
  return waitFor(
    async () => {
      last = await missingFromEndState(db, expected);
      return last === '';
    },
    {
      signal,
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
      describe: () => `end state incomplete: ${last}`,
    },
  ).then(() => undefined);
}

export type LogLine = { level: number; msg: string; [field: string]: unknown };
export type LineMatch = (line: LogLine) => boolean;

/** pino's numeric levels, as the captured lines carry them in `level`. */
export const WARN_LEVEL = 40;
export const ERROR_LEVEL = 50;

export const byMsg =
  (msg: string): LineMatch =>
  (line) =>
    line.msg === msg;

/**
 * The parsed JSON lines of one service (decision 19), fed by a pino destination or a child's
 * stdout. `waitForLine` resolves on the push that matches — no polling — and rejects at once when
 * the test's signal aborts, so no wait outlives its test.
 */
export class LogCapture {
  readonly #lines: LogLine[] = [];
  readonly #listeners = new Set<() => void>();
  readonly #signal: AbortSignal;
  #diagnostics = '';

  constructor(signal: AbortSignal) {
    this.#signal = signal;
  }

  /** A pino destination: every line the logger writes lands here, synchronously. */
  destination(): { write(line: string): void } {
    return {
      write: (line) => {
        this.pushText(line);
      },
    };
  }

  /** One raw line: JSON goes into `lines`, anything else into `diagnostics`. */
  pushText(raw: string): void {
    const text = raw.trim();
    if (text === '') {
      return;
    }
    try {
      this.push(JSON.parse(text) as LogLine);
    } catch {
      this.#diagnostics += `[not JSON] ${text}\n`;
    }
  }

  push(line: LogLine): void {
    this.#lines.push(line);
    for (const listener of [...this.#listeners]) {
      listener();
    }
  }

  lines(): LogLine[] {
    return [...this.#lines];
  }

  find(match: LineMatch): LogLine | undefined {
    return this.#lines.find(match);
  }

  filter(match: LineMatch): LogLine[] {
    return this.#lines.filter(match);
  }

  /** The `msg` of every line, in order: for order assertions and failure texts. */
  messages(): string[] {
    return this.#lines.map((line) => line.msg);
  }

  diagnostics(): string {
    return this.#diagnostics;
  }

  waitForLine(match: LineMatch, timeoutMs = LOG_WAIT_TIMEOUT_MS): Promise<LogLine> {
    return new Promise((resolve, reject) => {
      const found = this.#lines.find(match);
      if (found !== undefined) {
        resolve(found);
        return;
      }
      if (this.#signal.aborted) {
        reject(new Error(`log wait aborted; last lines: ${this.#tail()}`));
        return;
      }
      const finish = (): void => {
        this.#listeners.delete(check);
        clearTimeout(timer);
        this.#signal.removeEventListener('abort', onAbort);
      };
      const check = (): void => {
        const line = this.#lines.find(match);
        if (line !== undefined) {
          finish();
          resolve(line);
        }
      };
      const onAbort = (): void => {
        finish();
        reject(new Error(`log wait aborted; last lines: ${this.#tail()}`));
      };
      const timer = setTimeout(() => {
        finish();
        reject(
          new Error(
            `log line not seen within ${String(timeoutMs)} ms; last lines: ${this.#tail()}`,
          ),
        );
      }, timeoutMs);
      this.#listeners.add(check);
      this.#signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  #tail(): string {
    return this.#lines
      .slice(-8)
      .map((line) => line.msg)
      .join(' | ');
  }
}
```

- [ ] Create `test/harness/environment.ts`:

```ts
import { randomBytes } from 'node:crypto';

import { redactUserinfo, settleWithin } from '@telemetry/shared';
import { connect as amqpConnect, type ChannelModel } from 'amqplib';
import { MongoClient, type Db } from 'mongodb';
import { inject } from 'vitest';

import type { Expected } from './load.js';
import { createManagementClient, type ManagementApi, type ManagementClient } from './management.js';
import type { TestStack } from './stack.js';
import {
  awaitAcked,
  awaitEndState,
  waitFor,
  type AckCounter,
  type Truthy,
  type WaitOptions,
} from './wait.js';

export type RecoveryAction = (signal: AbortSignal) => Promise<void>;
/** Runs a registered recovery until it has succeeded once (see `TestEnvironment.undo`). */
export type Recover = () => Promise<void>;

/**
 * One test's virtual host and database (integration spec, decision 7), its undo stack, its
 * in-flight fault commands, and the waits bound to its signal (decisions 12 and 13). Created in
 * `beforeEach`, bound to the test's own signal by `bindEnvironment` as the first line of the test
 * body, disposed in `afterEach`.
 */
export type TestEnvironment = {
  /** `it-` and 8 hex characters: the virtual host and the database name. */
  readonly name: string;
  readonly amqpUrl: string;
  readonly mongoUrl: string;
  /** `mongoUrl` with a wrong password, for the wrong-credentials scenario (C12); never logged. */
  readonly wrongMongoUrl: string;
  readonly dbName: string;
  /** The harness's own client: reads for assertions, the deletions of C13 and C14. */
  readonly db: Db;
  /** The management API scoped to this virtual host. */
  readonly management: ManagementApi;
  /** The running test's own signal once `bind` ran; every in-body fault command and wait reads it. */
  readonly signal: AbortSignal;
  bind(signal: AbortSignal): void;
  /** The harness's own amqplib connection: opened on first use, opened again after its `close` event. */
  amqp(): Promise<ChannelModel>;
  /** Registers an in-flight fault command; `dispose()` awaits its settlement before it recovers. */
  track<T>(command: Promise<T>): Promise<T>;
  /**
   * Registers a recovery and returns `recover()`, which runs the action until it has succeeded
   * once: a call while an attempt runs joins it, a call after a success resolves at once, a call
   * after a failure or an abort starts a new attempt. `dispose()` runs every recovery that has not
   * succeeded yet, in reverse order of registration, under its own timeout.
   */
  undo(action: RecoveryAction, label?: string): Recover;
  waitFor<T>(predicate: () => T | Promise<T>, options?: WaitOptions): Promise<Truthy<T>>;
  awaitAcked(instance: AckCounter, count: number): Promise<void>;
  awaitEndState(expected: Expected, timeoutMs?: number): Promise<void>;
  dispose(): Promise<void>;
};

type Recovery = {
  action: RecoveryAction;
  label: string;
  attempt: Promise<void> | undefined;
  done: boolean;
};

/** Server selection of the harness's own client, and its connection close. */
const HARNESS_TIMEOUT_MS = 5_000;
/** How long `dispose()` waits for an in-flight fault command; an aborted command settles at once. */
const IN_FLIGHT_SETTLE_MS = 5_000;
/** One recovery's bound inside `dispose()`, under the 60 s hook budget. */
const RECOVERY_TIMEOUT_MS = 50_000;

function userinfo(user: string, password: string): string {
  return `${encodeURIComponent(user)}:${encodeURIComponent(password)}`;
}

function mongoUrlFor(stack: TestStack, password: string): string {
  return `mongodb://${userinfo(stack.mongodb.user, password)}@${stack.host}:${String(stack.mongoPort)}/?authSource=admin`;
}

function describeError(error: unknown): string {
  return redactUserinfo(error instanceof Error ? error.message : String(error));
}

class Environment implements TestEnvironment {
  readonly name: string;
  readonly amqpUrl: string;
  readonly mongoUrl: string;
  readonly wrongMongoUrl: string;
  readonly dbName: string;
  readonly db: Db;
  readonly management: ManagementApi;
  readonly #mongo: MongoClient;
  readonly #client: ManagementClient;
  /** Aborted first thing in `dispose()`: stray waits and in-flight commands of this test end there. */
  readonly #disposal = new AbortController();
  readonly #recoveries: Recovery[] = [];
  readonly #inFlight = new Set<Promise<unknown>>();
  #signal: AbortSignal;
  #model: Promise<ChannelModel> | undefined;

  constructor({
    name,
    stack,
    mongo,
    client,
  }: {
    name: string;
    stack: TestStack;
    mongo: MongoClient;
    client: ManagementClient;
  }) {
    this.name = name;
    this.dbName = name;
    this.amqpUrl = `amqp://${userinfo(stack.rabbitmq.user, stack.rabbitmq.password)}@${stack.host}:${String(stack.amqpPort)}/${encodeURIComponent(name)}`;
    this.mongoUrl = mongoUrlFor(stack, stack.mongodb.password);
    this.wrongMongoUrl = mongoUrlFor(stack, `${stack.mongodb.password}-wrong`);
    this.db = mongo.db(name);
    this.management = client.vhost(name);
    this.#mongo = mongo;
    this.#client = client;
    this.#signal = this.#disposal.signal;
  }

  get signal(): AbortSignal {
    return this.#signal;
  }

  bind(signal: AbortSignal): void {
    this.#signal = AbortSignal.any([this.#disposal.signal, signal]);
  }

  amqp(): Promise<ChannelModel> {
    if (this.#model === undefined) {
      const opening = amqpConnect(this.amqpUrl).then((model) => {
        model.on('error', () => {
          // The `close` that follows drops the connection; the listener keeps the error from throwing.
        });
        model.once('close', () => {
          if (this.#model === opening) {
            this.#model = undefined;
          }
        });
        return model;
      });
      opening.catch(() => {
        if (this.#model === opening) {
          this.#model = undefined;
        }
      });
      this.#model = opening;
    }
    return this.#model;
  }

  track<T>(command: Promise<T>): Promise<T> {
    this.#inFlight.add(command);
    command.finally(() => this.#inFlight.delete(command)).catch(() => undefined);
    return command;
  }

  undo(action: RecoveryAction, label = 'recovery'): Recover {
    const entry: Recovery = { action, label, attempt: undefined, done: false };
    this.#recoveries.push(entry);
    return () => this.#recover(entry, this.#signal);
  }

  waitFor<T>(predicate: () => T | Promise<T>, options: WaitOptions = {}): Promise<Truthy<T>> {
    return waitFor(predicate, { ...options, signal: this.#signal });
  }

  awaitAcked(instance: AckCounter, count: number): Promise<void> {
    return awaitAcked(instance, { count, signal: this.#signal });
  }

  awaitEndState(expected: Expected, timeoutMs?: number): Promise<void> {
    return awaitEndState({
      db: this.db,
      expected,
      signal: this.#signal,
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
    });
  }

  /**
   * Reverse-order recovery, then the harness's own connections, then the database and the virtual
   * host. Every step is bounded; a failure in one step is collected and the others still run; the
   * collected failures are thrown at the end with their step names.
   */
  async dispose(): Promise<void> {
    const failures: string[] = [];
    const step = async (label: string, run: () => Promise<unknown>): Promise<void> => {
      try {
        await run();
      } catch (error) {
        failures.push(`${label}: ${describeError(error)}`);
      }
    };
    // Whatever the test left running ends now: a stray wait rejects, an in-flight command is killed.
    this.#disposal.abort();
    await step('in-flight commands', () =>
      settleWithin(Promise.allSettled([...this.#inFlight]), IN_FLIGHT_SETTLE_MS),
    );
    for (const entry of [...this.#recoveries].reverse()) {
      await step(entry.label, async () => {
        // An attempt the test started under its own signal settles first; a failed or aborted one
        // is then run again under a fresh bound of its own.
        await entry.attempt?.catch(() => undefined);
        await this.#recover(entry, AbortSignal.timeout(RECOVERY_TIMEOUT_MS));
      });
    }
    await step('amqp close', () => this.#closeAmqp());
    await step('drop database', () => this.db.dropDatabase());
    await step('mongo close', () => this.#mongo.close());
    await step('delete vhost', () => this.#client.deleteVhost(this.name));
    if (failures.length > 0) {
      throw new Error(`dispose of ${this.name}: ${failures.join('; ')}`);
    }
  }

  #recover(entry: Recovery, signal: AbortSignal): Promise<void> {
    if (entry.done) {
      return Promise.resolve();
    }
    if (entry.attempt === undefined) {
      const attempt = entry
        .action(signal)
        .then(() => {
          entry.done = true;
        })
        .finally(() => {
          if (entry.attempt === attempt) {
            entry.attempt = undefined;
          }
        });
      entry.attempt = attempt;
    }
    return entry.attempt;
  }

  async #closeAmqp(): Promise<void> {
    const opening = this.#model;
    this.#model = undefined;
    if (opening === undefined) {
      return;
    }
    const model = await opening.catch(() => undefined);
    if (model === undefined) {
      return;
    }
    // A `close()` after the broker closed the connection rejects (measured after a restart); the
    // connection is gone either way, so the outcome is not checked.
    await settleWithin(model.close(), HARNESS_TIMEOUT_MS);
  }
}

/**
 * The virtual host, its permissions and the harness's database client, in that order; a failure
 * after the vhost was created deletes it before the error propagates, so a failed `beforeEach`
 * leaves nothing behind.
 */
export async function createEnvironment(): Promise<TestEnvironment> {
  const stack = inject('stack');
  const name = `it-${randomBytes(4).toString('hex')}`;
  const client = createManagementClient({
    host: stack.host,
    port: stack.managementPort,
    user: stack.rabbitmq.user,
    password: stack.rabbitmq.password,
  });
  await client.createVhost(name);
  let mongo: MongoClient | undefined;
  try {
    await client.grantAll(name, stack.rabbitmq.user);
    mongo = new MongoClient(mongoUrlFor(stack, stack.mongodb.password), {
      serverSelectionTimeoutMS: HARNESS_TIMEOUT_MS,
    });
    await mongo.connect();
    return new Environment({ name, stack, mongo, client });
  } catch (error) {
    await mongo?.close().catch(() => undefined);
    await client.deleteVhost(name).catch(() => undefined);
    throw error;
  }
}

/**
 * The first line of every test body: `const env = environment(signal)` where the test file defines
 * `environment` over its own `env` variable. Fails with a clear message when `beforeEach` did not
 * complete, and binds the test's own signal to the environment.
 */
export function bindEnvironment(
  env: TestEnvironment | undefined,
  signal: AbortSignal,
): TestEnvironment {
  if (env === undefined) {
    throw new Error('no test environment: beforeEach did not complete');
  }
  env.bind(signal);
  return env;
}
```

- [ ] `pnpm typecheck && pnpm lint` exit 0 (the `ProvidedContext` augmentation of `global-setup.ts` types `inject('stack')`; `AbortSignal.any` and `Promise.withResolvers` are in the `es2024` lib and Node 24).
- [ ] `pnpm test:unit` → 889 tests in 43 files (880 + the 9 of `load.test.ts`).
- [ ] `pnpm exec prettier --check test/harness`.
- [ ] Commit the five files — subject: `Add the integration harness core`.

### Task 5: Harness services and clients [mechanical]

**Files:** Create `test/harness/services.ts`, `test/harness/clients.ts`
**Invariant:** none touched (test infrastructure). `startIngest` and `startProcessing` compose the services exactly as their entry points do, so what the tests exercise is the shipped composition, not a test double.
**Verify:** `pnpm typecheck && pnpm lint && pnpm exec prettier --check test/harness`. The first live proof is Task 6.

- [ ] Create `test/harness/services.ts`:

```ts
import { spawn } from 'node:child_process';
import net from 'node:net';
import { fileURLToPath } from 'node:url';

import { createLogger, startHealthServer, type Logger } from '@telemetry/shared';

import { loadIngestConfig, type IngestConfig } from '../../apps/ingest/src/config.js';
import { readinessReport as ingestReadiness } from '../../apps/ingest/src/health.js';
import { AmqpPublisher, type PublisherStats } from '../../apps/ingest/src/publisher.js';
import { IngestServer, type ServerStats } from '../../apps/ingest/src/server.js';
import { loadProcessingConfig } from '../../apps/processing/src/config.js';
import { AmqpConsumer, type ConsumerStats } from '../../apps/processing/src/consumer.js';
import { readinessReport as processingReadiness } from '../../apps/processing/src/health.js';
import { MongoStore, type StorePort, type StoreWatcher } from '../../apps/processing/src/store.js';
import type { TestEnvironment } from './environment.js';
import { LogCapture, type LogLine } from './wait.js';

/** What `GET /readyz` answered: the status and the JSON body. */
export type Readiness = { status: number; body: { status: string; reason?: string } };

const READINESS_TIMEOUT_MS = 5_000;

async function readiness(port: number): Promise<Readiness> {
  const response = await fetch(`http://127.0.0.1:${String(port)}/readyz`, {
    signal: AbortSignal.timeout(READINESS_TIMEOUT_MS),
  });
  return { status: response.status, body: (await response.json()) as Readiness['body'] };
}

export type IngestInstance = {
  /** The device WebSocket port the kernel chose. */
  port: number;
  healthPort: number;
  publisher: AmqpPublisher;
  server: IngestServer;
  logs: LogCapture;
  /** The server's and the publisher's counters together, as the summary line spreads them. */
  stats(): ServerStats & PublisherStats;
  readiness(): Promise<Readiness>;
  /** `server.shutdown()` → `publisher.stop()` → health close, once; `dispose()` calls it too. */
  stop(): Promise<void>;
};

/**
 * One ingest instance in this process, composed as `apps/ingest/src/main.ts` composes it, minus the
 * process wiring (integration spec, decision 11). Resolves once the device server listens, not once
 * the publisher is ready: a scenario that needs the broker connection waits for `publisher.isReady`.
 */
export async function startIngest(
  env: TestEnvironment,
  overrides: Record<string, string> = {},
): Promise<IngestInstance> {
  const config: IngestConfig = {
    ...loadIngestConfig({ RABBITMQ_URL: env.amqpUrl, ...overrides }),
    INGEST_HOST: '127.0.0.1',
    // The kernel picks a free port. The schema's minimum of 1 guards the environment, not a test.
    INGEST_PORT: 0,
  };
  const logs = new LogCapture(env.signal);
  const logger: Logger = createLogger({
    service: 'ingest',
    level: 'debug',
    destination: logs.destination(),
  });
  const publisher = new AmqpPublisher({
    url: config.RABBITMQ_URL,
    heartbeatSeconds: config.AMQP_HEARTBEAT_S,
    logger,
  });
  const server = new IngestServer({ config, publisher, logger });
  let shuttingDown = false;
  const health = await startHealthServer({
    port: 0,
    report: () => ingestReadiness({ publisherState: publisher.state, shuttingDown }),
    logger,
  });
  // Registered before anything connects, so a failed `listen` still stops what started.
  const stop = env.undo(async () => {
    shuttingDown = true;
    await server.shutdown();
    await publisher.stop();
    await health.close();
  }, 'ingest stop');
  publisher.start();
  const { port } = await server.listen();
  return {
    port,
    healthPort: health.port,
    publisher,
    server,
    logs,
    stats: () => ({ ...server.stats(), ...publisher.stats() }),
    readiness: () => readiness(health.port),
    stop,
  };
}

export type ProcessingInstance = {
  healthPort: number;
  consumer: AmqpConsumer;
  store: MongoStore;
  logs: LogCapture;
  stats(): ConsumerStats;
  readiness(): Promise<Readiness>;
  /** Abort the startup → `consumer.stop()` → `store.close()` → health close, once; `dispose()` calls it too. */
  stop(): Promise<void>;
};

export type StartProcessingOptions = {
  overrides?: Record<string, string>;
  /** Names the AMQP connection (`processing@<hostname>`); two instances in one test get `a` and `b`. */
  hostname?: string;
  /** Wraps the store the consumer sees; the real `MongoStore` still starts and closes (C11b). */
  wrapStore?: (store: StorePort & StoreWatcher) => StorePort & StoreWatcher;
};

/**
 * One processing instance in this process, mirroring `apps/processing/src/main.ts`: the store and
 * the link start together, the consumer registers once both are ready. Resolves once the health
 * server listens: a scenario that needs the consumer registered waits for its `consumer registered`
 * line. The database name is the test's own, so two tests never share a collection.
 */
export async function startProcessing(
  env: TestEnvironment,
  { overrides = {}, hostname, wrapStore }: StartProcessingOptions = {},
): Promise<ProcessingInstance> {
  const config = loadProcessingConfig({
    RABBITMQ_URL: env.amqpUrl,
    MONGODB_URL: env.mongoUrl,
    MONGODB_DB: env.dbName,
    ...overrides,
  });
  const logs = new LogCapture(env.signal);
  const logger: Logger = createLogger({
    service: 'processing',
    level: 'debug',
    destination: logs.destination(),
  });
  const store = new MongoStore({
    url: config.MONGODB_URL,
    dbName: config.MONGODB_DB,
    writeW: config.MONGODB_WRITE_W,
    timeoutMs: config.MONGODB_TIMEOUT_MS,
    logger,
  });
  const consumer = new AmqpConsumer({
    url: config.RABBITMQ_URL,
    heartbeatSeconds: config.AMQP_HEARTBEAT_S,
    prefetch: config.PROCESSING_PREFETCH,
    transientAttempts: config.PROCESSING_TRANSIENT_ATTEMPTS,
    shutdownTimeoutMs: config.SHUTDOWN_TIMEOUT_MS,
    store: wrapStore === undefined ? store : wrapStore(store),
    logger,
    ...(hostname === undefined ? {} : { hostname }),
  });
  /** Ends a store start still looping at stop, as the entry point does. */
  const startup = new AbortController();
  let shuttingDown = false;
  const health = await startHealthServer({
    port: 0,
    report: () => processingReadiness({ consumerState: consumer.state, shuttingDown }),
    logger,
  });
  const stop = env.undo(
    async () => {
      shuttingDown = true;
      startup.abort();
      await consumer.stop();
      await store.close();
      await health.close();
    },
    `processing ${hostname ?? 'instance'} stop`,
  );
  consumer.start();
  void store.start(startup.signal).then(
    (outcome) => {
      if (outcome === 'ready') {
        consumer.storeReady();
      }
    },
    (error: unknown) => {
      // The entry point exits 1 here; a test reads the line instead.
      logger.fatal({ err: error }, 'index conflict');
    },
  );
  return {
    healthPort: health.port,
    consumer,
    store,
    logs,
    stats: () => consumer.stats(),
    readiness: () => readiness(health.port),
    stop,
  };
}

export type Exit = { code: number | null; signal: NodeJS.Signals | null };

export type ServiceProcess = {
  logs: LogCapture;
  lines(): LogLine[];
  /** Resolves on the line with this `msg`; rejects with the diagnostics if the child ends first. */
  waitForLog(msg: string): Promise<LogLine>;
  /** Resolves on 'close': the process has ended and its stdout has been read to the end. */
  closed: Promise<Exit>;
  /** Everything the child wrote to stderr, and any stdout line that was not JSON. */
  diagnostics(): string;
  /** Sends a process signal; unrelated to the test's `AbortSignal`. */
  kill(posixSignal: NodeJS.Signals): void;
};

/**
 * The real entry point of an application as a child process, from its TypeScript sources (the
 * child-process pattern of `apps/ingest/src/main.test.ts`, shared): `node
 * --experimental-transform-types --import <app>/src/test-source-hooks.ts <app>/src/main.ts`. The
 * child's environment is exactly `variables`. A SIGKILL is registered on `env.undo` and runs only
 * while the child is still alive, so no process outlives its test.
 */
export function spawnService(
  env: TestEnvironment,
  { app, variables }: { app: 'ingest' | 'processing'; variables: Record<string, string> },
): ServiceProcess {
  const main = fileURLToPath(new URL(`../../apps/${app}/src/main.ts`, import.meta.url));
  const hooks = fileURLToPath(
    new URL(`../../apps/${app}/src/test-source-hooks.ts`, import.meta.url),
  );
  const child = spawn(
    process.execPath,
    ['--experimental-transform-types', '--import', hooks, main],
    { env: variables, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  env.undo(() => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
    }
    return Promise.resolve();
  }, `${app} child SIGKILL`);
  const logs = new LogCapture(env.signal);
  let pending = '';
  let diagnostics = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    pending += chunk;
    let index = pending.indexOf('\n');
    while (index !== -1) {
      logs.pushText(pending.slice(0, index));
      pending = pending.slice(index + 1);
      index = pending.indexOf('\n');
    }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    diagnostics += chunk;
  });
  child.once('error', (error) => {
    diagnostics += `[spawn error] ${error.message}\n`;
  });
  // 'close', not 'exit': 'exit' can fire while stdout still holds the last lines.
  const closed = new Promise<Exit>((resolve) => {
    child.once('close', (code, signal) => {
      resolve({ code, signal });
    });
  });
  const allDiagnostics = (): string => `${diagnostics}${logs.diagnostics()}`;
  return {
    logs,
    lines: () => logs.lines(),
    waitForLog: (msg) =>
      Promise.race([
        logs.waitForLine((line) => line.msg === msg),
        closed.then(({ code }) => {
          throw new Error(
            `${app} ended (code ${String(code)}) before logging "${msg}":\n${allDiagnostics()}`,
          );
        }),
      ]),
    closed,
    diagnostics: allDiagnostics,
    kill: (posixSignal) => {
      child.kill(posixSignal);
    },
  };
}

function listen(server: net.Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve(typeof address === 'object' && address !== null ? address.port : 0);
    });
  });
}

function close(server: net.Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => {
      resolve();
    });
  });
}

/** Distinct free ports, taken together and released together, so no two are the same (the unit tests' pattern). */
export async function freePorts(count: number): Promise<number[]> {
  const held = Array.from({ length: count }, () => net.createServer());
  const ports = await Promise.all(held.map((server) => listen(server)));
  await Promise.all(held.map((server) => close(server)));
  return ports;
}
```

- [ ] Create `test/harness/clients.ts`:

```ts
import {
  ALERTS_COLLECTION,
  DEAD_LETTER_EXCHANGE,
  DEAD_LETTER_EXCHANGE_OPTIONS,
  DEAD_LETTER_EXCHANGE_TYPE,
  DEAD_LETTER_QUEUE,
  DEAD_LETTER_QUEUE_OPTIONS,
  DEVICE_STATE_COLLECTION,
  EVENTS_COLLECTION,
  TELEMETRY_EXCHANGE,
  TELEMETRY_EXCHANGE_OPTIONS,
  TELEMETRY_EXCHANGE_TYPE,
  TELEMETRY_QUEUE,
  TELEMETRY_QUEUE_OPTIONS,
  TELEMETRY_ROUTING_KEY,
  messageIdentity,
  type AlertDocument,
  type CountersPayload,
  type DeviceStateDocument,
  type DiagnosticPayload,
  type EventDocument,
  type MetricsPayload,
  type OrderKey,
  type StatusPayload,
  type TelemetryEventType,
  type TelemetryMessage,
  type TelemetryMessageOf,
} from '@telemetry/shared';
import { connect as amqpConnect, type ConfirmChannel, type Options } from 'amqplib';
import type { WithId } from 'mongodb';

import { toPublishArgs, type PublishArgs } from '../../apps/ingest/src/amqp-message.js';
import { connectTestDevice, type TestDevice } from '../../apps/ingest/src/test-device.js';
import type { StorePort, StoreWatcher } from '../../apps/processing/src/store.js';
import type { TestEnvironment } from './environment.js';
import type { Expected } from './load.js';

/** Two session ids inside the contract's window; B is the later session (P5). */
export const SESSION_A = 1_700_000_000_000;
export const SESSION_B = 1_700_000_001_000;

/** A `ws` device against an ingest port; terminated with the test. */
export async function connectDevice(env: TestEnvironment, port: number): Promise<TestDevice> {
  const device = await connectTestDevice({ port });
  env.undo(() => {
    device.terminate();
    return Promise.resolve();
  }, 'device terminate');
  return device;
}

export type MessageBuilder = {
  status(seq: number, payload?: Partial<StatusPayload>): TelemetryMessageOf<'status'>;
  metrics(seq: number, payload?: Partial<MetricsPayload>): TelemetryMessageOf<'metrics'>;
  counters(seq: number, payload?: Partial<CountersPayload>): TelemetryMessageOf<'counters'>;
  diagnostic(seq: number, payload?: Partial<DiagnosticPayload>): TelemetryMessageOf<'diagnostic'>;
};

/** Messages of one device and one session, so the tests read as identity and order, not as JSON. */
export function messages(deviceId: string, sessionId: number): MessageBuilder {
  const envelope = (seq: number) => ({
    v: 1 as const,
    deviceId,
    sessionId,
    seq,
    occurredAt: sessionId + seq,
  });
  return {
    status: (seq, payload = {}) => ({
      ...envelope(seq),
      type: 'status',
      payload: { state: 'online', ...payload },
    }),
    metrics: (seq, payload = {}) => ({
      ...envelope(seq),
      type: 'metrics',
      payload: { temperatureC: 41.5, cpuPercent: 12.25, ramPercent: 63, ...payload },
    }),
    counters: (seq, payload = {}) => ({
      ...envelope(seq),
      type: 'counters',
      payload: { operationsTotal: 120, uptimeMs: 3_600_000, ...payload },
    }),
    diagnostic: (seq, payload = {}) => ({
      ...envelope(seq),
      type: 'diagnostic',
      payload: {
        severity: 'error',
        code: 'E_OVERHEAT',
        message: 'temperature above threshold',
        ...payload,
      },
    }),
  };
}

export type DirectPublisher = {
  /** Resolves on the broker's confirm; rejects when the confirm fails or the channel is gone. */
  publish(message: TelemetryMessage, receivedAt?: number): Promise<void>;
  /** A raw body with the given properties: the poison messages of C7. */
  publishRaw(body: Buffer, properties?: Options.Publish): Promise<void>;
  close(): Promise<void>;
};

/** The six declarations the services make, with the shared constants, in ingest's order. */
async function declareTopology(channel: ConfirmChannel): Promise<void> {
  await channel.assertExchange(
    TELEMETRY_EXCHANGE,
    TELEMETRY_EXCHANGE_TYPE,
    TELEMETRY_EXCHANGE_OPTIONS,
  );
  await channel.assertExchange(
    DEAD_LETTER_EXCHANGE,
    DEAD_LETTER_EXCHANGE_TYPE,
    DEAD_LETTER_EXCHANGE_OPTIONS,
  );
  await channel.assertQueue(TELEMETRY_QUEUE, TELEMETRY_QUEUE_OPTIONS);
  await channel.assertQueue(DEAD_LETTER_QUEUE, DEAD_LETTER_QUEUE_OPTIONS);
  await channel.bindQueue(TELEMETRY_QUEUE, TELEMETRY_EXCHANGE, TELEMETRY_ROUTING_KEY);
  await channel.bindQueue(DEAD_LETTER_QUEUE, DEAD_LETTER_EXCHANGE, '');
}

function confirmed(channel: ConfirmChannel, args: PublishArgs): Promise<void> {
  return new Promise((resolve, reject) => {
    // Throws at once on a closed channel; the executor turns that into a rejection.
    channel.publish(
      args.exchange,
      args.routingKey,
      args.content,
      args.options,
      (error: unknown) => {
        if (error === null || error === undefined) {
          resolve();
        } else {
          // amqplib passes an Error; anything else is named, not stringified (lint: no-base-to-string).
          reject(error instanceof Error ? error : new Error('publish not confirmed'));
        }
      },
    );
  });
}

/**
 * One connection and one confirm channel on the test virtual host, no recovery (integration spec,
 * decision 24): a test that restarts the broker opens a new publisher afterwards. `close()` resolves
 * at once when the connection has already seen its `close` event, because a `close()` after that
 * rejects (measured after a broker restart).
 */
export async function openDirectPublisher(env: TestEnvironment): Promise<DirectPublisher> {
  const model = await amqpConnect(env.amqpUrl);
  let gone = false;
  model.on('error', () => {
    // The `close` event that follows is what matters; the listener keeps the error from throwing.
  });
  model.once('close', () => {
    gone = true;
  });
  const channel = await model.createConfirmChannel();
  channel.on('error', () => {
    // A failed publish rejects its own promise; the channel's error would otherwise throw.
  });
  await declareTopology(channel);
  const close = env.undo(async () => {
    if (gone) {
      return;
    }
    gone = true;
    await model.close();
  }, 'direct publisher close');
  return {
    publish: (message, receivedAt = Date.now()) =>
      confirmed(channel, toPublishArgs(message, receivedAt)),
    publishRaw: (body, properties = {}) =>
      confirmed(channel, {
        exchange: TELEMETRY_EXCHANGE,
        routingKey: TELEMETRY_ROUTING_KEY,
        content: body,
        options: { persistent: true, ...properties },
      }),
    close,
  };
}

export type QueueDepth = { ready: number; consumers: number };

/**
 * The live depth through amqplib's `checkQueue` (decision 13): `messageCount` is the ready count,
 * `consumerCount` the consumers; deliveries a consumer holds show in its `inFlight`, not here.
 * `undefined` when the queue does not exist: the check closes the channel with a 404, which a
 * `waitFor` predicate reads as "not yet" (I3).
 */
export async function queueDepth(
  env: TestEnvironment,
  queue: string = TELEMETRY_QUEUE,
): Promise<QueueDepth | undefined> {
  const model = await env.amqp();
  const channel = await model.createChannel();
  channel.on('error', () => {
    // A 404 closes the channel with an error event; without a listener it would throw.
  });
  try {
    const reply = await channel.checkQueue(queue);
    return { ready: reply.messageCount, consumers: reply.consumerCount };
  } catch {
    return undefined;
  } finally {
    await channel.close().catch(() => undefined);
  }
}

export type InsertGate = {
  /**
   * Wraps the store the consumer sees: every `insertEvent` waits for `release()`; the rest is
   * delegated. A property, not a method signature, so `wrapStore: gate.wrap` passes the
   * `unbound-method` lint rule.
   */
  wrap: (store: StorePort & StoreWatcher) => StorePort & StoreWatcher;
  release: () => void;
};

/** The store gate of C11b; `release` is registered on `env.undo` too, so a failed test never leaves handlers waiting. */
export function holdInserts(env: TestEnvironment): InsertGate {
  const gate = Promise.withResolvers<void>();
  const release = (): void => {
    gate.resolve();
  };
  env.undo(() => {
    release();
    return Promise.resolve();
  }, 'release held inserts');
  return {
    wrap: (store) => ({
      insertEvent: async (doc) => {
        await gate.promise;
        return store.insertEvent(doc);
      },
      applyState: (update) => store.applyState(update),
      insertAlert: (doc) => store.insertAlert(doc),
      watch: (watchSignal) => store.watch(watchSignal),
    }),
    release,
  };
}

export function readEvents(env: TestEnvironment): Promise<WithId<EventDocument>[]> {
  return env.db
    .collection<EventDocument>(EVENTS_COLLECTION)
    .find({})
    .sort({ deviceId: 1, sessionId: 1, seq: 1 })
    .toArray();
}

export function readState(
  env: TestEnvironment,
  deviceId: string,
): Promise<DeviceStateDocument | null> {
  return env.db.collection<DeviceStateDocument>(DEVICE_STATE_COLLECTION).findOne({ _id: deviceId });
}

export function readAlerts(env: TestEnvironment): Promise<AlertDocument[]> {
  return env.db.collection<AlertDocument>(ALERTS_COLLECTION).find({}).sort({ _id: 1 }).toArray();
}

/** The recovery tests reproduce a crash between two writes by removing what the later write made (C13, C14). */
export async function deleteStateDocument(env: TestEnvironment, deviceId: string): Promise<void> {
  const result = await env.db
    .collection<DeviceStateDocument>(DEVICE_STATE_COLLECTION)
    .deleteOne({ _id: deviceId });
  if (result.deletedCount !== 1) {
    throw new Error(`no device_state document for ${deviceId}`);
  }
}

export async function deleteAlertDocument(env: TestEnvironment, identity: string): Promise<void> {
  const result = await env.db
    .collection<AlertDocument>(ALERTS_COLLECTION)
    .deleteOne({ _id: identity });
  if (result.deletedCount !== 1) {
    throw new Error(`no alert document ${identity}`);
  }
}

export function identitiesOf(events: readonly EventDocument[]): Set<string> {
  return new Set(events.map((event) => messageIdentity(event)));
}

/** The `(sessionId, seq)` of one section, or undefined when the section is absent. */
export function sectionKey(
  state: DeviceStateDocument | null,
  type: TelemetryEventType,
): OrderKey | undefined {
  const section = state?.[type];
  return section === undefined ? undefined : { sessionId: section.sessionId, seq: section.seq };
}

function describeKey(key: OrderKey | undefined): string {
  return key === undefined ? 'absent' : `(${String(key.sessionId)}, ${String(key.seq)})`;
}

/**
 * Every section and `lastEvent` of `expected` compared with the stored documents; empty when all
 * match, otherwise one line per mismatch, so a failure names the device, the section and both keys.
 */
export async function stateMismatches(env: TestEnvironment, expected: Expected): Promise<string[]> {
  const mismatches: string[] = [];
  for (const [deviceId, sections] of expected.sections) {
    const state = await readState(env, deviceId);
    for (const [type, key] of sections) {
      const stored = sectionKey(state, type);
      if (stored === undefined || stored.sessionId !== key.sessionId || stored.seq !== key.seq) {
        mismatches.push(
          `${deviceId}.${type}: stored ${describeKey(stored)}, expected ${describeKey(key)}`,
        );
      }
    }
    const last = expected.lastEvent.get(deviceId);
    const storedLast = state?.lastEvent;
    if (
      last !== undefined &&
      (storedLast === undefined ||
        storedLast.sessionId !== last.sessionId ||
        storedLast.seq !== last.seq)
    ) {
      mismatches.push(
        `${deviceId}.lastEvent: stored ${describeKey(storedLast)}, expected ${describeKey(last)}`,
      );
    }
  }
  return mismatches;
}
```

- [ ] `pnpm typecheck && pnpm lint` exit 0; `pnpm exec prettier --check test/harness`.
- [ ] `pnpm test:unit` → 889 (unchanged from Task 4: nothing here is a test).
- [ ] Commit the two files — subject: `Add the harness services and clients`.

### Task 6: Pipeline tests P1–P5 [integration]

**Files:** Create `test/integration/pipeline.test.ts`
**Invariant:** 1 (P3, P4, P5: an older message never overwrites newer state), 2 (P2: a duplicate has no effect), 3 (P1–P5: every state change is the conditional upsert against a real server, proven by the section keys), 4 (P1: four concurrent handlers of one device end in the expected sections). The first live run of the whole harness: the global setup, the environment, the services, the clients, the waits.
**Verify:** `pnpm test:integration test/integration/pipeline.test.ts` → 5 passed; then `pnpm typecheck && pnpm lint && pnpm exec prettier --check test/integration`.

- [ ] Create `test/integration/pipeline.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  SESSION_A,
  SESSION_B,
  connectDevice,
  messages,
  queueDepth,
  readAlerts,
  readEvents,
  readState,
  sectionKey,
} from '../harness/clients.js';
import {
  bindEnvironment,
  createEnvironment,
  type TestEnvironment,
} from '../harness/environment.js';
import {
  startIngest,
  startProcessing,
  type IngestInstance,
  type ProcessingInstance,
} from '../harness/services.js';
import { byMsg } from '../harness/wait.js';

let created: TestEnvironment | undefined;

beforeEach(async () => {
  created = await createEnvironment();
});

afterEach(async () => {
  const current = created;
  created = undefined;
  await current?.dispose();
});

const environment = (signal: AbortSignal): TestEnvironment => bindEnvironment(created, signal);

type Pipeline = { ingest: IngestInstance; processing: ProcessingInstance };

/** One ingest and one processing; the consumer is registered, so the acknowledgement count is a sound signal. */
async function startPipeline(context: TestEnvironment): Promise<Pipeline> {
  const processing = await startProcessing(context);
  const ingest = await startIngest(context);
  await processing.logs.waitForLine(byMsg('consumer registered'));
  return { ingest, processing };
}

describe('pipeline: device → ingest → RabbitMQ → processing → MongoDB', () => {
  it('P1 one message of each type reaches MongoDB', async ({ signal }) => {
    const env = environment(signal);
    const { ingest, processing } = await startPipeline(env);
    const device = await connectDevice(env, ingest.port);
    const build = messages('p1-device', SESSION_A);
    const sent = [
      build.status(1),
      build.metrics(2),
      build.counters(3),
      build.diagnostic(4, { severity: 'error' }),
    ];
    for (const message of sent) {
      device.sendMessage(message);
    }
    await env.awaitAcked(processing, 4);

    const events = await readEvents(env);
    expect(events).toHaveLength(4);
    sent.forEach((message, index) => {
      expect(events[index]).toMatchObject({
        deviceId: message.deviceId,
        sessionId: message.sessionId,
        seq: message.seq,
        type: message.type,
        occurredAt: message.occurredAt,
        payload: message.payload,
      });
      expect(typeof events[index]?.receivedAt).toBe('number');
      expect(typeof events[index]?.processedAt).toBe('number');
    });
    const state = await readState(env, 'p1-device');
    expect(sectionKey(state, 'status')).toEqual({ sessionId: SESSION_A, seq: 1 });
    expect(sectionKey(state, 'metrics')).toEqual({ sessionId: SESSION_A, seq: 2 });
    expect(sectionKey(state, 'counters')).toEqual({ sessionId: SESSION_A, seq: 3 });
    expect(sectionKey(state, 'diagnostic')).toEqual({ sessionId: SESSION_A, seq: 4 });
    expect(state?.status).toMatchObject({ state: 'online' });
    expect(state?.lastEvent).toMatchObject({ sessionId: SESSION_A, seq: 4, type: 'diagnostic' });
    const alerts = await readAlerts(env);
    expect(alerts.map((alert) => alert._id)).toEqual([`p1-device:${String(SESSION_A)}:4`]);
    expect(alerts[0]).toMatchObject({ deviceId: 'p1-device', seq: 4, code: 'E_OVERHEAT' });
    const stats = processing.stats();
    // `duplicate` is reported, not asserted: four handlers race on the device's first state write.
    expect(stats, `stats ${JSON.stringify(stats)}`).toMatchObject({
      created: 1,
      applied: 3,
      stale: 0,
      alerts: 1,
      failed: 0,
      rejected: 0,
    });
    expect((await queueDepth(env))?.ready).toBe(0);
  });

  it('P2 a duplicate has no effect', async ({ signal }) => {
    const env = environment(signal);
    const { ingest, processing } = await startPipeline(env);
    const device = await connectDevice(env, ingest.port);
    const build = messages('p2-device', SESSION_A);
    const first = [
      build.counters(1, { operationsTotal: 120 }),
      build.diagnostic(2, { severity: 'error' }),
    ];
    for (const message of first) {
      device.sendMessage(message);
    }
    await env.awaitAcked(processing, 2);
    // Byte for byte: the same objects encode to the same frames.
    for (const message of first) {
      device.sendMessage(message);
    }
    await env.awaitAcked(processing, 4);

    const events = await readEvents(env);
    expect(events.map((event) => event.seq)).toEqual([1, 2]);
    const state = await readState(env, 'p2-device');
    expect(state?.counters).toMatchObject({ sessionId: SESSION_A, seq: 1, operationsTotal: 120 });
    expect(await readAlerts(env)).toHaveLength(1);
    const stats = processing.stats();
    expect(stats, `stats ${JSON.stringify(stats)}`).toMatchObject({
      duplicate: 2,
      stale: 2,
      alerts: 1,
      failed: 0,
    });
  });

  it('P3 an older message never overwrites newer state', async ({ signal }) => {
    const env = environment(signal);
    const { ingest, processing } = await startPipeline(env);
    const device = await connectDevice(env, ingest.port);
    const build = messages('p3-device', SESSION_A);
    device.sendMessage(build.metrics(6, { temperatureC: 41.5 }));
    await env.awaitAcked(processing, 1);
    device.sendMessage(build.metrics(5, { temperatureC: 99 }));
    await env.awaitAcked(processing, 2);

    const state = await readState(env, 'p3-device');
    expect(state?.metrics).toMatchObject({ sessionId: SESSION_A, seq: 6, temperatureC: 41.5 });
    expect((await readEvents(env)).map((event) => event.seq)).toEqual([5, 6]);
    expect(processing.stats()).toMatchObject({ stale: 1, failed: 0 });
  });

  it('P4 order is kept per section, not per message', async ({ signal }) => {
    const env = environment(signal);
    const { ingest, processing } = await startPipeline(env);
    const device = await connectDevice(env, ingest.port);
    const build = messages('p4-device', SESSION_A);
    device.sendMessage(build.metrics(8));
    await env.awaitAcked(processing, 1);
    device.sendMessage(build.status(7));
    await env.awaitAcked(processing, 2);

    const state = await readState(env, 'p4-device');
    expect(sectionKey(state, 'status')).toEqual({ sessionId: SESSION_A, seq: 7 });
    expect(sectionKey(state, 'metrics')).toEqual({ sessionId: SESSION_A, seq: 8 });
    expect(state?.lastEvent).toMatchObject({ sessionId: SESSION_A, seq: 8, type: 'metrics' });
    expect(processing.stats()).toMatchObject({ created: 1, applied: 1, stale: 0, failed: 0 });
  });

  it('P5 a new session wins and a straggler of the old one is stale', async ({ signal }) => {
    const env = environment(signal);
    const { ingest, processing } = await startPipeline(env);
    const device = await connectDevice(env, ingest.port);
    const sessionA = messages('p5-device', SESSION_A);
    const sessionB = messages('p5-device', SESSION_B);
    device.sendMessage(sessionA.counters(1, { operationsTotal: 100 }));
    device.sendMessage(sessionA.status(2));
    await env.awaitAcked(processing, 2);
    device.sendMessage(sessionB.counters(1, { operationsTotal: 5 }));
    await env.awaitAcked(processing, 3);
    device.sendMessage(sessionA.counters(3, { operationsTotal: 200 }));
    await env.awaitAcked(processing, 4);

    const state = await readState(env, 'p5-device');
    expect(state?.counters).toMatchObject({ sessionId: SESSION_B, seq: 1, operationsTotal: 5 });
    expect(sectionKey(state, 'status')).toEqual({ sessionId: SESSION_A, seq: 2 });
    expect(state?.lastEvent).toMatchObject({ sessionId: SESSION_B, seq: 1 });
    expect(await readEvents(env)).toHaveLength(4);
    expect(processing.stats()).toMatchObject({ stale: 1, failed: 0 });
  });
});
```

- [ ] `pnpm test:integration test/integration/pipeline.test.ts`: the global setup prints the `up --wait` progress, the five tests pass, the teardown prints the `down -v` progress. Afterwards `docker compose -f docker-compose.test.yml ps -aq | wc -l` → 0 and `docker volume ls -q --filter name=telemetry-test | wc -l` → 0.
- [ ] The ownership rule: `docker compose -f docker-compose.test.yml up -d --wait`, run the file again (passes), `docker compose -f docker-compose.test.yml ps --services --status running | wc -l` → 2 (a hand-started stack stays), `curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:15673/api/overview` → `401`; then `docker compose -f docker-compose.test.yml down -v`.
- [ ] The partial-leftover rule: `docker compose -f docker-compose.test.yml up -d --wait mongodb` (one service), run the file (passes: the setup sees one running service, counts itself as the owner), afterwards `ps -aq | wc -l` → 0.
- [ ] `pnpm typecheck && pnpm lint && pnpm exec prettier --check test/integration`.
- [ ] Commit — subject: `Add the pipeline integration tests`.

What fails it (A8): P1 — a handler that skips `insertAlert` for an error diagnostic (`alerts` 0, no alert document), or a pipeline whose `$cond` compares `seq` alone (a second session would never be applied, seen in P5). P2 — a `messageIdentity` that includes `receivedAt` (four events, two alerts, `duplicate` 0); a handler that returns early on a duplicate event insert passes P2 but fails C13/C14 (Task 9). P3 — a `$lt` turned `$lte`, or `isNewer` with `>=` (`temperatureC` 99 stored, `stale` 0). P4 — one watermark for the whole document instead of one per section (`status` seq 7 refused as stale after `metrics` 8). P5 — a comparison of `seq` before `sessionId` (the straggler A/3 would overwrite B/1).

### Task 7: Pipeline test P6, many devices in parallel [integration]

**Files:** Modify `test/integration/pipeline.test.ts`
**Invariant:** 4 (twenty devices over twenty connections at once, every section correct, `created === 20`), 1 and 2 under concurrency (swapped pairs and injected duplicates absorbed), 3 (the hot device concentrates a quarter of the load on one `device_state` document).
**Verify:** `pnpm test:integration test/integration/pipeline.test.ts` → 6 passed; `pnpm typecheck && pnpm lint && pnpm exec prettier --check test/integration`.

- [ ] Add to the imports of `pipeline.test.ts`: `import type { TelemetryMessage } from '@telemetry/shared';`, `identitiesOf` and `stateMismatches` from `../harness/clients.js`, and `import { generateLoad } from '../harness/load.js';`.
- [ ] Append inside the `describe` block, after P5:

```ts
it('P6 many devices in parallel end in the expected state', async ({ signal }) => {
  const env = environment(signal);
  const { ingest, processing } = await startPipeline(env);
  const { sends, expected } = generateLoad({
    devices: 20,
    messages: 1000,
    hotShare: 0.25,
    duplicatePercent: 5,
    swapPercent: 5,
    seed: 1,
  });
  const streams = new Map<string, TelemetryMessage[]>();
  for (const message of sends) {
    const stream = streams.get(message.deviceId) ?? [];
    stream.push(message);
    streams.set(message.deviceId, stream);
  }
  expect(streams.size).toBe(20);
  const devices = await Promise.all([...streams.keys()].map(() => connectDevice(env, ingest.port)));
  // Every device sends its own stream in order, all twenty at once.
  [...streams.values()].forEach((stream, index) => {
    const device = devices[index];
    if (device === undefined) {
      throw new Error(`no device for stream ${String(index)}`);
    }
    for (const message of stream) {
      device.sendMessage(message);
    }
  });
  await env.awaitAcked(processing, sends.length);

  const events = await readEvents(env);
  expect(identitiesOf(events)).toEqual(expected.identities);
  expect(events).toHaveLength(expected.identities.size);
  expect(await stateMismatches(env, expected)).toEqual([]);
  expect(new Set((await readAlerts(env)).map((alert) => alert._id))).toEqual(expected.alerts);
  const stats = processing.stats();
  // `stale` is reported, not asserted: whether a swapped lower `seq` is processed after the
  // higher one depends on scheduling. `duplicate` counts duplicate inserts of any cause.
  expect(stats, `stats ${JSON.stringify(stats)}`).toMatchObject({
    created: 20,
    failed: 0,
    rejected: 0,
  });
  expect(stats.duplicate, `stats ${JSON.stringify(stats)}`).toBeGreaterThanOrEqual(
    expected.duplicates,
  );
  expect((await queueDepth(env))?.ready).toBe(0);
}, 60_000);
```

- [ ] The block above is printed at the top level; once it sits inside the `describe` block, run `pnpm exec prettier --write test/integration/pipeline.test.ts`. The only change is the indentation (checked in the plan's probe, Research).
- [ ] `pnpm test:integration test/integration/pipeline.test.ts` → 6 passed. Note P6's duration from the reporter (expected: a few seconds).
- [ ] `pnpm typecheck && pnpm lint && pnpm exec prettier --check test/integration`.
- [ ] Commit — subject: `Add the many-devices pipeline test`.

What fails it (A8): a consumer that acknowledges before the alert insert (an alert missing from the set when the run is cut short); a state update that is not conditional (a swapped lower `seq` overwrites the higher one: a section key below the expected); a dropped frame anywhere on the path (an identity missing from the stored set, which an expectation derived from stored data could not notice); a message published twice by ingest without a recycle (`events.length` above the identity count would still be absorbed by the index, but `acked` would exceed `sends.length` and the wait would time out with the counts in its text).

### Task 8: Fault helpers and the ingest publisher tests I1–I7 [integration]

**Files:** Modify `test/harness/stack.ts`; create `test/integration/ingest-publisher.test.ts`
**Invariant:** 2 on the ingest side (I2, I4, I7: a message the broker did not confirm is published again, so a message is never lost and a duplicate is the accepted cost; I3: a returned message reaches the re-declared queue), 6 (ingest holds no per-device state: I5's drain closes every device with 1001 and exits 0), and the ledger's "invalid message is rejected and never reaches the queue" (I6).
**Verify:** `pnpm test:integration test/integration/ingest-publisher.test.ts` → 7 passed; `pnpm typecheck && pnpm lint && pnpm exec prettier --check test/harness test/integration`.

- [ ] In `test/harness/stack.ts`, add after the `node:util` import: `import type { Recover, TestEnvironment } from './environment.js';` (type-only, so there is no runtime cycle: `environment.ts` imports only the `TestStack` type from here). Then append at the end of the file:

```ts
/** Ceilings for the sub-second fault commands; the test's own signal is the real bound (decision 12). */
const FAULT_COMMAND_TIMEOUT_MS = 10_000;
/** A container stop waits for its process (Docker's 10 s grace); `restart` plus its `up --wait` ran in 4 s. */
const STOP_OR_RESTART_TIMEOUT_MS = 20_000;
/** A recovery's own bound inside `dispose()`, under the 60 s hook budget. */
const RECOVERY_COMMAND_TIMEOUT_MS = 50_000;
const RECOVERY_WAIT_TIMEOUT_S = '40';

/**
 * The fault helpers of decision 12. Each registers its recovery on `env.undo` BEFORE it issues the
 * mutation, so a command aborted or killed mid-way is still recovered; each runs the mutation
 * under the test's signal and returns `recover()`, which runs the recovery until it has succeeded
 * once. Every recovery checks the service's state first, because it may follow a partly
 * successful attempt.
 */

/**
 * `docker compose pause <service>`. The recovery unpauses only a service that is still paused
 * (`unpause` of a running container exits 1, measured) and is never followed by `up --wait`: a
 * container reads `unhealthy` for about 10 s after an unpause, and `up --wait` fails fast then.
 */
export async function pause(env: TestEnvironment, service: Service): Promise<Recover> {
  const recover = env.undo(async (signal) => {
    const paused = await compose(['ps', '--services', '--status', 'paused'], {
      signal,
      timeoutMs: RECOVERY_COMMAND_TIMEOUT_MS,
    });
    if (paused.split('\n').includes(service)) {
      await compose(['unpause', service], { signal, timeoutMs: RECOVERY_COMMAND_TIMEOUT_MS });
    }
  }, `unpause ${service}`);
  await env.track(
    compose(['pause', service], { signal: env.signal, timeoutMs: FAULT_COMMAND_TIMEOUT_MS }),
  );
  return recover;
}

/** `docker compose stop <service>`; the recovery is `start` (exit 0 on a running service) and `up -d --wait`, which is its own state check. */
export async function stop(env: TestEnvironment, service: Service): Promise<Recover> {
  const recover = env.undo(async (signal) => {
    await compose(['start', service], { signal, timeoutMs: RECOVERY_COMMAND_TIMEOUT_MS });
    await compose(['up', '-d', '--wait', '--wait-timeout', RECOVERY_WAIT_TIMEOUT_S, service], {
      signal,
      timeoutMs: RECOVERY_COMMAND_TIMEOUT_MS,
    });
  }, `start ${service}`);
  await env.track(
    compose(['stop', service], { signal: env.signal, timeoutMs: STOP_OR_RESTART_TIMEOUT_MS }),
  );
  return recover;
}

/**
 * `docker compose restart <service>` and then `up -d --wait` until it is healthy again (2.6 s after
 * a restart, measured); the recovery is another `up -d --wait`, which also completes a restart that
 * was cut off mid-way and returns in 0.6 s on a healthy stack.
 */
export async function restart(env: TestEnvironment, service: Service): Promise<Recover> {
  const recover = env.undo(async (signal) => {
    await compose(['up', '-d', '--wait', '--wait-timeout', RECOVERY_WAIT_TIMEOUT_S, service], {
      signal,
      timeoutMs: RECOVERY_COMMAND_TIMEOUT_MS,
    });
  }, `up ${service}`);
  await env.track(
    compose(['restart', service], { signal: env.signal, timeoutMs: STOP_OR_RESTART_TIMEOUT_MS }),
  );
  await env.track(
    compose(['up', '-d', '--wait', '--wait-timeout', '15', service], {
      signal: env.signal,
      timeoutMs: STOP_OR_RESTART_TIMEOUT_MS,
    }),
  );
  return recover;
}

function rabbitmqctl(args: readonly string[], options: ComposeOptions): Promise<string> {
  return compose(['exec', '-T', 'rabbitmq', 'rabbitmqctl', ...args], options);
}

/**
 * The memory alarm of the RabbitMQ publishers documentation (`set_vm_memory_high_watermark 0`,
 * 358 ms measured); the recovery restores the 4.3 default of 0.6, unconditionally and idempotently.
 */
export async function raiseMemoryAlarm(env: TestEnvironment): Promise<Recover> {
  const recover = env.undo(async (signal) => {
    await rabbitmqctl(['set_vm_memory_high_watermark', '0.6'], {
      signal,
      timeoutMs: RECOVERY_COMMAND_TIMEOUT_MS,
    });
  }, 'reset memory alarm');
  await env.track(
    rabbitmqctl(['set_vm_memory_high_watermark', '0'], {
      signal: env.signal,
      timeoutMs: FAULT_COMMAND_TIMEOUT_MS,
    }),
  );
  return recover;
}
```

- [ ] Create `test/integration/ingest-publisher.test.ts`:

```ts
import { setTimeout as sleep } from 'node:timers/promises';

import { TELEMETRY_QUEUE, messageIdentity, type TelemetryMessage } from '@telemetry/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';

import type { TestDevice } from '../../apps/ingest/src/test-device.js';
import {
  SESSION_A,
  connectDevice,
  messages,
  queueDepth,
  type MessageBuilder,
} from '../harness/clients.js';
import {
  bindEnvironment,
  createEnvironment,
  type TestEnvironment,
} from '../harness/environment.js';
import type { QueueMessage } from '../harness/management.js';
import { freePorts, spawnService, startIngest, type IngestInstance } from '../harness/services.js';
import { pause, raiseMemoryAlarm, restart } from '../harness/stack.js';
import { ERROR_LEVEL, WARN_LEVEL, byMsg } from '../harness/wait.js';

/** The reasons of a recycle from `ready`; a failed connect attempt during the outage logs `connect_failed` instead. */
const RECYCLE_REASONS = ['channel_closed', 'connection_closed'];
const BACKOFF_REASONS = [...RECYCLE_REASONS, 'connect_failed'];
/** The ingest process's `AMQP_CLOSE_TIMEOUT_MS`, the second term of its shutdown bound. */
const AMQP_CLOSE_TIMEOUT_MS = 2_000;

let created: TestEnvironment | undefined;

beforeEach(async () => {
  created = await createEnvironment();
});

afterEach(async () => {
  const current = created;
  created = undefined;
  await current?.dispose();
});

const environment = (signal: AbortSignal): TestEnvironment => bindEnvironment(created, signal);

/** An ingest whose publisher is ready: a fault injected before that would land on no connection. */
async function readyIngest(
  context: TestEnvironment,
  overrides: Record<string, string> = {},
): Promise<IngestInstance> {
  const ingest = await startIngest(context, overrides);
  await context.waitFor(() => ingest.publisher.isReady, {
    describe: () => `publisher ${ingest.publisher.state.name}`,
  });
  return ingest;
}

function distinctIds(drained: readonly QueueMessage[]): Set<string> {
  return new Set(drained.map((message) => message.properties.message_id ?? ''));
}

function identities(sent: readonly TelemetryMessage[]): Set<string> {
  return new Set(sent.map((message) => messageIdentity(message)));
}

type Sender = { device: TestDevice; build: MessageBuilder };

/** One status per device every 20 ms until stopped; `sent` grows as it goes. */
function startSending(
  senders: readonly Sender[],
  signal: AbortSignal,
): { sent: TelemetryMessage[]; stop(): Promise<void> } {
  const sent: TelemetryMessage[] = [];
  let running = true;
  let seq = 0;
  const loop = (async () => {
    while (running) {
      seq += 1;
      for (const { device, build } of senders) {
        const message = build.status(seq);
        device.sendMessage(message);
        sent.push(message);
      }
      try {
        await sleep(20, undefined, { signal });
      } catch {
        running = false;
      }
    }
  })();
  return {
    sent,
    stop: async () => {
      running = false;
      await loop;
    },
  };
}

describe('ingest publisher against RabbitMQ', () => {
  it('I1 a valid message is published with the contract properties and confirmed', async ({
    signal,
  }) => {
    const env = environment(signal);
    const ingest = await startIngest(env);
    const device = await connectDevice(env, ingest.port);
    const message = messages('i1-device', SESSION_A).status(1);
    const before = Date.now();
    device.sendMessage(message);
    await env.waitFor(async () => (await queueDepth(env))?.ready === 1, {
      describe: () => `stats ${JSON.stringify(ingest.stats())}`,
    });

    const [published, ...rest] = await env.management.getMessages(TELEMETRY_QUEUE, 2);
    expect(rest).toEqual([]);
    expect(published?.properties).toMatchObject({
      message_id: messageIdentity(message),
      content_type: 'application/json',
      delivery_mode: 2,
    });
    const timestamp = published?.properties.timestamp;
    expect(timestamp).toBeGreaterThanOrEqual(Math.floor(before / 1000));
    expect(timestamp).toBeLessThanOrEqual(Math.ceil(Date.now() / 1000));
    const receivedAt = published?.properties.headers?.['x-received-at'];
    expect(typeof receivedAt).toBe('number');
    expect(receivedAt).toBeGreaterThanOrEqual(before);
    expect(JSON.parse(published?.payload ?? 'null')).toEqual(message);
    expect(ingest.stats().confirmed).toBe(1);
  });

  it('I2 a broker restart while devices send loses nothing', async ({ signal }) => {
    const env = environment(signal);
    const ingest = await readyIngest(env, { AMQP_HEARTBEAT_S: '1' });
    const senders = await Promise.all(
      ['i2-a', 'i2-b', 'i2-c'].map(async (deviceId) => ({
        device: await connectDevice(env, ingest.port),
        build: messages(deviceId, SESSION_A),
      })),
    );
    const sending = startSending(senders, env.signal);
    try {
      // A threshold read while messages still move is `≥` (decision 13).
      await env.waitFor(() => ingest.stats().confirmed >= 20, {
        describe: () => `confirmed ${String(ingest.stats().confirmed)}`,
      });
      const restarting = restart(env, 'rabbitmq');
      // Not ready at least once during the restart, polled while the restart runs.
      await env.waitFor(async () => (await ingest.readiness()).status === 503, {
        timeoutMs: 15_000,
        describe: () => `publisher ${ingest.publisher.state.name}`,
      });
      await restarting;
      await env.waitFor(() => ingest.publisher.state.name === 'ready', {
        describe: () => `publisher ${ingest.publisher.state.name}`,
      });
      const target = sending.sent.length + 3 * 20;
      await env.waitFor(() => sending.sent.length >= target);
    } finally {
      await sending.stop();
    }
    const sent = identities(sending.sent);
    await env.waitFor(
      () => {
        const stats = ingest.stats();
        return stats.unconfirmed === 0 && stats.confirmed === sent.size;
      },
      { describe: () => `stats ${JSON.stringify(ingest.stats())}, sent ${String(sent.size)}` },
    );

    const reconnects = ingest.logs.filter(byMsg('publisher reconnect scheduled'));
    const reasons = reconnects.map((line) => String(line['reason']));
    expect(
      reasons.some((reason) => RECYCLE_REASONS.includes(reason)),
      reasons.join(','),
    ).toBe(true);
    // Every backoff line names one of the three known reasons: the recycle, or a failed attempt.
    expect(
      reasons.every((reason) => BACKOFF_REASONS.includes(reason)),
      reasons.join(','),
    ).toBe(true);
    expect(reconnects.every((line) => line.level === WARN_LEVEL)).toBe(true);
    const drained = await env.management.getMessages(TELEMETRY_QUEUE, 2 * sending.sent.length);
    expect(distinctIds(drained)).toEqual(sent);
    // Extra copies are at-least-once delivery, expected; `republished` is reported, not asserted.
    expect(
      drained.length,
      `drained ${String(drained.length)}, republished ${String(ingest.stats().republished)}`,
    ).toBeGreaterThanOrEqual(sent.size);
  }, 45_000);

  it('I3 a deleted queue is declared again and the returned message is published again', async ({
    signal,
  }) => {
    const env = environment(signal);
    const ingest = await readyIngest(env);
    await env.management.deleteQueue(TELEMETRY_QUEUE);
    const device = await connectDevice(env, ingest.port);
    const message = messages('i3-device', SESSION_A).status(1);
    device.sendMessage(message);
    await env.waitFor(() => ingest.stats().returned >= 1, {
      describe: () => `stats ${JSON.stringify(ingest.stats())}`,
    });
    // `undefined` until ingest has declared the queue again: the live check is the existence proof.
    await env.waitFor(async () => ((await queueDepth(env))?.ready ?? 0) >= 1, {
      describe: () => `stats ${JSON.stringify(ingest.stats())}`,
    });

    const returned = ingest.logs.filter(byMsg('message returned'));
    expect(returned).toHaveLength(1);
    expect(returned[0]).toMatchObject({ level: ERROR_LEVEL, deviceId: 'i3-device', seq: 1 });
    const drained = await env.management.getMessages(TELEMETRY_QUEUE, 2);
    expect(distinctIds(drained)).toEqual(new Set([messageIdentity(message)]));
  });

  it('I4 a resource alarm blocks publishing and the block clears with the alarm', async ({
    signal,
  }) => {
    const env = environment(signal);
    const ingest = await readyIngest(env, { AMQP_HEARTBEAT_S: '1' });
    const recover = await raiseMemoryAlarm(env);
    const device = await connectDevice(env, ingest.port);
    const build = messages('i4-device', SESSION_A);
    const sent = [1, 2, 3, 4, 5].map((seq) => build.status(seq));
    for (const message of sent) {
      device.sendMessage(message);
    }
    await ingest.logs.waitForLine(byMsg('connection blocked'));
    expect(await ingest.readiness()).toEqual({
      status: 503,
      body: { status: 'not_ready', reason: 'blocked' },
    });
    expect(await env.management.alarms()).toBe(503);
    // The duration of the fault, not a wait for an outcome: longer than two heartbeats (decision 13).
    await sleep(3_000, undefined, { signal: env.signal });
    await recover();
    await env.waitFor(() => ingest.publisher.isReady, {
      describe: () => `publisher ${JSON.stringify(ingest.publisher.state)}`,
    });
    await env.waitFor(
      async () => ingest.stats().unconfirmed === 0 && ((await queueDepth(env))?.ready ?? 0) >= 5,
      { describe: () => `stats ${JSON.stringify(ingest.stats())}` },
    );

    expect(await env.management.alarms()).toBe(200);
    // Extra copies allowed: a heartbeat-driven reconnect during the alarm republishes the five.
    const drained = await env.management.getMessages(TELEMETRY_QUEUE, 10);
    expect(distinctIds(drained)).toEqual(identities(sent));
  });

  it('I5 SIGTERM with devices connected: close 1001 to every device, exit 0', async ({
    signal,
  }) => {
    const env = environment(signal);
    const [ingestPort = 0, healthPort = 0] = await freePorts(2);
    const shutdownTimeoutMs = 2_000;
    const child = spawnService(env, {
      app: 'ingest',
      variables: {
        RABBITMQ_URL: env.amqpUrl,
        INGEST_HOST: '127.0.0.1',
        INGEST_PORT: String(ingestPort),
        HEALTH_PORT: String(healthPort),
        SHUTDOWN_TIMEOUT_MS: String(shutdownTimeoutMs),
        LOG_LEVEL: 'debug',
      },
    });
    await child.waitForLog('publisher connected');
    const devices = await Promise.all([
      connectDevice(env, ingestPort),
      connectDevice(env, ingestPort),
    ]);
    await env.waitFor(() => child.logs.filter(byMsg('connection accepted')).length >= 2, {
      describe: () => child.logs.messages().join(' | '),
    });

    const signalledAt = performance.now();
    child.kill('SIGTERM');
    const closes = await Promise.all(devices.map((device) => device.closed));
    const exit = await child.closed;
    const lifetimeMs = performance.now() - signalledAt;

    expect(closes.map((close) => close.code)).toEqual([1001, 1001]);
    expect(exit, child.diagnostics()).toEqual({ code: 0, signal: null });
    expect(lifetimeMs).toBeLessThan(shutdownTimeoutMs + AMQP_CLOSE_TIMEOUT_MS + 2_000);
    const lifecycle = ['shutting down', 'publisher stopping', 'stopped'];
    expect(child.logs.messages().filter((msg) => lifecycle.includes(msg))).toEqual(lifecycle);
    expect(child.logs.find(byMsg('shutdown drain ended at its budget'))).toBeUndefined();
  });

  it('I6 invalid frames never reach the queue and the connection stays open', async ({
    signal,
  }) => {
    const env = environment(signal);
    const ingest = await readyIngest(env);
    const device = await connectDevice(env, ingest.port);
    const build = messages('i6-device', SESSION_A);
    const valid = build.status(1);
    device.send('not json');
    device.send(JSON.stringify({ ...build.status(1), seq: -1 }));
    device.sendMessage(valid);
    // Frames of one connection are decoded in order and a rejection happens before the next frame
    // is read, so the valid message's arrival proves the two before it were rejected.
    await env.waitFor(async () => (await queueDepth(env))?.ready === 1, {
      describe: () => `stats ${JSON.stringify(ingest.stats())}`,
    });

    const drained = await env.management.getMessages(TELEMETRY_QUEUE, 3);
    expect(distinctIds(drained)).toEqual(new Set([messageIdentity(valid)]));
    expect(drained).toHaveLength(1);
    expect(ingest.server.stats().rejected).toBe(2);
    const rejected = ingest.logs.filter(byMsg('message rejected'));
    expect(rejected.map((line) => [line.level, line['reason']])).toEqual([
      [WARN_LEVEL, 'invalid_json'],
      [WARN_LEVEL, 'invalid_schema'],
    ]);
    expect(device.ws.readyState).toBe(WebSocket.OPEN);
    device.sendMessage(build.status(2));
    await env.waitFor(() => ingest.stats().confirmed === 2, {
      describe: () => `stats ${JSON.stringify(ingest.stats())}`,
    });
  });

  it('I7 a frozen broker with messages in flight: recycle and republish all five', async ({
    signal,
  }) => {
    const env = environment(signal);
    const ingest = await readyIngest(env, { AMQP_HEARTBEAT_S: '1' });
    const recover = await pause(env, 'rabbitmq');
    const device = await connectDevice(env, ingest.port);
    const build = messages('i7-device', SESSION_A);
    const sent = [1, 2, 3, 4, 5].map((seq) => build.status(seq));
    for (const message of sent) {
      device.sendMessage(message);
    }
    // All five went into the paused broker: published, none confirmed.
    await env.waitFor(() => ingest.stats().unconfirmed === 5, {
      describe: () => `stats ${JSON.stringify(ingest.stats())}`,
    });
    await ingest.logs.waitForLine(byMsg('publisher reconnect scheduled'), 5_000);
    expect((await ingest.readiness()).status).toBe(503);
    await recover();
    await env.waitFor(() => ingest.publisher.state.name === 'ready', {
      describe: () => `publisher ${ingest.publisher.state.name}`,
    });
    await env.waitFor(
      async () => ingest.stats().unconfirmed === 0 && ((await queueDepth(env))?.ready ?? 0) >= 5,
      { describe: () => `stats ${JSON.stringify(ingest.stats())}` },
    );

    expect(ingest.stats().republished).toBe(5);
    const drained = await env.management.getMessages(TELEMETRY_QUEUE, 10);
    expect(distinctIds(drained)).toEqual(identities(sent));
  });
});
```

- [ ] `pnpm test:integration test/integration/ingest-publisher.test.ts` → 7 passed. Note the durations of I2, I4 and I7 from the reporter (expected 5–8 s, 4–6 s, 3–6 s). Afterwards `docker compose -f docker-compose.test.yml ps -aq | wc -l` → 0.
- [ ] The recovery of a fault survives a failing test: with a hand-started stack (`docker compose -f docker-compose.test.yml up -d --wait`), run `pnpm test:integration test/integration/ingest-publisher.test.ts -t I7`, then `docker compose -f docker-compose.test.yml ps --services --status paused | wc -l` → 0 and `curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:15673/api/overview` → `401` (the broker is unpaused and answering); `docker compose -f docker-compose.test.yml down -v`.
- [ ] `pnpm typecheck && pnpm lint && pnpm exec prettier --check test/harness test/integration`.
- [ ] Commit `test/harness/stack.ts` and the test file — subject: `Add the ingest publisher integration tests`.

What fails it (A8): I1 — a publish without `messageId` or with `persistent: false` (`delivery_mode` 1). I2 — a recycle that drops the ledger instead of marking it pending (an identity missing from the drained set), or a confirm counted for a stale generation (`confirmed` above the distinct count, the wait times out with the numbers). I3 — a return that does not trigger a recycle (the message never reaches a queue; `queueDepth` stays `undefined`). I4 — a blocked connection reported as ready (the readiness body would be `ready`), or a reading rule that keeps reading while blocked (nothing observable here but the five would sit unconfirmed past the alarm: the second wait fails on `unconfirmed`). I5 — a drain that terminates devices without the close handshake (code 1006 instead of 1001), or a lifecycle that exits before `publisher stopping`. I6 — a decoder that accepts `seq: -1` (`rejected` 1, two messages drained) or a connection closed on a bad frame (`readyState` not OPEN). I7 — a confirm-stall or heartbeat recycle that republishes only part of the ledger (`republished` below 5) or none (`unconfirmed` never 0).

### Task 9: Consumer tests without an infrastructure fault — C6, C7, C12, C13, C14 [integration]

**Files:** Create `test/integration/processing-consumer.test.ts`
**Invariant:** 2 (C13, C14: a second delivery after a partial first processing completes the missing effects exactly once and repeats nothing; C7: a rejected message dead-letters once), 3 (C13, C14: each of the three writes is independently idempotent; C6: the conditional upsert under two instances and a hot device), 4 and 6 (C6: two instances share the queue, both receive, one consistent result). C12 proves the wrong-credentials path of the store and the redaction of the connection string.
**Verify:** `pnpm test:integration test/integration/processing-consumer.test.ts` → 5 passed; `pnpm typecheck && pnpm lint && pnpm exec prettier --check test/integration`.

- [ ] Create `test/integration/processing-consumer.test.ts`:

```ts
import {
  DEAD_LETTER_QUEUE,
  MAX_FRAME_BYTES,
  TELEMETRY_QUEUE,
  messageIdentity,
  type TelemetryMessage,
} from '@telemetry/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  SESSION_A,
  deleteAlertDocument,
  deleteStateDocument,
  identitiesOf,
  messages,
  openDirectPublisher,
  queueDepth,
  readAlerts,
  readEvents,
  readState,
  sectionKey,
  stateMismatches,
  type DirectPublisher,
  type MessageBuilder,
} from '../harness/clients.js';
import {
  bindEnvironment,
  createEnvironment,
  type TestEnvironment,
} from '../harness/environment.js';
import { generateLoad } from '../harness/load.js';
import {
  startProcessing,
  type ProcessingInstance,
  type StartProcessingOptions,
} from '../harness/services.js';
import { WARN_LEVEL, byMsg } from '../harness/wait.js';

/** The consumer's `AMQP_CLOSE_TIMEOUT_MS` and the store's default `MONGODB_TIMEOUT_MS`: terms of the shutdown bounds. */
const AMQP_CLOSE_TIMEOUT_MS = 2_000;
const MONGODB_TIMEOUT_MS = 5_000;

let created: TestEnvironment | undefined;

beforeEach(async () => {
  created = await createEnvironment();
});

afterEach(async () => {
  const current = created;
  created = undefined;
  await current?.dispose();
});

const environment = (signal: AbortSignal): TestEnvironment => bindEnvironment(created, signal);

/** A processing instance whose consumer is registered, so it receives what the test publishes next. */
async function registeredProcessing(
  context: TestEnvironment,
  options: StartProcessingOptions = {},
): Promise<ProcessingInstance> {
  const instance = await startProcessing(context, options);
  await instance.logs.waitForLine(byMsg('consumer registered'));
  return instance;
}

/** In order, each confirmed before the next goes out. */
async function publishAll(
  publisher: DirectPublisher,
  sends: readonly TelemetryMessage[],
): Promise<void> {
  for (const message of sends) {
    await publisher.publish(message);
  }
}

function identities(sent: readonly TelemetryMessage[]): Set<string> {
  return new Set(sent.map((message) => messageIdentity(message)));
}

/** status, metrics, counters, info diagnostic, in rotation by `seq`. */
function rotating(build: MessageBuilder, seq: number): TelemetryMessage {
  switch (seq % 4) {
    case 1:
      return build.status(seq);
    case 2:
      return build.metrics(seq);
    case 3:
      return build.counters(seq);
    default:
      return build.diagnostic(seq, { severity: 'info' });
  }
}

describe('processing consumer against RabbitMQ and MongoDB', () => {
  it('C6 two instances on one queue end in one consistent state', async ({ signal }) => {
    const env = environment(signal);
    const a = await registeredProcessing(env, { hostname: 'a' });
    const b = await registeredProcessing(env, { hostname: 'b' });
    const { sends, expected } = generateLoad({
      devices: 20,
      messages: 1000,
      hotShare: 0.25,
      duplicatePercent: 5,
      swapPercent: 5,
      seed: 2,
    });
    const publisher = await openDirectPublisher(env);
    await publishAll(publisher, sends);
    await env.waitFor(
      () => {
        const [sa, sb] = [a.stats(), b.stats()];
        return sa.acked + sb.acked === sends.length && sa.inFlight === 0 && sb.inFlight === 0;
      },
      { describe: () => `a ${JSON.stringify(a.stats())}, b ${JSON.stringify(b.stats())}` },
    );

    const events = await readEvents(env);
    expect(identitiesOf(events)).toEqual(expected.identities);
    expect(events).toHaveLength(expected.identities.size);
    expect(await stateMismatches(env, expected)).toEqual([]);
    expect(new Set((await readAlerts(env)).map((alert) => alert._id))).toEqual(expected.alerts);
    const [sa, sb] = [a.stats(), b.stats()];
    const detail = `a ${JSON.stringify(sa)}, b ${JSON.stringify(sb)}`;
    expect(sa.received, detail).toBeGreaterThan(0);
    expect(sb.received, detail).toBeGreaterThan(0);
    expect(sa.duplicate + sb.duplicate, detail).toBeGreaterThanOrEqual(expected.duplicates);
    expect([sa.failed, sb.failed], detail).toEqual([0, 0]);
  }, 60_000);

  it('C7 poison bodies are dead-lettered once, with nothing stored', async ({ signal }) => {
    const env = environment(signal);
    const processing = await registeredProcessing(env);
    const publisher = await openDirectPublisher(env);
    const build = messages('c7-device', SESSION_A);
    const text = JSON.stringify(build.diagnostic(3, { message: 'bad byte follows' }));
    const cut = text.indexOf('follows');
    const invalidUtf8 = Buffer.concat([
      Buffer.from(text.slice(0, cut), 'utf8'),
      Buffer.from([0xff]),
      Buffer.from(text.slice(cut), 'utf8'),
    ]);
    const bodies: [string, Buffer][] = [
      ['invalid_json', Buffer.from('not json', 'utf8')],
      ['invalid_schema', Buffer.from(JSON.stringify({ ...build.status(2), seq: -1 }), 'utf8')],
      ['invalid_utf8', invalidUtf8],
      // 70 KiB: above the 64 KiB frame bound, which processing applies to the AMQP body as well.
      ['body_too_large', Buffer.alloc(MAX_FRAME_BYTES + 6 * 1024, 0x20)],
    ];
    for (const [, body] of bodies) {
      await publisher.publishRaw(body, { contentType: 'application/json' });
    }
    await env.waitFor(async () => (await queueDepth(env, DEAD_LETTER_QUEUE))?.ready === 4, {
      describe: () => `stats ${JSON.stringify(processing.stats())}`,
    });

    const dead = await env.management.getMessages(DEAD_LETTER_QUEUE, 4);
    expect(dead).toHaveLength(4);
    for (const message of dead) {
      const deaths = message.properties.headers?.['x-death'] as
        { reason?: string; queue?: string }[] | undefined;
      // `rejected`, never `delivery_limit`: rejected once, never requeued and retried.
      expect(deaths?.[0]).toMatchObject({ reason: 'rejected', queue: TELEMETRY_QUEUE });
    }
    expect(await readEvents(env)).toEqual([]);
    expect(await readAlerts(env)).toEqual([]);
    expect(await readState(env, 'c7-device')).toBeNull();
    const rejected = processing.logs.filter(byMsg('message rejected'));
    expect(rejected).toHaveLength(4);
    expect(rejected.every((line) => line.level === WARN_LEVEL)).toBe(true);
    expect(new Set(rejected.map((line) => line['reason']))).toEqual(
      new Set(bodies.map(([reason]) => reason)),
    );
    expect(processing.stats()).toMatchObject({ rejected: 4, failed: 0, acked: 0 });
  });

  it('C12 wrong database credentials: not ready, still linked to the broker, stoppable', async ({
    signal,
  }) => {
    const env = environment(signal);
    const wrong = await startProcessing(env, { overrides: { MONGODB_URL: env.wrongMongoUrl } });
    await env.waitFor(() => wrong.logs.filter(byMsg('store not ready')).length >= 3, {
      describe: () => wrong.logs.messages().join(' | '),
    });

    const notReady = wrong.logs.filter(byMsg('store not ready'));
    expect(notReady.every((line) => line.level === WARN_LEVEL)).toBe(true);
    expect(notReady[0]).toMatchObject({ failure: { kind: 'server', code: 18 } });
    expect(await wrong.readiness()).toEqual({
      status: 503,
      body: { status: 'not_ready', reason: 'mongodb' },
    });
    expect(['connecting', 'open']).toContain(wrong.consumer.state.name);
    // The wrong password is the right one with `-wrong` appended; no line may carry it.
    expect(JSON.stringify(wrong.logs.lines())).not.toContain('-wrong');
    const startedAt = performance.now();
    await wrong.stop();
    expect(performance.now() - startedAt).toBeLessThan(MONGODB_TIMEOUT_MS);
    const right = await startProcessing(env);
    await env.waitFor(async () => (await right.readiness()).status === 200, {
      describe: () => `state ${JSON.stringify(right.consumer.state)}`,
    });
  });

  it('C13 a redelivery after a crash between the event insert and the state update completes both missing writes once', async ({
    signal,
  }) => {
    const env = environment(signal);
    const processing = await registeredProcessing(env);
    const publisher = await openDirectPublisher(env);
    const message = messages('c13-device', SESSION_A).diagnostic(1, { severity: 'error' });
    const identity = messageIdentity(message);
    await publisher.publish(message);
    await env.awaitAcked(processing, 1);
    // The crash: the event is stored, the state and the alert are not.
    await deleteStateDocument(env, 'c13-device');
    await deleteAlertDocument(env, identity);
    await publisher.publish(message);
    await env.awaitAcked(processing, 2);

    const state = await readState(env, 'c13-device');
    expect(sectionKey(state, 'diagnostic')).toEqual({ sessionId: SESSION_A, seq: 1 });
    expect(state?.lastEvent).toMatchObject({ sessionId: SESSION_A, seq: 1 });
    expect((await readAlerts(env)).map((alert) => alert._id)).toEqual([identity]);
    expect(await readEvents(env)).toHaveLength(1);
    const stats = processing.stats();
    expect(stats, `stats ${JSON.stringify(stats)}`).toMatchObject({
      duplicate: 1,
      created: 2,
      alerts: 2,
      failed: 0,
    });
  });

  it('C14 a redelivery after a crash between the state update and the alert insert creates the alert once and leaves the state as it was', async ({
    signal,
  }) => {
    const env = environment(signal);
    const processing = await registeredProcessing(env);
    const publisher = await openDirectPublisher(env);
    const message = messages('c14-device', SESSION_A).diagnostic(1, { severity: 'error' });
    const identity = messageIdentity(message);
    await publisher.publish(message);
    await env.awaitAcked(processing, 1);
    const before = await readState(env, 'c14-device');
    expect(before).not.toBeNull();
    // The crash: the event and the state are stored, the alert is not.
    await deleteAlertDocument(env, identity);
    await publisher.publish(message);
    await env.awaitAcked(processing, 2);

    expect((await readAlerts(env)).map((alert) => alert._id)).toEqual([identity]);
    expect(await readState(env, 'c14-device')).toEqual(before);
    expect(await readEvents(env)).toHaveLength(1);
    const stats = processing.stats();
    expect(stats, `stats ${JSON.stringify(stats)}`).toMatchObject({
      duplicate: 1,
      stale: 1,
      alerts: 2,
      failed: 0,
    });
  });
});
```

- [ ] `pnpm test:integration test/integration/processing-consumer.test.ts` → 5 passed. Afterwards `docker compose -f docker-compose.test.yml ps -aq | wc -l` → 0.
- [ ] `pnpm typecheck && pnpm lint && pnpm exec prettier --check test/integration`.
- [ ] Commit — subject: `Add the consumer integration tests without infrastructure faults`.

What fails it (A8): C6 — a prefetch set globally (quorum queues refuse it: no `consumer registered` on the second instance), or a state update that reads then writes (a lost update on the hot device: a section key below the expected in `stateMismatches`). C7 — a `nack` with `requeue: true` on a decode failure (`x-death.reason` `delivery_limit`, `rejected` 20), or a body bound applied after the JSON parse (a 70 KiB body accepted or slow). C12 — a `ConfigError`-style exit on a wrong password instead of the retry loop (fewer than three lines, no `stop()` to call), or a `store not ready` line carrying the driver's message with the URL (the `-wrong` check). C13 — a handler that returns early when the event insert is a duplicate (`created` 1, no state document, no alert: the regression every other test passes). C14 — an alert insert skipped on a `stale` outcome (`alerts` 1, no alert document).

### Task 10: Consumer tests with faults and signals — C8, C9, C10, C11, C11b, C11c, C15 [integration]

**Files:** Modify `test/integration/processing-consumer.test.ts`
**Invariant:** 2 (C8, C9: an outage's redeliveries are absorbed, every event once; C10: every identity once across a reconnection), 6 (C11b: a stopped instance acknowledges exactly what it held and the next instance receives exactly the rest; C15: a consumer started against a restarted broker finds every confirmed message; C11: the signal path exits 0 with the consumer cancelled; C11c: `stop()` returns at its bound with the registration pending), 3 (C8–C11b: the same conditional writes under redelivery).
**Verify:** `pnpm test:integration test/integration/processing-consumer.test.ts` → 12 passed; then `pnpm test:integration` → 25 passed; `pnpm typecheck && pnpm lint && pnpm exec prettier --check test/integration`.

- [ ] Add to the imports of the file: `holdInserts` and `type QueueDepth` from `../harness/clients.js`, `mergeExpected` from `../harness/load.js`, `freePorts` and `spawnService` from `../harness/services.js`, `type LogLine` next to `byMsg` from `../harness/wait.js`, and `import { pause, restart, stop } from '../harness/stack.js';`. Add below the `rotating` helper:

```ts
/** The store failure of a timed-out operation against a frozen server: the socket timeout, or the server's MaxTimeMSExpired (50). */
function isTimeoutFailure(failure: unknown): boolean {
  if (typeof failure !== 'object' || failure === null) {
    return false;
  }
  const { kind, code } = failure as { kind?: unknown; code?: unknown };
  return kind === 'network' || (kind === 'server' && code === 50);
}

/** The keys `rotating` leaves per section after `count` messages of one device. */
function rotatingKeys(
  count: number,
): Record<'status' | 'metrics' | 'counters' | 'diagnostic', number> {
  const highest = (remainder: number): number => {
    let seq = count;
    while (seq > 0 && seq % 4 !== remainder) {
      seq -= 1;
    }
    return seq;
  };
  return { status: highest(1), metrics: highest(2), counters: highest(3), diagnostic: highest(0) };
}
```

- [ ] Append inside the `describe` block, after C14:

```ts
it('C8 MongoDB stopped, then back: the consumer pauses, returns what it holds and resumes', async ({
  signal,
}) => {
  const env = environment(signal);
  // Shorter than the defaults (5 000 ms, 5 attempts): every attempt against a stopped server
  // waits the whole server selection timeout, and the pause must arrive inside the budget.
  const processing = await registeredProcessing(env, {
    overrides: { MONGODB_TIMEOUT_MS: '1000', PROCESSING_TRANSIENT_ATTEMPTS: '3' },
  });
  await env.waitFor(async () => (await processing.readiness()).status === 200, {
    describe: () => `state ${JSON.stringify(processing.consumer.state)}`,
  });
  const recover = await stop(env, 'mongodb');
  const publisher = await openDirectPublisher(env);
  const builds = [messages('c8-a', SESSION_A), messages('c8-b', SESSION_A)];
  const sends = Array.from({ length: 15 }, (_, index) => index + 1).flatMap((seq) =>
    builds.map((build) => rotating(build, seq)),
  );
  await publishAll(publisher, sends);

  const paused = await processing.logs.waitForLine(byMsg('consumer paused'));
  const returned = Number(paused['returned']);
  expect(paused.level).toBe(WARN_LEVEL);
  expect(returned).toBeGreaterThanOrEqual(1);
  expect(await processing.readiness()).toEqual({
    status: 503,
    body: { status: 'not_ready', reason: 'mongodb' },
  });
  await env.waitFor(async () => ((await queueDepth(env))?.ready ?? 0) >= returned, {
    describe: () => `returned ${String(returned)}, stats ${JSON.stringify(processing.stats())}`,
  });
  await recover();
  // The second `store ready` (the first was the startup) and the second registration.
  await env.waitFor(() => processing.logs.filter(byMsg('store ready')).length >= 2, {
    timeoutMs: 25_000,
    describe: () => processing.logs.messages().slice(-8).join(' | '),
  });
  await env.waitFor(() => processing.logs.filter(byMsg('consumer registered')).length >= 2, {
    describe: () => `state ${JSON.stringify(processing.consumer.state)}`,
  });
  await env.awaitAcked(processing, 30);

  const events = await readEvents(env);
  expect(identitiesOf(events)).toEqual(identities(sends));
  expect(events).toHaveLength(30);
  const keys = rotatingKeys(15);
  for (const deviceId of ['c8-a', 'c8-b']) {
    const state = await readState(env, deviceId);
    for (const type of ['status', 'metrics', 'counters', 'diagnostic'] as const) {
      expect(sectionKey(state, type), `${deviceId}.${type}`).toEqual({
        sessionId: SESSION_A,
        seq: keys[type],
      });
    }
    expect(state?.lastEvent).toMatchObject({ sessionId: SESSION_A, seq: 15 });
  }
  expect(processing.stats().failed).toBe(0);
}, 45_000);

it('C9 MongoDB frozen: the timeout is transient, the consumer pauses and resumes after the unpause', async ({
  signal,
}) => {
  const env = environment(signal);
  const timeoutMs = 1_000;
  const processing = await registeredProcessing(env, {
    overrides: { MONGODB_TIMEOUT_MS: String(timeoutMs), PROCESSING_TRANSIENT_ATTEMPTS: '3' },
  });
  await env.waitFor(async () => (await processing.readiness()).status === 200, {
    describe: () => `state ${JSON.stringify(processing.consumer.state)}`,
  });
  const pausedAt = performance.now();
  const recover = await pause(env, 'mongodb');
  const publisher = await openDirectPublisher(env);
  const build = messages('c9-device', SESSION_A);
  const sends = Array.from({ length: 10 }, (_, index) => rotating(build, index + 1));
  await publishAll(publisher, sends);

  const failure = await processing.logs.waitForLine(
    (line) => line.msg === 'transient store failure' && isTimeoutFailure(line['failure']),
    3 * timeoutMs + 2_000,
  );
  expect(failure.level).toBe(WARN_LEVEL);
  expect(performance.now() - pausedAt).toBeLessThan(3 * timeoutMs + 2_000);
  await processing.logs.waitForLine(byMsg('consumer paused'));
  expect(await processing.readiness()).toEqual({
    status: 503,
    body: { status: 'not_ready', reason: 'mongodb' },
  });
  await recover();
  await env.waitFor(() => processing.logs.filter(byMsg('consumer registered')).length >= 2, {
    timeoutMs: 25_000,
    describe: () => `state ${JSON.stringify(processing.consumer.state)}`,
  });
  await env.awaitAcked(processing, 10);

  const events = await readEvents(env);
  expect(identitiesOf(events)).toEqual(identities(sends));
  expect(events).toHaveLength(10);
  const keys = rotatingKeys(10);
  const state = await readState(env, 'c9-device');
  for (const type of ['status', 'metrics', 'counters', 'diagnostic'] as const) {
    expect(sectionKey(state, type), type).toEqual({ sessionId: SESSION_A, seq: keys[type] });
  }
  // `duplicate` may be above zero: a write the frozen server executed after the client timed
  // out is a duplicate on the retry, which the index absorbs.
  expect(processing.stats(), JSON.stringify(processing.stats())).toMatchObject({ failed: 0 });
}, 45_000);

it('C10 a broker restart with a registered consumer: reconnection, then a second batch', async ({
  signal,
}) => {
  const env = environment(signal);
  const processing = await registeredProcessing(env);
  const shape = { devices: 10, messages: 100, hotShare: 0, duplicatePercent: 0, swapPercent: 0 };
  const batch1 = generateLoad({ ...shape, seed: 3, deviceIdPrefix: 'c10a' });
  const batch2 = generateLoad({ ...shape, seed: 4, deviceIdPrefix: 'c10b' });
  const expected = mergeExpected(batch1.expected, batch2.expected);
  // A check of the test's own arithmetic before anything is published.
  expect(expected.identities.size).toBe(200);
  expect(expected.alerts.size).toBe(20);
  const first = await openDirectPublisher(env);
  await publishAll(first, batch1.sends);
  await env.awaitAcked(processing, 100);

  const restarting = restart(env, 'rabbitmq');
  await processing.logs.waitForLine(byMsg('consumer reconnect scheduled'), 15_000);
  // Polled while the restart runs, as the spec says; the broker is down for seconds, so the
  // consumer cannot register again before this resolves.
  await env.waitFor(
    async () => {
      const report = await processing.readiness();
      return report.status === 503 && report.body.reason === 'connecting';
    },
    {
      timeoutMs: 15_000,
      describe: () => `state ${JSON.stringify(processing.consumer.state)}`,
    },
  );
  await restarting;
  await env.waitFor(() => processing.logs.filter(byMsg('consumer registered')).length >= 2, {
    timeoutMs: 25_000,
    describe: () => `state ${JSON.stringify(processing.consumer.state)}`,
  });
  // A fresh publisher: the first one's connection died with the broker.
  const second = await openDirectPublisher(env);
  await publishAll(second, batch2.sends);
  await env.awaitEndState(expected);
  await env.waitFor(() => processing.stats().inFlight === 0, {
    describe: () => `stats ${JSON.stringify(processing.stats())}`,
  });

  const events = await readEvents(env);
  expect(identitiesOf(events)).toEqual(expected.identities);
  expect(events).toHaveLength(200);
  expect(new Set((await readAlerts(env)).map((alert) => alert._id))).toEqual(expected.alerts);
  expect(await stateMismatches(env, expected)).toEqual([]);
  const stats = processing.stats();
  // `acked` above 200 would be a redelivery after an acknowledgement lost in the restart, and
  // `duplicate` counts duplicate inserts of any cause: both are in the failure text, not asserted.
  expect(stats.failed, `stats ${JSON.stringify(stats)}`).toBe(0);
  expect((await queueDepth(env))?.ready).toBe(0);
}, 45_000);

it('C11 SIGTERM on a registered instance: cancel, close, exit 0', async ({ signal }) => {
  const env = environment(signal);
  const [healthPort = 0] = await freePorts(1);
  const shutdownTimeoutMs = 2_000;
  const child = spawnService(env, {
    app: 'processing',
    variables: {
      RABBITMQ_URL: env.amqpUrl,
      MONGODB_URL: env.mongoUrl,
      MONGODB_DB: env.dbName,
      HEALTH_PORT: String(healthPort),
      SHUTDOWN_TIMEOUT_MS: String(shutdownTimeoutMs),
      LOG_LEVEL: 'debug',
    },
  });
  await child.waitForLog('consumer registered');

  const signalledAt = performance.now();
  child.kill('SIGTERM');
  const exit = await child.closed;
  const lifetimeMs = performance.now() - signalledAt;

  expect(exit, child.diagnostics()).toEqual({ code: 0, signal: null });
  expect(lifetimeMs).toBeLessThan(
    shutdownTimeoutMs + AMQP_CLOSE_TIMEOUT_MS + MONGODB_TIMEOUT_MS + 2_000,
  );
  const lifecycle = ['shutting down', 'consumer stopping', 'consumer cancel', 'stopped'];
  expect(child.logs.messages().filter((msg) => lifecycle.includes(msg))).toEqual(lifecycle);
  expect(child.logs.find(byMsg('consumer cancel'))).toMatchObject({ outcome: 'resolved' });
  expect(child.logs.find(byMsg('shutdown drain ended at its budget'))).toBeUndefined();
  let depth: QueueDepth | undefined;
  await env.waitFor(
    async () => {
      depth = await queueDepth(env);
      return depth?.consumers === 0;
    },
    { describe: () => `queue ${JSON.stringify(depth)}` },
  );
});

it('C11b a graceful drain with deliveries in flight: the held fifty are acknowledged, the next instance gets exactly the rest', async ({
  signal,
}) => {
  const env = environment(signal);
  const { sends, expected } = generateLoad({
    devices: 10,
    messages: 200,
    hotShare: 0,
    duplicatePercent: 0,
    swapPercent: 0,
    seed: 4,
  });
  expect(expected.alerts.size).toBe(20);
  const publisher = await openDirectPublisher(env);
  await publishAll(publisher, sends);
  const gate = holdInserts(env);
  const shutdownTimeoutMs = 5_000;
  const a = await registeredProcessing(env, {
    hostname: 'a',
    overrides: { SHUTDOWN_TIMEOUT_MS: String(shutdownTimeoutMs) },
    wrapStore: gate.wrap,
  });
  // The broker delivers the prefetch and nothing completes: exactly fifty in flight.
  await env.waitFor(() => a.stats().inFlight === 50, {
    describe: () => `a ${JSON.stringify(a.stats())}`,
  });

  const startedAt = performance.now();
  const stopping = a.stop();
  const cancel = await a.logs.waitForLine(byMsg('consumer cancel'));
  expect(cancel).toMatchObject({ outcome: 'resolved' });
  // No further delivery can arrive once the cancel reply is in; now the held fifty may finish.
  gate.release();
  await stopping;
  const stopMs = performance.now() - startedAt;
  expect(stopMs).toBeLessThan(
    shutdownTimeoutMs + AMQP_CLOSE_TIMEOUT_MS + MONGODB_TIMEOUT_MS + 2_000,
  );
  const b = await registeredProcessing(env, { hostname: 'b' });
  // The broker redelivers the message(s) acknowledged right before the link closed (measured
  // in the plan's probe, T70): b's count is 150 plus those, and each of them is a duplicate
  // that a had already stored.
  const redelivered = (): LogLine[] =>
    b.logs.filter((line) => line.msg === 'delivery processed' && line['redelivered'] === true);
  await env.waitFor(
    async () => {
      const stats = b.stats();
      if (stats.acked !== 150 + redelivered().length || stats.inFlight !== 0) {
        return false;
      }
      return (await queueDepth(env))?.ready === 0;
    },
    {
      describe: () => `b ${JSON.stringify(b.stats())}, redelivered ${String(redelivered().length)}`,
    },
  );

  const [sa, sb] = [a.stats(), b.stats()];
  const detail = `a ${JSON.stringify(sa)}, b ${JSON.stringify(sb)}, redelivered ${String(redelivered().length)}`;
  // A stop that does not cancel first shows as `a.acked > 50`; one that does not wait for its
  // handlers as `a.abandoned > 0` and redeliveries that are not duplicates.
  expect(sa, detail).toMatchObject({ received: 50, acked: 50, abandoned: 0, failed: 0 });
  expect(a.logs.find(byMsg('shutdown drain ended at its budget'))).toBeUndefined();
  expect(sb.received, detail).toBe(150 + redelivered().length);
  expect(sb.failed, detail).toBe(0);
  // Only acknowledgements of the one drain can be lost, and each redelivered message was stored by a.
  expect(redelivered().length, detail).toBeLessThanOrEqual(50);
  for (const line of redelivered()) {
    expect(line, detail).toMatchObject({ outcome: 'stale', duplicate: true });
  }
  const events = await readEvents(env);
  expect(identitiesOf(events)).toEqual(expected.identities);
  expect(events).toHaveLength(200);
  expect(new Set((await readAlerts(env)).map((alert) => alert._id))).toEqual(expected.alerts);
  expect(await stateMismatches(env, expected)).toEqual([]);
  expect((await queueDepth(env))?.ready).toBe(0);
}, 45_000);

it('C11c a stop with the registration pending on a frozen broker returns at its bound', async ({
  signal,
}) => {
  const env = environment(signal);
  const recoverMongo = await stop(env, 'mongodb');
  const shutdownTimeoutMs = 500;
  const instance = await startProcessing(env, {
    overrides: {
      SHUTDOWN_TIMEOUT_MS: String(shutdownTimeoutMs),
      // Long enough that the heartbeat timeout cannot end the link during the test.
      AMQP_HEARTBEAT_S: '30',
      MONGODB_TIMEOUT_MS: '1000',
    },
  });
  await instance.logs.waitForLine(byMsg('consumer connected'));
  expect(instance.consumer.state).toMatchObject({
    name: 'open',
    consumer: 'idle',
    storeReady: false,
  });
  const recoverBroker = await pause(env, 'rabbitmq');
  await recoverMongo();
  // `store ready` issues the `consume` into the paused broker; its reply never comes.
  await env.waitFor(
    () => {
      const state = instance.consumer.state;
      return state.name === 'open' && state.consumer === 'registering';
    },
    { timeoutMs: 25_000, describe: () => JSON.stringify(instance.consumer.state) },
  );

  const startedAt = performance.now();
  await instance.stop();
  const stopMs = performance.now() - startedAt;

  expect(stopMs).toBeLessThan(shutdownTimeoutMs + AMQP_CLOSE_TIMEOUT_MS + 1_000);
  const lifecycle = [
    'consumer stopping',
    'shutdown drain ended at its budget',
    'shutdown ended before the link closed',
  ];
  expect(instance.logs.messages().filter((msg) => lifecycle.includes(msg))).toEqual(lifecycle);
  expect(instance.logs.find(byMsg('consumer cancel'))).toBeUndefined();
  await recoverBroker();
  // The broker answers the pending `consume`, then the close: no consumer is left behind.
  let depth: QueueDepth | undefined;
  await env.waitFor(
    async () => {
      depth = await queueDepth(env);
      return depth?.consumers === 0;
    },
    { timeoutMs: 5_000, describe: () => `queue ${JSON.stringify(depth)}` },
  );
  expect(instance.stats().failed).toBe(0);
}, 45_000);

it('C15 confirmed messages survive a broker restart', async ({ signal }) => {
  const env = environment(signal);
  const { sends, expected } = generateLoad({
    devices: 10,
    messages: 100,
    hotShare: 0,
    duplicatePercent: 0,
    swapPercent: 0,
    seed: 5,
    deviceIdPrefix: 'c15',
  });
  expect(expected.alerts.size).toBe(10);
  // No consumer: the batch is pending in the queue across the restart.
  const publisher = await openDirectPublisher(env);
  await publishAll(publisher, sends);
  await restart(env, 'rabbitmq');
  // A fresh connection: the publisher's died with the broker.
  expect((await queueDepth(env))?.ready).toBe(100);
  const processing = await registeredProcessing(env);
  await env.awaitAcked(processing, 100);

  const events = await readEvents(env);
  expect(identitiesOf(events)).toEqual(expected.identities);
  expect(events).toHaveLength(100);
  expect(new Set((await readAlerts(env)).map((alert) => alert._id))).toEqual(expected.alerts);
  expect(await stateMismatches(env, expected)).toEqual([]);
  expect(processing.stats().failed).toBe(0);
  expect((await queueDepth(env))?.ready).toBe(0);
}, 45_000);
```

- [ ] The seven tests above are printed at the top level; once they sit inside the `describe` block, run `pnpm exec prettier --write test/integration/processing-consumer.test.ts`. The only change is the indentation (checked in the plan's probe, Research).
- [ ] `pnpm test:integration test/integration/processing-consumer.test.ts` → 12 passed. Note the durations of C8, C9, C10, C11b and C11c from the reporter.
- [ ] The recovery of a stopped and a paused MongoDB survives a failing test: with a hand-started stack, `pnpm test:integration test/integration/processing-consumer.test.ts -t C9` followed by `docker compose -f docker-compose.test.yml ps --services --status paused | wc -l` → 0 and `docker compose -f docker-compose.test.yml ps --services --status running | wc -l` → 2; `docker compose -f docker-compose.test.yml down -v`.
- [ ] `pnpm test:integration` → 25 passed in 3 files, the stack removed afterwards.
- [ ] `pnpm typecheck && pnpm lint && pnpm exec prettier --check test/integration`.
- [ ] Commit — subject: `Add the consumer fault and shutdown integration tests`.

What fails it (A8): C8 — a pause that returns the held deliveries before the handlers settled (a delivery acknowledged twice or lost: `acked` off 30, or an identity missing), or a resume without a new `consume` (no second `consumer registered`). C9 — a socket timeout classified permanent (`failed` above 0 and a dead-lettered message), or a retry without backoff that never reaches the pause (`consumer paused` never logged). C10 — a reconnect that does not register again (`consumer registered` stays at one), or a lost message on the second batch (`awaitEndState` times out with the missing counts). C11 — a lifecycle that exits before the cancel resolved (`consumer cancel` after `stopped`, or an `outcome` of `timed_out`), or a consumer left registered on the broker (`consumers` 1). C11b — a stop that closes the link without the cancel (`a.acked` below 50, and redelivered lines on b that are not `duplicate: true`), or one that abandons the held handlers (`a.abandoned` above 0). The probe found, and the test now records, that the broker redelivers the message acknowledged right before the link close (T70): a fix in the consumer (a channel close before the connection close) removed it in the probe but is outside this step's scope. C11c — the pre-fix `stop()` (waits for the heartbeat timeout: `stopMs` far above the bound, no `shutdown ended before the link closed` line). C15 — a queue declared without `durable`, or a publish without `persistent` (a `ready` count below 100 after the restart).

### Task 11: Suite timing, ledger and trade-offs [mechanical]

**Files:** Modify `TODO.md`, `docs/specs/2026-09-11-telemetry-consistency-design.md`, `docs/plans/2026-09-15-integration-tests-plan.md`
**Invariant:** none touched (documentation).
**Verify:** `pnpm format:check && pnpm lint && pnpm typecheck && pnpm test` (the full pre-flight: 889 unit tests and 25 integration tests, 914 in 46 files), then `git show --stat HEAD` lists the three files.

- [ ] Measure the suite: from a state with no `telemetry-test` container (`docker compose -f docker-compose.test.yml ps -aq | wc -l` → 0), run `time pnpm test:integration` twice and note the wall time of each run, the per-file durations the reporter prints, and the slowest five tests. Both runs must pass; the second run's wall time is the number recorded (the first may include an image pull).
- [ ] Run the full pre-flight once more, `pnpm format:check && pnpm lint && pnpm typecheck && pnpm test`, and note the total (`Tests 914 passed`, 46 files) and its wall time.
- [ ] Add to the top of this plan, above the title, a blockquote `> **Run record (Task 11), <date>.**` giving: the two `pnpm test:integration` wall times, the per-file durations, the five slowest tests with their durations, the full pre-flight's test count and wall time, and the Docker versions the runs used (`docker version --format '{{.Server.Version}}'`, `docker compose version`).
- [ ] `TODO.md`, section `## 7. Integrační testy`: insert after the heading, before the first item, one paragraph in Czech in the style of the earlier steps, with the measured numbers in place of the bracketed items:

```
Hotovo <date> podle `docs/specs/2026-09-14-integration-tests-design.md` a `docs/plans/2026-09-15-integration-tests-plan.md` (<N> commitů `<first sha>..<last sha>`, 25 integračních testů ve 3 souborech nad skutečným RabbitMQ 4.3 a MongoDB 8.0 z `docker-compose.test.yml`, plus 9 unit testů generátoru zátěže; celkem <total> testů). Testovací stack (projekt `telemetry-test`, porty 5673/15673/27018) spouští a odstraňuje `globalSetup` projektu `integration`; každý test má vlastní virtual host a databázi. Celá integrační sada trvala <seconds> s (měřeno <date>); `pnpm test:unit` běží bez Dockeru.
```

Then tick the ten items from "Infrastruktura pro integrační testy" to "Zapojit integrační testy do rootového `test` skriptu" (`- [ ]` → `- [x]`); the CI item is ticked by Task 12 when it lands.

- [ ] Consistency spec, the trade-off list: after the T55–T60 table add a blank line, the sentence ``Rows T61–T68 and T70 come from the integration tests design spec (`docs/specs/2026-09-14-integration-tests-design.md`; T69 is the processing spec's row of the same day), added when TODO step 7 landed on <date>.`` and a table with the same header as the T55–T60 table (`#`, `Compromise`, `What is given up`, `When it starts to matter`, `Upgrade path`, `Decision`) holding these rows:

| #   | Compromise                                                                      | What is given up                                                                                                                                                                                                                                                                           | When it starts to matter                                                                          | Upgrade path                                                                                                                                                                                                                                  | Decision                                  |
| --- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| T61 | Two Compose files carry the image tags and health checks twice                  | A version bump or a health-check change is two edits                                                                                                                                                                                                                                       | Whenever the infrastructure images move                                                           | `extends` with `!override` on `ports` and `volumes` in the test file                                                                                                                                                                          | integration spec, 1                       |
| T62 | Fixed test host ports 5673, 15673, 27018                                        | They collide with other local software on those ports                                                                                                                                                                                                                                      | A machine that already listens there                                                              | `TEST_AMQP_PORT`, `TEST_RABBITMQ_MANAGEMENT_PORT`, `TEST_MONGODB_PORT` in `.env`                                                                                                                                                              | integration spec, 2                       |
| T63 | One test stack per machine (fixed project name and ports)                       | Two checkouts cannot run `pnpm test` at the same time                                                                                                                                                                                                                                      | Parallel worktrees, or two CI jobs on one runner                                                  | `COMPOSE_PROJECT_NAME` and the port variables for the second run                                                                                                                                                                              | integration spec, 2 and 5                 |
| T64 | `pnpm test` needs Docker; the per-package scoped verify skips integration       | A machine without Docker runs only `pnpm test:unit`; `pnpm --filter … test` proves an application's unit tests only                                                                                                                                                                        | Any environment without a Docker daemon                                                           | `pnpm test:integration` on a Docker-capable machine or in CI                                                                                                                                                                                  | integration spec, 8 and 16                |
| T65 | The signal path is covered by two child-process tests only                      | What a process boundary adds is proven only in I5 and C11, both with the service idle; the drain with deliveries in flight is proven in-process (C11b), so "signal → drain of held deliveries → exit" is never observed as one sequence                                                    | A change to the lifecycle handlers or the entry points                                            | Run any scenario through `spawnService`; for C11b that needs a paused MongoDB as the hold and accepts the abort path                                                                                                                          | integration spec, 11                      |
| T66 | The integration project runs after the unit project                             | `pnpm test` takes the sum of the two, not the maximum                                                                                                                                                                                                                                      | Every full run                                                                                    | Remove `sequence.groupOrder` once the heartbeat-timed scenarios have shown they tolerate a busy CPU                                                                                                                                           | integration spec, 15                      |
| T67 | The memory-alarm scenario changes a broker-wide setting                         | A hard crash of the worker between the raise and the undo leaves the test broker blocked until the stack is reset                                                                                                                                                                          | A killed test run on a hand-started stack                                                         | The undo stack covers every ordinary failure; `down -v` covers the rest                                                                                                                                                                       | integration spec, 12                      |
| T68 | No measurement of the consistency mechanism's throughput cost                   | "Minimal throughput cost" rests on reasoning (single-document conditional operations, no cross-device lock), not on a benchmark                                                                                                                                                            | A capacity question in the technical discussion, or production sizing                             | A saturation benchmark of the conditional update against an unguarded write on dedicated hardware                                                                                                                                             | integration spec, 22                      |
| T70 | A graceful stop redelivers the message acknowledged right before the link close | The consumer closes the connection as soon as the last handler acknowledged; the broker (quorum queue) loses that last acknowledgement and redelivers the message to the next instance, which stores nothing new (`duplicate`, `stale`). Measured 2026-09-15 in three runs of three (C11b) | Every graceful stop with deliveries in flight: one extra delivery per stop, absorbed by the dedup | `#closeLink` closes the channel and awaits its close-ok before the connection close (removed the redelivery in two runs of two), or pauses briefly after the last acknowledgement (the same); a processing-spec decision, not a step 7 change | integration spec, 24 (amended 2026-09-15) |

- [ ] Consistency spec, rows T36 and T44: replace the `Upgrade path` cell text `The step 7 integration tests` with ``Closed <date>: `test/integration/ingest-publisher.test.ts` (I1–I7)`` for T36 and with ``Closed <date>: `test/integration/processing-consumer.test.ts` (C6–C15) and `test/integration/pipeline.test.ts` (P1–P6)`` for T44 (each cell text occurs once per row; the Edit tool's old text is the whole row up to and including that cell).
- [ ] `pnpm exec prettier --write TODO.md docs/specs/2026-09-11-telemetry-consistency-design.md docs/plans/2026-09-15-integration-tests-plan.md`, then the full pre-flight.
- [ ] Commit the three files — subject: `Tick TODO step 7 and record the integration test trade-offs`.

### Task 12: The CI workflow [mechanical] (optional, ledger item "Volitelně: CI pipeline")

**Files:** Create `.github/workflows/ci.yml`; modify `TODO.md`
**Invariant:** none touched.
**Verify:** `pnpm exec prettier --check .github/workflows/ci.yml`; the green run on the pushed commit (Verification Criteria 19) needs the user's push.

- [ ] Create `.github/workflows/ci.yml`:

```yaml
# Format, lint, typecheck, unit and integration tests on every push and pull request. The
# integration project starts its own RabbitMQ and MongoDB from docker-compose.test.yml through the
# vitest global setup; GitHub's Ubuntu runner ships Docker Engine and Compose above the floors the
# Compose spec set (Engine 25, Compose 2.20.2).
name: CI

on:
  push:
  pull_request:

jobs:
  checks:
    runs-on: ubuntu-latest
    timeout-minutes: 20
    steps:
      - uses: actions/checkout@v7
      # No `version` input: the action reads `packageManager` from package.json.
      - uses: pnpm/action-setup@v6
      - uses: actions/setup-node@v7
        with:
          node-version: 24
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm format:check
      - run: pnpm lint
      - run: pnpm typecheck
      - run: pnpm test
```

- [ ] `pnpm exec prettier --check .github/workflows/ci.yml`.
- [ ] `TODO.md`: tick `Volitelně: CI pipeline pro automatický běh testů` and append to the step 7 paragraph of Task 11 the sentence ``CI: `.github/workflows/ci.yml` (GitHub Actions, ubuntu-latest) spouští format:check, lint, typecheck a `pnpm test` včetně integračních testů.``
- [ ] Commit — subject: `Add the CI workflow`.
- [ ] After the user pushes: `gh run list --workflow CI --limit 1` shows the run, `gh run watch <id> --exit-status` exits 0. A red run is fixed forward in a commit of its own, never by loosening a test.

## Verification Criteria

| #   | Criterion                                                                                                                                                | How to verify                                                                                                                                                                                                                                                                                                                                                              |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `pnpm test:integration` starts the test stack, runs every integration file against it and removes the stack afterwards                                   | From `docker compose -f docker-compose.test.yml ps -aq \| wc -l` → 0: the run passes (25 tests, 3 files) and the same count is 0 afterwards; `docker volume ls -q --filter name=telemetry-test \| wc -l` → 0                                                                                                                                                               |
| 2   | A hand-started test stack is used and kept; a partial leftover is taken over and removed                                                                 | Task 6's two ownership checks                                                                                                                                                                                                                                                                                                                                              |
| 3   | The test stack and the development stack run side by side                                                                                                | Task 2's side-by-side check, then `pnpm test:integration` with the development stack up (passes); `docker compose down -v` afterwards                                                                                                                                                                                                                                      |
| 4   | A message passes from a device through ingest and RabbitMQ into MongoDB with every field                                                                 | P1 passes                                                                                                                                                                                                                                                                                                                                                                  |
| 5   | A duplicate message has no second effect: no second event, no counter change, no second alert                                                            | P2, C13 and C14 pass                                                                                                                                                                                                                                                                                                                                                       |
| 6   | An older message never overwrites newer state, per section and across sessions                                                                           | P3, P4 and P5 pass                                                                                                                                                                                                                                                                                                                                                         |
| 7   | Many devices in parallel end in the expected state, with swaps and duplicates absorbed                                                                   | P6 passes                                                                                                                                                                                                                                                                                                                                                                  |
| 8   | Two processing instances over one queue give one consistent result and both receive                                                                      | C6 passes                                                                                                                                                                                                                                                                                                                                                                  |
| 9   | An invalid frame is rejected, logged and never reaches the queue; the connection stays open                                                              | I6 passes; C7 covers the AMQP side (poison bodies dead-lettered once)                                                                                                                                                                                                                                                                                                      |
| 10  | The ingest publisher's seven scenarios of ingest spec decision 25 pass against the real broker                                                           | `pnpm test:integration test/integration/ingest-publisher.test.ts` → 7 passed                                                                                                                                                                                                                                                                                               |
| 11  | The consumer's scenarios 6–12 of processing spec decision 27, C11c, the recovery tests and the durability test pass against the real broker and database | `pnpm test:integration test/integration/processing-consumer.test.ts` → 12 passed                                                                                                                                                                                                                                                                                           |
| 12  | `pnpm test` runs the unit project first and the integration project after it                                                                             | The reporter lists the 43 unit files before the 3 integration files; `Tests 914 passed`                                                                                                                                                                                                                                                                                    |
| 13  | `pnpm test:unit` and the per-package scoped verify never touch Docker                                                                                    | With the Docker daemon stopped or `docker` off the `PATH` (`PATH=/usr/bin:/bin pnpm test:unit`), `pnpm test:unit` → 889 passed and `pnpm --filter @telemetry/processing test` passes                                                                                                                                                                                       |
| 14  | A fault injected by a test is undone whether the test passes or fails, and nothing of a test survives into the next one                                  | Task 8's and Task 10's single-test checks on a hand-started stack; after the whole suite on a hand-started stack, `curl -s -u <user from docker compose config> http://127.0.0.1:15673/api/vhosts` lists only `/` (run through `node -e` with the credentials read from `docker compose -f docker-compose.test.yml config --format json`, never typed on the command line) |
| 15  | `test/**` is type-checked and linted with the type-aware rules                                                                                           | Task 3's `--listFilesOnly` and `--print-config` checks; `pnpm typecheck` and `pnpm lint` exit 0                                                                                                                                                                                                                                                                            |
| 16  | The load generator's expectation is a sound oracle                                                                                                       | `pnpm vitest run --project unit test/harness/load.test.ts` → 9 passed                                                                                                                                                                                                                                                                                                      |
| 17  | The whole integration suite runs in under 180 s on this machine, twice in a row                                                                          | Task 11's two timed runs, recorded in this plan's header                                                                                                                                                                                                                                                                                                                   |
| 18  | No credential reaches the test output                                                                                                                    | `pnpm test:integration 2>&1 \| grep -c -- '-wrong'` → 0 and the same for the development placeholder password read from `docker-compose.test.yml` (`grep -c "$(sed -n 's/.*RABBITMQ_PASSWORD:-\([^}]*\)}.*/\1/p' docker-compose.test.yml \| head -1)"` → 0)                                                                                                                |
| 19  | (optional) The CI workflow is green on the pushed commit                                                                                                 | `gh run watch <id> --exit-status` exits 0 after the user's push                                                                                                                                                                                                                                                                                                            |

## Test Plan

- Unit, no Docker: Task 4's `pnpm vitest run --project unit test/harness/load.test.ts` (9 cases), and `pnpm test:unit` after Tasks 3, 4, 5 (880, then 889, then 889).
- Integration, Docker required (Tasks 2, 6–11): each test task runs its own file with `pnpm test:integration test/integration/<file>` (the global setup starts and removes the stack for that run); Task 10 runs the whole `pnpm test:integration` (25 tests). No `docker compose up` by hand is needed except for the ownership and recovery checks, which say so.
- Static, every task: `pnpm typecheck && pnpm lint && pnpm exec prettier --check <touched files>`.
- Full pre-flight before the last commit of Task 11 and again after Task 12: `pnpm format:check && pnpm lint && pnpm typecheck && pnpm test` (914 tests in 46 files).
- Two runs on one machine at the same time share the project name and the ports (T63): run the integration files one session at a time.

## Checkpoint Recovery

If interrupted mid-implementation, resume by:

1. Read this plan.
2. `git log --oneline 9f6d072..HEAD` — the subjects above name the task each commit completes; `git status` shows a task in progress.
3. `docker compose -f docker-compose.test.yml ps -aq` — a leftover stack from an interrupted run is removed with `docker compose -f docker-compose.test.yml down -v`.
4. Pick up from the first task without a commit; re-run that task's verify line before writing anything.
