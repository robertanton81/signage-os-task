> **STATUS: SHIPPED 2026-09-14.** Landed as 9 commits, `5bd6b96..00586c9`: the plan commit, one commit per task (two for Task 4: the script and its run record), the review fix `9cceec8`, the run-record update `b2edb3a` and the ledger (`00586c9`). The full pre-flight passed right before the last commit: `pnpm format:check && pnpm lint && pnpm typecheck && pnpm test`, 874 tests in 41 files (855 unchanged, 19 new in `scripts/compose-check-lib.test.mjs`). The unchecked `- [ ]` boxes below are historical — work is done. **Do not re-execute this plan.** If you're modifying the development stack, work directly in `Dockerfile`, `.dockerignore`, `docker-compose.yml`, `scripts/compose-check.mjs` and `scripts/compose-check-lib.mjs`.
>
> **Plan-vs-reality corrections discovered during execution:**
>
> **Library/version drift:** none. Docker Engine 29.4.0, Compose v5.1.2, `node:24-alpine` at Node v24.21.0, `rabbitmq:4.3-management` and `mongo:8.0` are as the spec measured; no npm package was added. `Dockerfile`, `.dockerignore` and `docker-compose.yml` are byte-identical to the spec's blocks (A3 held).
>
> **Plan code prescriptions that needed adjustment:** (1) `scripts/compose-check.mjs` resolves the Compose file with `fileURLToPath(new URL('../docker-compose.yml', import.meta.url))` instead of the plan's `.pathname`, which is percent-encoded and would hand `docker compose -f` a `%20` for a space in the repository path (`139eab0`). (2) A13 ("no vitest test of its own") did not survive review: the poll and the pass rules are pure functions, and the repository's rule gives pure logic a co-located test, so they moved to `scripts/compose-check-lib.mjs` with `scripts/compose-check-lib.test.mjs` (19 cases) and the unit project's `include` in `vitest.config.ts` gained `scripts/**/*.test.mjs` (`9cceec8`); A17's "855 tests unchanged" became 874 in 41 files. (3) Task 2's container checks 2–4 ran shell-free (`--entrypoint ls`, `--entrypoint id -un`, `--entrypoint node --version`) because the session's sandbox refuses `sh -c` inside `docker run`; the same facts were asserted with the same results. (4) The four runs were repeated on the restructured script and `b2edb3a` records both passes; the scaled split was `[5, 5]` on the first pass and `[6, 4]` on the second, as the random per-device draw predicts.
>
> **Corrections applied during review (commit `9cceec8`):** the test-quality reviewer's two BLOCKING findings on Task 4 — `waitFor`'s timeout branch and the MongoDB check's leftover-data hint had no evidence, because every recorded run passed within its budget from an empty volume — were closed by the extraction above (the timeout path with and without a last error, the surplus hint, the shortfall without it, and the last summary line winning are each a test now). The Task 3 Stage 1 reviewer reported an extra blank line at the end of `docker-compose.yml`; a byte comparison (`cmp`) against the spec's block showed one terminating newline, so nothing changed. The code reviews of Tasks 2, 3 and 4 had no BLOCKING finding.
>
> **Deferrals worth tracking:** (1) The two published ports bind to every host interface (`15672`, `27017`); a background security review flagged the exposure, the spec's decision 18 chose the ports without discussing the interface, and the fix is a `127.0.0.1:` prefix on both mappings — for the README's known limits, and a one-line spec amendment if wanted. (2) `node:24-alpine` floats within the 24.x line; pin `node:24.21.0-alpine` or a digest when reproducible builds matter. (3) No `EXPOSE` lines on the runtime targets (documentation only; Compose uses explicit URLs). (4) The script's `fetch` and `execFile` calls carry no per-call timeout, so one hung Docker call can outlast a poll budget; `AbortSignal.timeout` and `execFile`'s `timeout` would close it (attended development script, low priority). (5) The teardown in the script's `finally` is unguarded and a failing `down -v` would replace an earlier error's message. (6) A poll attempt that throws part-way through the replicas can render a spread FAIL line with fewer entries than replicas. (7) The Compose comment "a password goes into two URLs" is exact for the RabbitMQ password and one URL for the MongoDB one. (8) The step 7 seam (project name `telemetry`, ports 15672 and 27017) and the README host requirements (Docker Engine 25, Compose 2.20.2) are recorded in `TODO.md`. (9) `countsDetail` has no case for a state count that equals the fleet while the check still failed (zero events); a `>` to `>=` slip on the surplus hint would go unnoticed there — it changes the hint's wording only, never the pass/fail decision, which `countsReached` covers; the five-line test the re-review spelled out closes it.
>
> **End-to-end and scaling runs (Task 4), 2026-09-14.** `node scripts/compose-check.mjs` ran four times from this worktree against Docker Engine 29.4.0 and Docker Compose v5.1.2, each run started from a state with no `telemetry` container (`docker compose ps -aq` printed nothing) except run 2, which took over the stack run 1 had left up; after the review moved the script's pure helpers into `scripts/compose-check-lib.mjs` (`9cceec8`), all four ran again on the final script with the same outcome. The outputs of the final runs are in the main checkout's `.local/research/` as `2026-09-14-compose-check-output.txt`, `2026-09-14-compose-check-down-output.txt`, `2026-09-14-compose-check-scale-output.txt` and `2026-09-14-compose-check-devices-output.txt`; none of the four contains the development password or an `Authorization` header. The committed runner is the plan's text below with two changes: the Compose file path is resolved with `fileURLToPath` instead of `URL.pathname`, so a repository path with a space or a non-ASCII character reaches `docker compose -f` unencoded; and the poll (`waitFor`), the pass rules of the MongoDB and spread checks and the wording of their lines are imported from `compose-check-lib.mjs`, where 19 vitest cases (`compose-check-lib.test.mjs`, run by the unit project through a widened `include`) cover the branches a passing run never reaches: the timeout path with and without a last error, the leftover-data hint on a surplus of state documents, the last summary line winning over an earlier one. The ESLint block is as written; `pnpm lint` without it reported exactly the six `no-undef` errors the Research section predicts (`URL` twice, `process` twice, `Buffer`, `fetch`), and with it nothing.
>
> 1. **Cold start, default mode** (exit 0 on both passes): `PASS stack up and healthy — docker compose up --wait exited with 0`, `config: devices=10 ingest=1 processing=1`, `PASS data reaches MongoDB — device_state=10 events=21 alerts=0 expected_devices=10`, the `stack left running` line, `ALL PASS`; no line mentions a consumer or a spread; `docker compose ps -q ingest | wc -l` printed 1 afterwards with the stack still up.
> 2. **Teardown on the running stack** (`--down`, exit 0 on both passes): the `Healthy` lines repeated, the same two `PASS` lines (`events=1059 alerts=1` on the first pass, `events=645 alerts=1` on the final one), then `PASS stack down, volumes removed — docker compose down -v exited with 0` and `ALL PASS`; afterwards `docker compose ps -aq | wc -l` and `docker volume ls -q --filter name=telemetry | wc -l` both printed 0.
> 3. **Cold start, scaled, with teardown** (`--scale --down`, exit 0 on both passes): eight distinct `Healthy` containers (`ingest-1`, `ingest-2`, `processing-1` to `processing-3`, `rabbitmq-1`, `mongodb-1`, `emulator-1`), `config: devices=10 ingest=2 processing=3`, `PASS data reaches MongoDB — device_state=10 events=21 alerts=0 expected_devices=10`, `PASS one consumer per processing replica — consumers=3 expected=3`, `PASS devices spread over every ingest replica — split=[5, 5] expected_total=10` (the final pass read `events=22` and drew `split=[6, 4]`: the split is a random draw per device, so it differs from pass to pass while both halves stay above zero and sum to the fleet), the teardown `PASS`, `ALL PASS`; 0 containers and 0 volumes afterwards.
> 4. **Cold start, 25 devices, with teardown** (`EMULATOR_DEVICE_COUNT=25 … --down`, exit 0 on both passes): `config: devices=25 ingest=1 processing=1`, `PASS data reaches MongoDB — device_state=25 events=49 alerts=0 expected_devices=25` (the same counts on both passes), the teardown `PASS`, `ALL PASS`; 0 containers and 0 volumes afterwards. The variable set in the shell reached Compose through the environment the script's child processes inherit, and the Compose file's `${EMULATOR_DEVICE_COUNT:-10}` carried it into the emulator container.
>
> The negative check `node scripts/compose-check.mjs --sacle` ended on both passes with `TypeError [ERR_PARSE_ARGS_UNKNOWN_OPTION]: Unknown option '--sacle'` and exit 1, and `docker compose ps -aq | wc -l` still printed 0: nothing was started. Differences from the run text of Task 4 below: none in the assertions or in the numbers the text fixes; the event counts are whatever the first passing poll read.
>
> **Plan history below is preserved as-written for context. Treat the live code as authoritative.**

# Docker Compose Development Stack Implementation Plan

**Goal:** Package the three applications into one image with three runtime targets, wire them with RabbitMQ and MongoDB in a `docker-compose.yml` that one command starts and `--scale` widens, and commit a script that proves data reaches MongoDB, that every processing replica consumes the queue, and that devices spread across every ingest replica.

**Approach:** Five tasks in dependency order. Task 1 records two forward notes in `TODO.md` (this plan itself is committed on the branch by the `/plan` session). Tasks 2 and 3 transcribe the `Dockerfile`, `.dockerignore` and Compose file from the design spec, which ran them as written, and verify each against the real Docker daemon. Task 4 turns the rehearsal prototype into `scripts/compose-check.mjs`, adds the four Node globals the ESLint config needs for a script under `scripts/`, and runs the script four times to cover the spec's three open criteria (cold start, teardown, flag gating), both modes, and a raised device count. Task 5 ticks the ledger and appends trade-offs T55–T60. No file under `apps/` or `packages/` changes, and no test changes: the 855 tests of `b8c30c3` must still pass unchanged.

Every task gives exact paths and the full content of every new file. The Compose file, the Dockerfile and `.dockerignore` are the spec's, verbatim; the script is the prototype of the rehearsal plus the parts the spec names as new (starting and stopping the stack, the two flags).

**Design spec:** `docs/specs/2026-09-14-docker-compose-design.md` (committed in `41f30a8` on this branch; two `design-reviewer` rounds). Binding above it: `docs/specs/2026-09-11-telemetry-consistency-design.md` (the trade-off list this plan extends), `docs/specs/2026-09-13-ingest-design.md` decision 17 and `docs/specs/2026-09-13-processing-design.md` decision 19 (the `/readyz` endpoints the health checks probe), `docs/specs/2026-09-12-emulator-design.md` (the address pooling the scaling check relies on).
**TODO items:** `6. Docker Compose (vývojový)` — all six items. Step 7's first item and step 8's third item each gain a forward note in Task 1 (the test-infrastructure seam and the Docker version floor the spec asks the README to state); this plan does not execute them.
**Branch:** `worktree-compose-dev-stack` (this worktree; the spec is its first commit). Small atomic commits, imperative subjects, no `Co-Authored-By`, no AI mention. After `/verify`, `main` is fast-forwarded to the branch tip, as the WebSocket transport branch was (`2a92803`); that merge is not one of the tasks.
**Scope:** Root files only: `Dockerfile`, `.dockerignore`, `docker-compose.yml`, `scripts/compose-check.mjs`, `.env.example`, `eslint.config.js`, `TODO.md`, the consistency spec, and this plan.

## Assumptions decided without asking (standing instruction: work autonomously, log every decision)

| #   | Assumption                                                                                                                                                                                                                                                                                                                                                                          | Basis                                                                                                                                                                                                                                                             |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A1  | The work lands on `worktree-compose-dev-stack`, the branch that already carries the spec, and reaches `main` by fast-forward after `/verify`.                                                                                                                                                                                                                                       | The transport precedent (`2a92803`); the standing rule against parallel sessions on `main`.                                                                                                                                                                       |
| A2  | The plan is committed by the `/plan` session as its own commit on the branch (the spec's precedent, `41f30a8`); Task 1 then carries only the two `TODO.md` forward notes. The spec amends no earlier spec, so nothing else is applied.                                                                                                                                              | The processing precedent (Task 1 of `docs/plans/2026-09-13-processing-plan.md` added the step 7 item); the compose spec's "Forward note for step 7" and "Requirements the README must state"; a worktree can be deleted with its session, a pushed commit cannot. |
| A3  | `Dockerfile`, `.dockerignore` and `docker-compose.yml` are transcribed from the spec without change. The YAML passes the repository's Prettier config as written (checked on 2026-09-14, Research).                                                                                                                                                                                 | The spec's Research: "The Compose file in this spec was run as written."                                                                                                                                                                                          |
| A4  | `eslint.config.js` gains one block for `scripts/**/*.mjs` that declares the four Node globals the script uses (`Buffer`, `fetch`, `process`, `URL`) inline. No `globals` package.                                                                                                                                                                                                   | Measured on 2026-09-14: the current config reports six `no-undef` errors for the script text; with the block, none (Research). Four names do not justify a dependency and its vetting.                                                                            |
| A5  | The script resolves the Compose file from its own location (`new URL('../docker-compose.yml', import.meta.url)`) and passes it with `-f`, so it runs from any working directory.                                                                                                                                                                                                    | Compose resolves paths in the file and reads the `.env` file relative to the directory of the first `-f` file (Research), which is the repository root: the developer's `.env` keeps working.                                                                     |
| A6  | Flags are parsed with `util.parseArgs` in its default strict mode: `--scale` and `--down` are the only options, both boolean, and an unknown flag ends the run with the parser's error before anything starts.                                                                                                                                                                      | Node 24 `parseArgs` is stable; `strict` defaults to `true` (Research). A silent typo (`--sacle`) would otherwise run the wrong mode.                                                                                                                              |
| A7  | `up` and `down` run through `spawn` with `stdio: 'inherit'`, so the build progress and the `Healthy` lines reach the terminal unbuffered; the reads (`config`, `ps`, `exec`, `docker logs`) run through `execFile` with `maxBuffer` 64 MiB.                                                                                                                                         | The prototype captured `docker logs` with 64 MiB because the 1 MiB default terminates the child and truncates (Research); a captured `up --build` would hide minutes of progress.                                                                                 |
| A8  | A probe that throws inside `waitFor` counts as "not yet" and is retried until the budget runs out; the last error's message goes into the `FAIL` line.                                                                                                                                                                                                                              | `mongosh` exits 1 and `fetch` refuses the connection during the first seconds after `up`; the prototype let a throw propagate because it ran against a stack that had been up for minutes.                                                                        |
| A9  | The device-spread check polls too (budget 30 s): the ingest `summary` line is written every 10 s, so the first line may predate the last device's connection.                                                                                                                                                                                                                       | `apps/ingest/src/main.ts` `SUMMARY_INTERVAL_MS = 10_000`; the prototype ran minutes after startup.                                                                                                                                                                |
| A10 | Every check runs even after `up --wait` failed; the later checks then fail within their own budgets and the exit code is 1. Step 2 (the resolved configuration) is the one step the later checks cannot run without: a failure there is reported as its own `FAIL` line and ends the checks. `--down` runs in a `finally`, so a thrown error still tears the stack down when asked. | Spec, "The verification script": "the checks all run even after a failure, so one run shows every problem".                                                                                                                                                       |
| A11 | The scale counts are constants in the script (`ingest: 2`, `processing: 3`); the checks compare against the containers `docker compose ps -q` actually lists, not against the constants.                                                                                                                                                                                            | Spec decision 22's headline command; the prototype's shape.                                                                                                                                                                                                       |
| A12 | The database name `telemetry` and the collection names `device_state`, `events`, `alerts` are literals in the script, with a comment naming their source.                                                                                                                                                                                                                           | `MONGODB_DB` defaults to `telemetry` in `packages/shared/src/config.ts` and the Compose file does not override it; the collection names are `packages/shared/src/collections.ts`'s; the prototype used the same literals and passed.                              |
| A13 | The script has no vitest test of its own. Its logic (flag gating, start, teardown, log parsing) is proven by the four recorded runs of Task 4, in the same category as T44 (a scripted run, not a regression test).                                                                                                                                                                 | Spec decision 25: "Host-side Node, no dependencies"; the vitest projects include only `{apps,packages}/*`; a test harness for a Docker-driving script would be a second, larger script.                                                                           |
| A14 | The run outputs go to the main checkout's `.local/research/`, which from this worktree is `../../../.local/research/` (the worktree lives at `.claude/worktrees/compose-dev-stack/` inside the main checkout), as `2026-09-14-compose-check-output.txt`, `…-down-output.txt`, `…-scale-output.txt` and `…-devices-output.txt`; the numbers go into this plan's header.              | A worktree's `.local/` is deleted with the worktree; the processing precedent keeps evidence in the main checkout.                                                                                                                                                |
| A18 | The MongoDB check requires the `device_state` count to equal the fleet size, not to reach it, and its FAIL line shows the last counts read.                                                                                                                                                                                                                                         | Spec step 3, "one document per expected device"; `device_state` is keyed by device id, so a higher count can only be another run's leftover data, which the FAIL line then names; the prototype's `>=` could not tell the two apart.                              |
| A15 | Rows T55–T60 are appended to the consistency spec in that list's own column names (`Compromise`, `What is given up`, `When it starts to matter`, `Upgrade path`, `Decision`), introduced by one sentence in the style of the T44–T49 block, with the Decision column pointing at `compose spec, N`.                                                                                 | The T44–T49 precedent (`8195838`); the compose spec's table already follows the shape.                                                                                                                                                                            |
| A16 | The four Compose-only names go at the end of `.env.example` under a heading `# --- docker compose only ---`, with empty values.                                                                                                                                                                                                                                                     | Spec decision 21; every value in the file is empty.                                                                                                                                                                                                               |
| A17 | The test count stays at 855 in 40 files (`pnpm test` at `b8c30c3`); any other number is a regression to investigate, not to accept.                                                                                                                                                                                                                                                 | This plan adds no test and touches no source.                                                                                                                                                                                                                     |

## Research (source links)

The design spec's Research section covers Compose `depends_on`, `healthcheck` and `start_interval`, `up --wait` / `--scale`, networking under `--scale`, the embedded DNS, `init`, `stop_grace_period`, the top-level `name`, `.dockerignore`, the two infrastructure images and their first-boot credential rule, the RabbitMQ health checks, and pnpm in Docker (`--prod`, `prune`, `deploy`). Those links are not repeated. This plan adds what the script and the lint change need.

- [`docker compose` CLI, `-f`](https://docs.docker.com/reference/cli/docker/compose/#use--f-to-specify-the-name-and-path-of-one-or-more-compose-files) — "all paths in the files are relative to the first configuration file specified with `-f`"; `--project-directory` overrides. A5.
- [Compose variable interpolation, `.env` location](https://docs.docker.com/compose/how-tos/environment-variables/variable-interpolation/) — without `--env-file`, Compose loads `.env` from the project directory: "`--project-directory` if set, otherwise the directory of the first Compose file specified with `-f`/`--file`, otherwise your shell's current directory". `${VAR:-default}` is "value of `VAR` if set and non-empty, otherwise `default`", so the empty values in a copied `.env.example` fall back to the defaults. A5, A16.
- [`docker compose ps`](https://docs.docker.com/reference/cli/docker/compose/ps/) — "By default, only running containers are shown"; `-q`, `--quiet`: "Only display IDs"; `-a` includes stopped ones. Task 4 (replica ids) and the teardown criterion (`ps -a`).
- [`docker compose down`](https://docs.docker.com/reference/cli/docker/compose/down/) — `-v`, `--volumes`: "Remove named volumes declared in the `volumes` section of the Compose file and anonymous volumes attached to containers". Task 4.
- [RabbitMQ HTTP API reference](https://www.rabbitmq.com/docs/http-api-reference) — `GET /api/queues/{vhost}/{name}` "Returns metrics of a queue"; the object carries the `rabbitmqctl list_queues` fields (`consumers` among them) plus `consumer_details`; the vhost `/` is percent-encoded as `%2F`. The prototype read `consumers=3` from exactly this endpoint. Task 4.
- [Node `util.parseArgs`](https://nodejs.org/api/util.html#utilparseargsconfig) — `options.<name>.type` is `'boolean'` or `'string'`; `default` must match the type; `strict` "Should an error be thrown when unknown arguments are encountered" defaults to `true`; `args` defaults to `process.argv` "with `execPath` and `filename` removed". Stable since v20. A6.
- [Node `child_process.spawn`, `options.stdio`](https://nodejs.org/api/child_process.html#optionsstdio) — `'inherit'`: "Pass through the corresponding stdio stream to/from the parent process". [`execFile`](https://nodejs.org/api/child_process.html#child_processexecfilefile-args-options-callback) — `maxBuffer` "Largest amount of data in bytes allowed on stdout or stderr. If exceeded, the child process is terminated and any output is truncated. Default: `1024 * 1024`"; the promisified form resolves `{ stdout, stderr }` and rejects on a non-zero exit. A7.
- [WHATWG URL Standard, `username` and `password`](https://url.spec.whatwg.org/#dom-url-username) — the getters return the userinfo parts of a parsed URL, still percent-encoded, which is why the script runs `decodeURIComponent` on both before building the `Basic` header. The rehearsal prototype built the header exactly this way and the management API accepted it (`consumers=3`); Task 3 check 2 prints `u.username` as the standing check. Task 4.
- ESLint 10.10.0 with `eslint.config.js` as committed (measured on 2026-09-14): `pnpm exec eslint --stdin --stdin-filename scripts/compose-check.mjs` on the Task 4 script text reports exactly six `no-undef` errors (`process` twice, `URL` twice, `Buffer` once, `fetch` once) and nothing else; with the block of Task 4 added, exit 0. A `for (;;)` polling loop with `try`/`catch` inside lints clean under the same rules (`no-constant-condition` does not flag a loop without a test). A4.
- Prettier 3.9.6 with `.prettierrc.json` (measured on 2026-09-14): the spec's Compose YAML and the ESLint block of Task 4 both pass `prettier --check` unchanged. A3, A4.
- Docker on this host (checked 2026-09-14): Engine 29.4.0, Compose v5.1.2; `docker ps --filter name=telemetry` lists nothing, so the cold-start criterion can be run as written.
- `apps/ingest/src/server.ts:18` — `ServerStats = { open, reading, received, rejected }`; `apps/ingest/src/main.ts:84` — the `summary` line spreads `server.stats()` and `publisher.stats()` at `info` every `SUMMARY_INTERVAL_MS` (10 000). The spread check reads `open` from the last such line. A9.
- `apps/emulator/src/config.ts:85,103` — `EMULATOR_DEVICE_COUNT` (`envInt`, default 10) and `INGEST_HOSTS` (default `ingest:4000`). The script reads the count from the resolved Compose configuration, where `docker compose config --format json` renders every environment value as a string (the prototype's `Number(...)`).

## File Changes

| Action | Path                                                    | Purpose                                                                                      |
| ------ | ------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Create | `docs/plans/2026-09-14-docker-compose-plan.md`          | This plan (committed by the `/plan` session); the run evidence goes into its header (Task 4) |
| Modify | `TODO.md`                                               | Step 7 and step 8 forward notes (Task 1); step 6 ticks and note (Task 5)                     |
| Create | `Dockerfile`                                            | One multi-stage build, three runtime targets (spec decisions 2–8)                            |
| Create | `.dockerignore`                                         | Build context limited to tracked sources (decision 7)                                        |
| Create | `docker-compose.yml`                                    | The five services, health checks, volumes, environment surface (decisions 1, 9–24, 28, 29)   |
| Modify | `.env.example`                                          | The four Compose-only credential names (decision 21)                                         |
| Modify | `eslint.config.js`                                      | Node globals for `scripts/**/*.mjs` (A4)                                                     |
| Create | `scripts/compose-check.mjs`                             | The end-to-end and scaling check (decisions 25–27)                                           |
| Modify | `docs/specs/2026-09-11-telemetry-consistency-design.md` | Rows T55–T60 (Task 5)                                                                        |

## Tasks

### Task 1: Note the seams in the ledger [mechanical]

**Files:** Modify `TODO.md`
**Invariant:** none touched.
**Verify:** `pnpm format:check && git status --short` (clean after the commit)

This plan is already committed on the branch (A2), so Task 1 carries only the two forward notes the spec asks the ledger to keep: the seam step 7 must respect, and the host requirements step 8's README must state.

- [ ] `TODO.md`, step 7, first item (line 111). It currently reads:

  ```text
  - [ ] Infrastruktura pro integrační testy nad skutečnými instancemi MongoDB a RabbitMQ (oddělená od vývojového běhu).
  ```

  Replace the whole line with:

  ```text
  - [ ] Infrastruktura pro integrační testy nad skutečnými instancemi MongoDB a RabbitMQ (oddělená od vývojového běhu). Vývojový stack fixuje název projektu Compose `telemetry`, názvy front a publikované porty 15672 a 27017, takže testy potřebují jiný název projektu nebo vlastní Compose soubor (compose spec 2026-09-14, sekce Scaling).
  ```

- [ ] `TODO.md`, step 8, third item (line 127). It currently reads:

  ```text
  - [ ] Návod na spuštění systému a testů.
  ```

  Replace the whole line with:

  ```text
  - [ ] Návod na spuštění systému a testů. Uvést minimální verze na hostu: Docker Engine 25 a Docker Compose 2.20.2 (health checky používají `start_interval`; compose spec 2026-09-14, rozhodnutí 13); Node ani pnpm na hostu nejsou potřeba, ověřovací skript je čistý Node bez závislostí.
  ```

- [ ] `pnpm format:check` passes.
- [ ] Commit `TODO.md`: `Note the Compose stack's seams for the test infrastructure and the README`

### Task 2: The application image [integration]

**Files:** Create `Dockerfile`, `.dockerignore`
**Invariant:** none touched (6 is prepared: every target runs the same image, so a replica has nothing local but its process).
**Verify:** `docker build --target ingest -t telemetry-ingest:plan-check .` exits 0, then the four container checks below pass, then `docker rmi telemetry-ingest:plan-check`

`Dockerfile` (spec, "The image", verbatim):

```dockerfile
# syntax=docker/dockerfile:1
#
# One image per application, built from the monorepo. Development only.
# The three runtime targets differ only in their CMD, so they share every layer.

FROM node:24-alpine AS base
# corepack ships with the image and resolves the pnpm version pinned in the root package.json
# `packageManager` field, so the image runs exactly the pnpm a developer runs. CI=true makes pnpm
# behave as in CI (frozen lockfile by default, no prompts); the second variable keeps corepack from
# asking before it fetches pnpm.
ENV CI=true COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
WORKDIR /repo

FROM base AS build
# .dockerignore keeps node_modules and dist out of the context, so this is always a clean install
# and a fresh compile: the same shape as `git clone && pnpm install && pnpm build`. Sources are
# copied before the install, so a source change re-installs; accepted for a stack that is built
# once (decision 5 names the cache-mount upgrade).
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm build
# Reconciles node_modules down to the production set. The build has already run, so nothing left
# in dist depends on what this removes.
RUN pnpm install --frozen-lockfile --prod --ignore-scripts

FROM node:24-alpine AS runtime
WORKDIR /repo
COPY --from=build /repo /repo
USER node

FROM runtime AS ingest
CMD ["node", "apps/ingest/dist/main.js"]

FROM runtime AS processing
CMD ["node", "apps/processing/dist/main.js"]

FROM runtime AS emulator
CMD ["node", "apps/emulator/dist/main.js"]
```

`.dockerignore` (spec, verbatim):

```
.git
.gitignore
Dockerfile
.dockerignore
node_modules
**/node_modules
dist
**/dist
**/*.tsbuildinfo
coverage
**/coverage
.local
.claude
.codex
.agents
docs
main-spec
scripts
**/*.md
.env
.env.*
```

The four container checks, run against the built tag; each line is one command and its expected result:

1. `docker run --rm telemetry-ingest:plan-check; echo EXIT=$?` — prints one line containing `ConfigError` and `RABBITMQ_URL: Invalid input: expected string, received undefined`, and `EXIT=1`. The process fails fast on a missing variable and names it, never a value (CLAUDE.md, Configuration).
2. `docker run --rm --entrypoint sh telemetry-ingest:plan-check -c 'ls apps/ingest/dist/main.js apps/processing/dist/main.js apps/emulator/dist/main.js packages/shared/dist/index.js'` — lists all four files: the image was compiled from source inside the build (decision 7).
3. `docker run --rm --entrypoint sh telemetry-ingest:plan-check -c 'test ! -e node_modules/vitest && test ! -e node_modules/typescript && test ! -e .claude && test ! -e docs && test ! -e scripts && test ! -e .git && echo CLEAN'` — prints `CLEAN`: the production reconcile removed the dev dependencies (decision 5) and the context excluded the scratch and documentation trees (decision 7).
4. `docker run --rm --entrypoint sh telemetry-ingest:plan-check -c 'id -un; node --version'` — prints `node` and `v24.21.0` (decisions 3 and 8; a different patch version means the base image moved and the spec's measured facts need a re-check, which is a finding, not a failure).

- [ ] Run `docker build --target ingest -t telemetry-ingest:plan-check .` before the files exist and confirm it fails (no `Dockerfile`).
- [ ] Create both files exactly as above.
- [ ] Build; run the four container checks; remove the tag.
- [ ] Commit both files: `Add the multi-stage Dockerfile with one runtime target per application`

### Task 3: The Compose file and its `.env.example` names [integration]

**Files:** Create `docker-compose.yml`; modify `.env.example`
**Invariant:** 6 — ingest and processing publish no host port and carry no per-instance configuration, so `--scale` can start any number of either (the scaled run of Task 4 is the proof); the emulator comment records why it is not scaled (T14).
**Verify:** `pnpm format:check` and the six checks below, ending with the stack down

`docker-compose.yml` (spec, "The Compose file", verbatim):

```yaml
# Development stack (assignment section 4: "vývojový, nikoliv produkční").
#
#   docker compose up -d --build --wait                                          # everything, one command
#   docker compose up -d --build --wait --scale ingest=2 --scale processing=3    # more instances
#   EMULATOR_DEVICE_COUNT=200 docker compose up -d --build --wait                # more devices
#   docker compose down -v                                                       # reset, volumes included
#
# Every ${VAR:-default} below can be set in the shell or in a .env file next to this file
# (.env.example lists them). The credentials are development credentials and belong in this file
# (CLAUDE.md). Both images apply them only when they initialise an empty data directory, so
# changing one on a stack that has already run needs `docker compose down -v` first. A password
# goes into two URLs: use URL-safe characters or percent-encode it.
name: telemetry

services:
  rabbitmq:
    image: rabbitmq:4.3-management
    environment:
      RABBITMQ_DEFAULT_USER: ${RABBITMQ_USER:-telemetry}
      RABBITMQ_DEFAULT_PASS: ${RABBITMQ_PASSWORD:-telemetry-dev}
    ports:
      # Management UI on http://localhost:15672. Never scaled, so a fixed port is safe.
      - '15672:15672'
    volumes:
      - rabbitmq-data:/var/lib/rabbitmq
    healthcheck:
      # Stage-4 node health check: opens a TCP connection to every enabled listener.
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
      - '27017:27017'
    volumes:
      - mongodb-data:/data/db
    healthcheck:
      test: ['CMD', 'mongosh', '--quiet', '--eval', "db.adminCommand('ping').ok"]
      interval: 10s
      timeout: 10s
      retries: 5
      start_period: 60s
      start_interval: 1s

  ingest:
    build:
      context: .
      target: ingest
    init: true
    stop_grace_period: 20s
    environment:
      RABBITMQ_URL: amqp://${RABBITMQ_USER:-telemetry}:${RABBITMQ_PASSWORD:-telemetry-dev}@rabbitmq:5672
      HEALTH_PORT: '8080'
      LOG_LEVEL: ${LOG_LEVEL:-info}
    depends_on:
      rabbitmq:
        condition: service_healthy
    healthcheck:
      test: ['CMD-SHELL', 'wget --spider -q http://127.0.0.1:$${HEALTH_PORT}/readyz']
      interval: 5s
      timeout: 5s
      retries: 3
      start_period: 30s
      start_interval: 1s
    # No published port: a fixed host port would make `--scale ingest=N` fail on a port conflict,
    # and nothing outside the Compose network needs to reach the device socket.

  processing:
    build:
      context: .
      target: processing
    init: true
    # 17 s worst case: SHUTDOWN_TIMEOUT_MS (10) + AMQP_CLOSE_TIMEOUT_MS (2) + MONGODB_TIMEOUT_MS
    # (5), because the shutdown awaits the consumer and then the store, one after the other.
    # Raising SHUTDOWN_TIMEOUT_MS or MONGODB_TIMEOUT_MS means raising this too.
    stop_grace_period: 30s
    environment:
      RABBITMQ_URL: amqp://${RABBITMQ_USER:-telemetry}:${RABBITMQ_PASSWORD:-telemetry-dev}@rabbitmq:5672
      MONGODB_URL: mongodb://${MONGODB_USER:-telemetry}:${MONGODB_PASSWORD:-telemetry-dev}@mongodb:27017/?authSource=admin
      HEALTH_PORT: '8080'
      LOG_LEVEL: ${LOG_LEVEL:-info}
      PROCESSING_PREFETCH: ${PROCESSING_PREFETCH:-50}
    depends_on:
      rabbitmq:
        condition: service_healthy
      mongodb:
        condition: service_healthy
    healthcheck:
      test: ['CMD-SHELL', 'wget --spider -q http://127.0.0.1:$${HEALTH_PORT}/readyz']
      interval: 5s
      timeout: 5s
      retries: 3
      start_period: 30s
      start_interval: 1s

  emulator:
    build:
      context: .
      target: emulator
    init: true
    stop_grace_period: 20s
    environment:
      # `ingest` resolves to every ingest replica; the emulator pools the addresses and each
      # device picks one at random, which is how devices spread when ingest is scaled.
      INGEST_HOSTS: ingest:4000
      LOG_LEVEL: ${LOG_LEVEL:-info}
      EMULATOR_DEVICE_COUNT: ${EMULATOR_DEVICE_COUNT:-10}
      EMULATOR_EVENT_INTERVAL_MS: ${EMULATOR_EVENT_INTERVAL_MS:-1000}
      EMULATOR_CHAOS: ${EMULATOR_CHAOS:-}
      EMULATOR_SEED: ${EMULATOR_SEED:-1}
    depends_on:
      ingest:
        condition: service_healthy
    # Raise the load with EMULATOR_DEVICE_COUNT, never with `--scale emulator=N`: every replica
    # would get the same EMULATOR_DEVICE_ID_PREFIX and therefore mint the same device ids.
    # No healthcheck: the emulator has no readiness endpoint and nothing depends on it.

volumes:
  rabbitmq-data:
  mongodb-data:
```

`.env.example` gains this block at the end of the file, after the emulator section:

```
# --- docker compose only ---
# Read only when Compose interpolates docker-compose.yml; no service reads these names. Empty means the default in that file.
# Both images apply a credential only when they initialise an empty data volume, so changing one on a stack that has run needs `docker compose down -v` first.
# A password goes into two connection URLs: use URL-safe characters or percent-encode it.
RABBITMQ_USER=
RABBITMQ_PASSWORD=
MONGODB_USER=
MONGODB_PASSWORD=
```

The six checks:

1. `docker compose config --quiet; echo EXIT=$?` — `EXIT=0` (a malformed file exits 1 with the error).
2. `docker compose config --format json > /tmp/telemetry-compose-config.json` (a scratch path outside the repository), then `node -e 'const c = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8")); const s = c.services; const u = new URL(s.processing.environment.RABBITMQ_URL); const m = new URL(s.processing.environment.MONGODB_URL); console.log(c.name, Object.keys(s).sort().join(","), s.ingest.ports === undefined, s.processing.ports === undefined, s.emulator.ports === undefined, s.emulator.environment.EMULATOR_DEVICE_COUNT, u.hostname, u.username, m.hostname, m.searchParams.get("authSource"))' /tmp/telemetry-compose-config.json` — prints `telemetry emulator,ingest,mongodb,processing,rabbitmq true true true 10 rabbitmq telemetry mongodb admin`. (`console.log` is fine in a one-off `node -e`; the lint rule governs committed files.) Then `rm /tmp/telemetry-compose-config.json`: the file holds the resolved development credentials.
3. `docker compose up -d --build --wait --wait-timeout 300; echo EXIT=$?` — ends with five `Healthy` lines (`telemetry-rabbitmq-1`, `telemetry-mongodb-1`, `telemetry-ingest-1`, `telemetry-processing-1`, `telemetry-emulator-1`) and `EXIT=0`. The emulator's `Healthy` is Compose's running-or-healthy label (spec, Research, "Measured").
4. `docker compose ps --format '{{.Service}} {{.Status}}'` — four lines end with `(healthy)`; the emulator line is `Up …` without a health suffix.
5. About 20 s after step 3 returned: `docker compose logs --no-log-prefix processing | grep '"msg":"summary"' | tail -n 1` prints one JSON line whose `received` and `acked` are greater than 0 (the summary line is written every 10 s; `delivery processed` lines are at `debug` and do not show at the default level).
6. `docker compose down -v; docker compose ps -aq | wc -l; docker volume ls -q --filter name=telemetry | wc -l` — prints `0` and `0`.

- [ ] Run check 1 before the file exists and confirm it fails (no Compose file found).
- [ ] Create `docker-compose.yml` and append the `.env.example` block.
- [ ] Run checks 1–6 in order.
- [ ] `pnpm format:check` passes.
- [ ] Commit both files: `Add the Docker Compose development stack`

### Task 4: The end-to-end and scaling check [integration]

**Files:** Create `scripts/compose-check.mjs`; modify `eslint.config.js`; modify `docs/plans/2026-09-14-docker-compose-plan.md` (this plan's header, with the evidence)
**Invariant:** 6 — the `--scale` run proves two ingest replicas share the device fleet with no coordination (check 5: every replica holds devices and the split sums to the fleet) and three processing replicas share one queue (check 4: `consumers` equals the replica count); 4, cross-replica — check 3 counts exactly one `device_state` document per device after three replicas raced on the same queue (`created` sums to the device count in the spec's measurement).
**Verify:** `pnpm lint && pnpm format:check && node --check scripts/compose-check.mjs`, then the four runs below

`eslint.config.js` gains this block between the `*.config.{ts,mts}` block and `prettier`:

```js
  {
    // Host-side scripts run under Node: name the Node globals they use, so `no-undef` still
    // catches a typo but not `process`. Add a name here when a script needs another one.
    files: ['scripts/**/*.mjs'],
    languageOptions: {
      globals: { Buffer: 'readonly', fetch: 'readonly', process: 'readonly', URL: 'readonly' },
    },
  },
```

`scripts/compose-check.mjs`, complete:

```js
// End-to-end and scaling check of the Docker Compose development stack (compose spec, decision
// 25). Host-side Node with no dependencies; run it from any directory:
//
//   node scripts/compose-check.mjs [--scale] [--down]
//
// It starts the stack itself (`docker compose up -d --build --wait`), reads the resolved
// configuration for the expected device count and the management-API credentials, and prints one
// PASS or FAIL line per check. Every check runs even after a failure, so one run shows every
// problem; the exit code is 1 when any check failed. `--scale` starts two ingest and three
// processing replicas and adds the two scaling checks. `--down` tears the stack down at the end,
// volumes included; without it the stack stays up so a developer can look at it.
//
// No credential reaches a host command line or this output: MongoDB is queried through
// `docker compose exec` with the container's own environment variables, and the management API
// gets an Authorization header built here from the resolved RABBITMQ_URL (decision 27).
import { execFile, spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { parseArgs, promisify } from 'node:util';

/** Resolved from this file, so the script runs from any directory and Compose reads the .env next to the file. */
const COMPOSE_FILE = new URL('../docker-compose.yml', import.meta.url).pathname;
const SCALE = { ingest: 2, processing: 3 };
const UP_WAIT_TIMEOUT_S = 300;
const MONGODB_BUDGET_MS = 120_000;
/** The management API's queue counts lag by collect_statistics_interval, 5 s (decision 26). */
const CONSUMERS_BUDGET_MS = 30_000;
/** Ingest writes its `summary` line every 10 s; three intervals cover a line written after the last device connected. */
const SPREAD_BUDGET_MS = 30_000;
const MANAGEMENT_URL = 'http://127.0.0.1:15672';
/** packages/shared/src/topology.ts, TELEMETRY_QUEUE: the queue every processing replica consumes. */
const TELEMETRY_QUEUE = 'telemetry.events';
/** The processing default (packages/shared/src/config.ts, MONGODB_DB) and the collection names of packages/shared/src/collections.ts. */
const MONGODB_DB = 'telemetry';
const MONGO_EVAL =
  'JSON.stringify({state: db.device_state.countDocuments({}), events: db.events.countDocuments({}), alerts: db.alerts.countDocuments({})})';
/** `docker logs` of a long run exceeds execFile's 1 MiB default, which would kill the child and truncate. */
const MAX_BUFFER = 64 * 1024 * 1024;

const run = promisify(execFile);
const out = (text) => process.stdout.write(`${text}\n`);

const { values: flags } = parseArgs({
  options: {
    scale: { type: 'boolean', default: false },
    down: { type: 'boolean', default: false },
  },
});

/** Runs a docker compose subcommand and returns its stdout. */
async function compose(args) {
  const { stdout } = await run('docker', ['compose', '-f', COMPOSE_FILE, ...args], {
    maxBuffer: MAX_BUFFER,
  });
  return stdout;
}

/** Runs a docker compose subcommand with the terminal attached (build progress, Healthy lines); resolves with its exit code. */
function composeAttached(args) {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', ['compose', '-f', COMPOSE_FILE, ...args], { stdio: 'inherit' });
    child.on('error', reject);
    child.on('close', (code) => resolve(code ?? 1));
  });
}

/**
 * Polls `probe` until it returns a value other than undefined or the budget is spent. A probe
 * that throws counts as "not yet" (mongosh before the server answers, fetch before the management
 * listener is up); the last error is reported when the budget runs out.
 */
async function waitFor({ probe, budgetMs, intervalMs = 1000 }) {
  const deadline = Date.now() + budgetMs;
  let lastError;
  for (;;) {
    try {
      const value = await probe();
      if (value !== undefined) return { ok: true, value };
    } catch (error) {
      lastError = error;
    }
    if (Date.now() >= deadline) {
      const reason = lastError instanceof Error ? lastError.message : String(lastError);
      return {
        ok: false,
        detail: lastError === undefined ? 'timed out' : `timed out; last error: ${reason}`,
      };
    }
    await sleep(intervalMs);
  }
}

let failures = 0;
function report({ name, ok, detail }) {
  if (!ok) failures += 1;
  out(`${ok ? 'PASS' : 'FAIL'} ${name} — ${detail}`);
}

async function runChecks() {
  // --- 1. start: `--wait` returns 0 only when every service with a health check is healthy -----
  const upArgs = ['up', '-d', '--build', '--wait', '--wait-timeout', String(UP_WAIT_TIMEOUT_S)];
  if (flags.scale) {
    for (const [service, count] of Object.entries(SCALE)) {
      upArgs.push('--scale', `${service}=${String(count)}`);
    }
  }
  const upExit = await composeAttached(upArgs);
  report({
    name: 'stack up and healthy',
    ok: upExit === 0,
    detail: `docker compose up --wait exited with ${String(upExit)}${flags.scale ? ' (scaled)' : ''}`,
  });

  // --- 2. resolved configuration: expected device count, replica ids, management credentials ----
  // Checks 3–5 need these values, so a failure here is reported once and ends the checks; the
  // summary line and the teardown still run.
  let resolved;
  try {
    const config = JSON.parse(await compose(['config', '--format', 'json']));
    const amqp = new URL(config.services.processing.environment.RABBITMQ_URL);
    resolved = {
      devices: Number(config.services.emulator.environment.EMULATOR_DEVICE_COUNT),
      authorization: `Basic ${Buffer.from(
        `${decodeURIComponent(amqp.username)}:${decodeURIComponent(amqp.password)}`,
      ).toString('base64')}`,
      ingestIds: (await compose(['ps', '-q', 'ingest'])).trim().split('\n').filter(Boolean),
      processingIds: (await compose(['ps', '-q', 'processing'])).trim().split('\n').filter(Boolean),
    };
  } catch (error) {
    report({
      name: 'resolved configuration',
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
    });
    return;
  }
  const { devices, authorization, ingestIds, processingIds } = resolved;
  out(
    `config: devices=${String(devices)} ingest=${String(ingestIds.length)} processing=${String(processingIds.length)}`,
  );

  // --- 3. data reaches MongoDB: one device_state document per device, events flowing -----------
  // Exactly the fleet size, not at least: device_state is keyed by device id, so a higher count
  // means a previous run's data is still in the volume (reset with `docker compose down -v`) and
  // a lower one means devices are missing. Either way the FAIL line shows the last counts read.
  let lastCounts;
  const counts = await waitFor({
    probe: async () => {
      const stdout = await compose([
        'exec',
        '-T',
        'mongodb',
        'sh',
        '-c',
        `mongosh --quiet -u "$MONGO_INITDB_ROOT_USERNAME" -p "$MONGO_INITDB_ROOT_PASSWORD" --authenticationDatabase admin ${MONGODB_DB} --eval '${MONGO_EVAL}'`,
      ]);
      lastCounts = JSON.parse(stdout.trim());
      return lastCounts.state === devices && lastCounts.events > 0 ? lastCounts : undefined;
    },
    budgetMs: MONGODB_BUDGET_MS,
  });
  const countsSeen =
    lastCounts === undefined
      ? 'no counts read'
      : `device_state=${String(lastCounts.state)} events=${String(lastCounts.events)} alerts=${String(lastCounts.alerts)}`;
  let countsProblem = '';
  if (!counts.ok) {
    countsProblem = `; ${counts.detail}`;
    if (lastCounts !== undefined && lastCounts.state > devices) {
      countsProblem +=
        '; more documents than devices: a previous run is still in the volume, reset with docker compose down -v';
    }
  }
  report({
    name: 'data reaches MongoDB',
    ok: counts.ok,
    detail: `${countsSeen} expected_devices=${String(devices)}${countsProblem}`,
  });

  if (!flags.scale) return;

  // --- 4. one consumer per processing replica, from the management API (polled, decision 26) ----
  let lastConsumers;
  const consumers = await waitFor({
    probe: async () => {
      const response = await fetch(`${MANAGEMENT_URL}/api/queues/%2F/${TELEMETRY_QUEUE}`, {
        headers: { authorization },
      });
      if (!response.ok) throw new Error(`management API answered ${String(response.status)}`);
      const queue = await response.json();
      lastConsumers = queue.consumers;
      return lastConsumers === processingIds.length ? lastConsumers : undefined;
    },
    budgetMs: CONSUMERS_BUDGET_MS,
  });
  const consumersSeen = lastConsumers === undefined ? 'none read' : String(lastConsumers);
  report({
    name: 'one consumer per processing replica',
    ok: consumers.ok,
    detail: `consumers=${consumersSeen} expected=${String(processingIds.length)}${consumers.ok ? '' : `; ${consumers.detail}`}`,
  });

  // --- 5. devices spread over every ingest replica: `open` of each replica's last summary line ---
  // `none` means the replica has written no summary line yet: the line is written at info every
  // 10 s, so LOG_LEVEL must be info or lower for this check.
  let split = [];
  const spread = await waitFor({
    probe: async () => {
      split = [];
      for (const id of ingestIds) {
        const { stdout } = await run('docker', ['logs', id], { maxBuffer: MAX_BUFFER });
        const last = stdout
          .split('\n')
          .filter((line) => line.includes('"msg":"summary"'))
          .at(-1);
        split.push(last === undefined ? undefined : Number(JSON.parse(last).open));
      }
      const total = split.reduce((sum, value) => sum + (value ?? 0), 0);
      const everyReplicaHasDevices = split.every((value) => value !== undefined && value > 0);
      return everyReplicaHasDevices && total === devices ? split : undefined;
    },
    budgetMs: SPREAD_BUDGET_MS,
  });
  const rendered = split.map((value) => (value === undefined ? 'none' : String(value)));
  report({
    name: 'devices spread over every ingest replica',
    ok: spread.ok,
    detail: `split=[${rendered.join(', ')}] expected_total=${String(devices)}${spread.ok ? '' : `; ${spread.detail}`}`,
  });
}

try {
  await runChecks();
} finally {
  // --- 6. teardown: only with --down; otherwise leave the stack for inspection ------------------
  if (flags.down) {
    const downExit = await composeAttached(['down', '-v']);
    report({
      name: 'stack down, volumes removed',
      ok: downExit === 0,
      detail: `docker compose down -v exited with ${String(downExit)}`,
    });
  } else {
    out('stack left running; reset from the repository root with: docker compose down -v');
  }
}

out(failures === 0 ? 'ALL PASS' : `${String(failures)} FAILED`);
process.exit(failures === 0 ? 0 : 1);
```

Fixed points the implementer must not vary: `-f COMPOSE_FILE` on every Compose call (A5); the three budgets and the poll shape (A8, A9); `stdio: 'inherit'` for `up` and `down` only (A7); no credential in any `out()` call and no `console.*`; `report` and `waitFor` take one named object (CLAUDE.md, Arguments).

The four runs, in this order, from a state with no `telemetry` container (`docker compose ps -aq` prints nothing; Task 3 ended with `down -v`). Each run's output is saved with `2>&1` into the main checkout's `.local/research/` (A14): from this worktree that directory is `../../../.local/research/`, as written below; when the commands run in the main checkout itself, drop the `../../../`. None of the files is committed.

1. **Cold start, default mode:** `node scripts/compose-check.mjs > ../../../.local/research/2026-09-14-compose-check-output.txt 2>&1; echo EXIT=$?` — the output ends with `PASS stack up and healthy`, `config: devices=10 ingest=1 processing=1`, `PASS data reaches MongoDB — device_state=10 events=N alerts=M expected_devices=10`, the `stack left running` line and `ALL PASS`; `EXIT=0`; no line mentions `consumer` or `spread` (flag gating, half one); `docker compose ps -q ingest | wc -l` prints `1` and the stack is still up.
2. **Teardown on a running stack:** `node scripts/compose-check.mjs --down > ../../../.local/research/2026-09-14-compose-check-down-output.txt 2>&1; echo EXIT=$?` — `up` on the running stack is a no-op (the `Healthy` lines repeat), the same three `PASS` lines, then `PASS stack down, volumes removed — docker compose down -v exited with 0`, `ALL PASS`, `EXIT=0`; afterwards `docker compose ps -aq | wc -l` prints `0` and `docker volume ls -q --filter name=telemetry | wc -l` prints `0` (the teardown criterion).
3. **Cold start, scaled, with teardown:** `node scripts/compose-check.mjs --scale --down > ../../../.local/research/2026-09-14-compose-check-scale-output.txt 2>&1; echo EXIT=$?` — eight `Healthy` lines during `up`, `config: devices=10 ingest=2 processing=3`, the MongoDB `PASS`, `PASS one consumer per processing replica — consumers=3 expected=3`, `PASS devices spread over every ingest replica — split=[a, b] expected_total=10` with `a > 0`, `b > 0`, `a + b = 10`, the teardown `PASS`, `ALL PASS`, `EXIT=0` (flag gating, half two, and both ledger verifications).
4. **Cold start, more devices, with teardown:** `EMULATOR_DEVICE_COUNT=25 node scripts/compose-check.mjs --down > ../../../.local/research/2026-09-14-compose-check-devices-output.txt 2>&1; echo EXIT=$?` — `config: devices=25 ingest=1 processing=1`, `PASS data reaches MongoDB — device_state=25 events=N alerts=M expected_devices=25`, the teardown `PASS`, `ALL PASS`, `EXIT=0`. This is TODO item 5 end to end: the variable set in the shell reaches Compose's interpolation through the environment the script's child processes inherit, and the Compose file's `${EMULATOR_DEVICE_COUNT:-10}` carries it into the emulator container.

Then, as a negative check of the flag parser: `node scripts/compose-check.mjs --sacle; echo EXIT=$?` — prints a `TypeError` naming the unknown option and `EXIT=1`, and `docker compose ps -aq | wc -l` still prints `0` (nothing was started).

- [ ] Add the ESLint block; write the script; `pnpm lint && pnpm format:check && node --check scripts/compose-check.mjs` pass. (`pnpm lint` before the block is added reports the six `no-undef` errors of the Research section — run it once that way to see the failure the block fixes.)
- [ ] Run the four runs and the negative check; fix whatever they find in the script (each fix is its own commit naming the run).
- [ ] Commit the script and the config: `Add the Compose end-to-end and scaling check script`
- [ ] Record the evidence in this plan's header, in the processing plan's style: the date, the Engine and Compose versions, the four runs' `PASS` lines with their numbers (the MongoDB counts, `consumers`, the split, the 25-device counts), the exit codes, and the four output file names.
- [ ] Commit the plan: `Record the Compose stack's end-to-end and scaling runs`

### Task 5: Ledger and trade-offs [mechanical]

**Files:** Modify `TODO.md`, `docs/specs/2026-09-11-telemetry-consistency-design.md`
**Invariant:** none touched.
**Verify:** `pnpm format:check && pnpm lint && pnpm typecheck && pnpm test` (855 tests in 40 files, A17)

- [ ] Tick all six boxes under `## 6. Docker Compose (vývojový)` and add this one-line note above them, in the style and spacing of the step 5 note (`TODO.md` line 88), with the real date, commit count and first sha:

  ```text
  Hotovo 2026-09-14 podle `docs/specs/2026-09-14-docker-compose-design.md` a `docs/plans/2026-09-14-docker-compose-plan.md` (N commitů `<první sha>..`, 855 testů beze změny). Skript `scripts/compose-check.mjs` prošel ve výchozím režimu, ve škálovaném režimu (2 ingest, 3 processing) a s 25 emulovanými zařízeními; výsledky jsou v hlavičce plánu.
  ```

- [ ] Append rows T55–T60 to the consistency spec after the T44–T49 table (before `## Alternatives Considered`). The introducing paragraph is:

  ```text
  Rows T55–T60 come from the Docker Compose design spec (`docs/specs/2026-09-14-docker-compose-design.md`), added when TODO step 6 landed on 2026-09-14.
  ```

  Below it, a table with the columns `#`, `Compromise`, `What is given up`, `When it starts to matter`, `Upgrade path`, `Decision`, carrying the six rows of the compose spec's "Trade-offs to record when the step lands" with the spec's `Source` column mapped to `Decision` (`compose spec, 5 and 6`; `compose spec, 5`; `compose spec, 17`; `compose spec, 10`; `compose spec, 19 and 20`; `compose spec, 18`). Prettier aligns the table.

- [ ] Full pre-flight green, test count 855.
- [ ] Commit both files: `Mark the Docker Compose step done and record its trade-offs`

## Verification Criteria

| #   | Criterion (TODO step 6 item, spec criterion, or invariant)                                                                                     | How to verify                                                                                                                                                                                                                  |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | Services: RabbitMQ with the management UI, MongoDB, ingest, processing, emulator                                                               | Task 3 check 2 (`docker compose config` lists the five services); check 4 (`ps` shows all five up); `curl -s -o /dev/null -w '%{http_code}' localhost:15672` prints `200` while the stack runs                                 |
| 2   | Every application is built from the monorepo into its own image                                                                                | Task 2 checks 2–4 (compiled `dist/main.js` for each app, dev dependencies removed, runs as `node`); `docker compose config --format json` shows three services with `build.target` `ingest`, `processing`, `emulator`          |
| 3   | Dependencies and health checks: applications start only after the infrastructure is ready                                                      | Task 3 check 3 (`up --wait` exits 0 with every service healthy); check 2 shows `depends_on` with `condition: service_healthy` on ingest, processing and the emulator                                                           |
| 4   | Instances of ingest and processing scale with the standard Compose mechanism, and devices spread across the ingest instances                   | Task 4 run 3: `config: … ingest=2 processing=3`, `consumers=3`, `split=[a, b]` with both above zero summing to 10                                                                                                              |
| 5   | The number of emulated devices is raised through an environment variable                                                                       | Task 4 run 4: `EMULATOR_DEVICE_COUNT=25 …` prints `config: devices=25 …` and `device_state=25 … expected_devices=25`; the Compose file's `${EMULATOR_DEVICE_COUNT:-10}` is what carries it into the container                  |
| 6   | End to end: one command starts the whole system and data reaches MongoDB                                                                       | Task 4 run 1 (cold start: the script's own `up` is the one command; `PASS data reaches MongoDB`)                                                                                                                               |
| 7   | Spec criterion "cold start": from no `telemetry` container, the script alone brings the stack up and its first check passes                    | Task 4 run 1 preceded by `docker compose ps -aq` printing nothing                                                                                                                                                              |
| 8   | Spec criterion "teardown": after `--down`, no `telemetry` container and no `telemetry` volume remain                                           | Task 4 run 2's two `wc -l` lines print `0`                                                                                                                                                                                     |
| 9   | Spec criterion "flag gating": without `--scale` the two scale checks neither run nor print; with it, `ps` shows 2 + 3 replicas and both report | Task 4 runs 1 and 3; the negative check rejects an unknown flag before starting anything                                                                                                                                       |
| 10  | Invariant 6: ingest holds no per-device state and both services scale horizontally                                                             | Criterion 4; `grep -n 'ports' docker-compose.yml` shows ports only under `rabbitmq` and `mongodb`                                                                                                                              |
| 11  | Invariant 4 across replicas: three processing replicas on one queue create exactly one state document per device                               | Task 4 run 3: `device_state=10` with `processing=3`                                                                                                                                                                            |
| 12  | Invariants 1, 2, 3 and 5 are untouched: no file under `apps/` or `packages/` changes                                                           | `git diff --stat 41f30a8..HEAD -- apps packages` is empty at the end of Task 5                                                                                                                                                 |
| 13  | Signals reach the process: exec-form `CMD`, `init: true`, and a bounded stop                                                                   | `docker compose up -d --wait && time docker compose stop processing` finishes under 30 s, and `docker compose logs --no-log-prefix processing` ends with `shutting down` … `stopped` (spec decisions 8 and 16); then `down -v` |
| 14  | An invalid configuration fails fast naming the variable, never its value                                                                       | Task 2 check 1                                                                                                                                                                                                                 |
| 15  | No secret in the repository, in the script's output, or on a host command line                                                                 | `.env.example` values stay empty; the four output files contain neither `telemetry-dev` nor `Authorization`; the script passes MongoDB credentials only through the container's environment and the AMQP ones only in a header |
| 16  | Conventions: `pnpm` only, no `console.*` in committed code, Prettier and ESLint clean, 855 tests unchanged                                     | Task 5's full pre-flight; `grep -n 'console\.' scripts/compose-check.mjs` prints nothing                                                                                                                                       |
| 17  | The README requirements the spec names are not lost                                                                                            | Task 1's step 8 note in `TODO.md` names Docker Engine 25 and Compose 2.20.2                                                                                                                                                    |
| 18  | The step 7 seam the spec names is not lost                                                                                                     | Task 1's step 7 note in `TODO.md` names the fixed project name and ports                                                                                                                                                       |

## Test Plan

- No vitest change: this step adds no test file and touches nothing under `apps/` or `packages/`. `pnpm test` stays at 855 tests in 40 files; the integration project stays empty until step 7.
- **Tasks 2, 3 and 4 need Docker** (`docker info` answers; Engine 29.4.0 and Compose v5.1.2 on this host). Task 2 builds the image once (a few minutes: `pnpm install` from the registry inside the build); Tasks 3 and 4 reuse the cached layers.
- The script is verified by running it, not by a unit test (A13): four recorded runs cover the spec's three open criteria, both modes and a raised device count (TODO item 5), and a negative run covers the flag parser. Every wait in the script is a poll with a budget against a real service; the only sleep is the poll interval.
- Per task: the task's verify command. Task 1 and Task 5: `pnpm format:check`. Task 4: `pnpm lint && pnpm format:check && node --check scripts/compose-check.mjs`.
- Full pre-flight before reporting done: `pnpm format:check && pnpm lint && pnpm typecheck && pnpm test`.
- After the last commit the working tree is clean and `docker compose ps -aq` prints nothing (every run of Task 4 that started the stack ended with `--down`, except run 1, which run 2 took down).

## Checkpoint Recovery

If interrupted mid-implementation, resume by:

1. Read this plan.
2. `git log --oneline 41f30a8..HEAD` — the first commit after the spec is this plan; then each task ends with exactly one commit whose subject is quoted in the task (Task 4 ends with two, plus any fix commits before them).
3. Pick up from the first task whose commit is missing. Tasks run in numeric order: Task 3's Compose file builds with Task 2's Dockerfile; Task 4's script drives Task 3's file and needs Task 4's own ESLint block to lint; Task 5's note cites Task 4's runs.
4. If a run of Task 4 was interrupted with the stack up, `docker compose down -v` from the repository root restores the cold-start precondition; the run is repeated from the start.
5. The output files in the main checkout's `.local/research/` (`../../../.local/research/` from this worktree) are evidence, not state: a missing file means the run is repeated, never reconstructed.
