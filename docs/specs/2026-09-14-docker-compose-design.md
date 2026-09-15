# Docker Compose (development stack) Design Spec

**Date:** 2026-09-14
**Status:** Draft
**TODO items:** section 6 "Docker Compose (vývojový)", all six items
**Scope:** new files `Dockerfile`, `.dockerignore`, `docker-compose.yml`, `scripts/compose-check.mjs`; four Compose-only override names added to `.env.example`; no change to `apps/*` or `packages/*`

## Problem

Steps 2–5 shipped three services that already run against real RabbitMQ and MongoDB when a
developer starts them by hand. The assignment asks for one more thing (section 4 of the PDF):
one command must start the whole system — broker, database and all three applications — and it
must be easy to raise both the number of emulated devices and the number of instances of each
service.

Nothing in the repository is containerised yet. There is no image, no Compose file, and no
repeatable way to answer "does the whole thing work end to end?". Every verification so far has
been a hand-written probe in `.local/research/` that starts throwaway containers itself.

This spec decides how the system is packaged and wired for **development**. The PDF says
explicitly "vývojový, nikoliv produkční" — development, not production. Every decision below
optimises for a reviewer who clones the repository and runs one command, not for a production
deployment.

## Decisions Log

| #   | Question                                                              | Decision                                                                                                                                                                                                                                                                                                                                                                                                       | Reasoning                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| --- | --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Compose file name: `compose.yaml` or `docker-compose.yml`?            | `docker-compose.yml` at the repository root.                                                                                                                                                                                                                                                                                                                                                                   | Compose reads either. `CLAUDE.md` already names `docker-compose.yml` as the one place development credentials live, and the assignment calls it "Docker Compose konfiguraci". Consistency with what is already written beats the newer canonical name.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| 2   | One Dockerfile per application, or one with a target per application? | **One root `Dockerfile` with three runtime targets** (`ingest`, `processing`, `emulator`). Compose selects one with `build.target`.                                                                                                                                                                                                                                                                            | The assignment (PDF section 4) requires only that one command starts the whole system and that scaling is easy; it never asks for a file per application. "Dockerfile pro každou aplikaci" is `TODO.md`'s own paraphrase, and `CLAUDE.md` says the PDF wins when the two differ. On the merits: the install and build steps are identical for all three, so three copies would be three places to fix one bug, and this is the shape the pnpm documentation shows for a monorepo (one Dockerfile, `AS app1`, `AS app2`). Each application still gets its own image.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| 3   | Base image                                                            | `node:24-alpine` (Node v24.21.0, verified).                                                                                                                                                                                                                                                                                                                                                                    | `package.json` requires `node >=24.10 <25` and `.npmrc` sets `engine-strict=true`, so the tag must be a 24.x. Every runtime dependency (`ws`, `amqplib`, `mongodb`, `zod`, `pino`) is pure JavaScript, so musl costs nothing. Alpine is 163 MB against ~400 MB for `node:24`. The DNS behaviour the scaling story depends on was verified **inside this image**, not on glibc.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| 4   | How pnpm gets into the image                                          | `corepack enable`, which resolves the version pinned in the root `package.json` `packageManager` field (`pnpm@10.29.2`).                                                                                                                                                                                                                                                                                       | corepack 0.36.0 already ships in `node:24-alpine`, so nothing is installed with npm and the image runs exactly the pnpm the developer runs. Trade-off: corepack is on a deprecation path in the Node project; when it goes, the line becomes an explicit pnpm install, and the pinned version is already in `package.json`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| 5   | How the production dependency set is produced                         | Build with the full dependency set, then run `pnpm install --frozen-lockfile --prod --ignore-scripts` **in the same tree** to reconcile `node_modules` down.                                                                                                                                                                                                                                                   | Verified: it removed 140 packages (eslint, prettier, typescript, typescript-eslint, vitest, `@types/node`). This is the path pnpm's own documentation gives for a monorepo: `pnpm install --prod` "will not install any package listed in `devDependencies` and will remove those insofar they were already installed", while `pnpm prune --prod`, the purpose-built command, "does not support recursive execution on a monorepo currently" and its page points at `pnpm install --prod` instead. `--ignore-scripts` keeps the reconcile step from running any lifecycle script; no package in this repository declares one, so the flag is explicitness, not a fix. Trade-off named: sources are copied before the install, so every source change invalidates the install layer and the next `--build` installs the whole dependency set from the registry again. Accepted for a stack a reviewer builds once; the documented upgrade is pnpm's BuildKit cache mount on the two install lines, one flag each. `pnpm deploy --filter` would be the other purpose-built tool, but on pnpm 10.29.2 it needs `injectWorkspacePackages` (only from 12.2.0 is that unnecessary), and it copies files by `.gitignore`, which in this repository **excludes `dist/`** — the deployed image would have no compiled output. Rejecting it avoids both a workspace-wide setting change and a `files` field on four packages. |
| 6   | What the runtime image contains                                       | The whole built workspace at `/repo`: `node_modules`, all three `apps/*/dist` and `packages/shared/dist`.                                                                                                                                                                                                                                                                                                      | Simplest thing that works, and the three targets differ only in `CMD`, so they share every layer — three images cost one image's disk. Trade-off named: each image carries the other two apps' compiled output (`apps` is 2.6 MB of a 268 MB image) and 40 compiled `*.test.js` files, because every `tsconfig.json` uses `include: ["src"]`. A production image would carry one app; the upgrade path is decision 5's `pnpm deploy` once pnpm ≥ 12.2.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| 7   | Build context                                                         | A `.dockerignore` that excludes `node_modules`, `dist`, `.git`, `.local`, `.claude`, `docs`, `main-spec`, `scripts`, every `*.md` and any `.env` file.                                                                                                                                                                                                                                                         | Without it the context carries the developer's `node_modules` and any `.claude/worktrees/` checkout. Excluding `dist` matters for correctness, not only size: it forces the image to compile from source, so a stale host build can never leak in. Verified by building from a fresh `git worktree` — the same shape as a clean clone.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| 8   | Process identity and signals                                          | Exec-form `CMD ["node", "…/main.js"]`, `USER node`, and `init: true` on each application service.                                                                                                                                                                                                                                                                                                              | Exec form runs `node` directly, with no shell in between, so the SIGTERM Compose sends reaches the handler installed by `createLifecycleHandlers`; a shell-form `CMD` would put `sh` in front of it, and `sh` does not forward the signal. `init: true` makes `docker-init` (tini) PID 1 and `node` its child (measured: PID 1 is `docker-init`, `node` is PID 6 with parent 1); the init forwards SIGTERM and reaps orphans. It is worth having even though the services spawn no children: Linux treats PID 1 specially and drops any signal with the default action (`docker run` reference), so a `node` process that ever lost its handler would ignore SIGTERM and wait for the SIGKILL, and the cost is one static binary. `USER node` drops root for a process that needs no privilege; the copied tree is root-owned and read-only for it, and nothing here writes to disk.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| 9   | Infrastructure images                                                 | `rabbitmq:4.3-management` (4.3.5) and `mongo:8.0` (8.0.30).                                                                                                                                                                                                                                                                                                                                                    | The exact images and versions steps 4 and 5 were already verified against. The `-management` variant is required by the ledger item ("RabbitMQ s management UI") and also serves the HTTP API the scaling check reads.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| 10  | RabbitMQ health check                                                 | `rabbitmq-diagnostics -q check_port_connectivity`.                                                                                                                                                                                                                                                                                                                                                             | The documented stage-4 node health check: it opens a TCP connection to every enabled listener, which covers both the AMQP port the applications need and the management port the scaling check needs. Measured at 0.32 s. The documentation warns that CLI probes join the Erlang distribution on every call and recommends a plain TCP port check for production readiness probes; at a 10 s interval on a development stack that cost is acceptable, and the alternative (`bash -c 'exec 3<>/dev/tcp/…'`, 0.06 s) trades a documented command for a shell trick.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| 11  | MongoDB health check                                                  | `mongosh --quiet --eval "db.adminCommand('ping').ok"`, with no credentials.                                                                                                                                                                                                                                                                                                                                    | `mongosh` ships in the image at `/usr/bin/mongosh`; measured at 0.25 s. Verified against an **auth-enabled** mongod (decision 20): the unauthenticated `ping` returns `1`, while a real query on the same connection is refused with `Unauthorized`. So the check needs no credentials and still proves the server answers.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| 12  | Application health check                                              | The image's own busybox `wget --spider` against `GET /readyz` on `HEALTH_PORT`.                                                                                                                                                                                                                                                                                                                                | Both services already expose `/readyz` (ingest spec decision 17, processing spec decision 19), proven against real infrastructure. Both exit codes of the **exact configured command** were measured, on two rigs: against the real ingest image, `wget --spider -q` exits 1 and prints `HTTP/1.1 503 Service Unavailable` while the publisher is disconnected, and `/readyz` returns `{"status":"ready"}` once it is connected; and through the Compose health-check mechanism itself, against a stand-in Node HTTP server answering 200, three consecutive probes logged `ExitCode: 0` at ~60 ms each. The stand-in is enough for the second rig because what it proves, the `$${VAR}` expansion and `wget --spider`'s exit code on a 200, does not depend on which server answers. busybox `wget` is already in the image; spawning `node` for each probe would cost ~40 MB of RSS every few seconds across five containers.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| 13  | Health check timing                                                   | `interval: 10s`, `timeout: 10s`, `retries: 5`, `start_period: 60s`, `start_interval: 1s` for infrastructure; `interval: 5s`, `timeout: 5s`, `retries: 3`, `start_period: 30s`, `start_interval: 1s` for the applications.                                                                                                                                                                                      | `start_interval` probes every second during startup, so a broker that boots in 2 s is not held behind a 10 s interval, and failures during `start_period` do not count against `retries`. It is the newest Compose feature this file uses and sets the floor the README must state: Docker Compose 2.20.2 or newer, and Docker Engine 25 or newer (the `--health-start-interval` option is API 1.44+). This host runs Compose v5.1.2 and Engine 29.4.0.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| 14  | Startup ordering                                                      | `depends_on` with `condition: service_healthy`: ingest → rabbitmq; processing → rabbitmq and mongodb; emulator → ingest.                                                                                                                                                                                                                                                                                       | Both services already tolerate a dependency being down — they retry with backoff and report 503 (verified again in the probe: `publisher reconnect scheduled` with growing delays). The ordering is therefore a **convenience, not a correctness requirement** for the applications: it keeps the first minute of logs clean and makes `docker compose ps` meaningful. It does one load-bearing job, though (see decision 23): every replica of a scaled dependency is **started** before the dependent service, so both ingest containers are registered in DNS before the emulator's first device resolves `ingest`. Measured: with `--scale dep=3` and a dependency that turns healthy 12 s after start, all three replicas started at t+0.2 s and the dependent service started at t+12.6 s.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| 15  | One-command startup                                                   | `docker compose up -d --build --wait`.                                                                                                                                                                                                                                                                                                                                                                         | `--wait` returns only when every service with a health check is healthy and every other service is running, so the single command is also the readiness gate. `--wait-timeout` bounds it. This is what the README will document and what the verification script runs.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| 16  | Shutdown budget                                                       | `stop_grace_period: 20s` on ingest and the emulator, **`30s` on processing**.                                                                                                                                                                                                                                                                                                                                  | Compose's default is 10 s and would SIGKILL a drain still inside its contract. The budgets differ because the sequences differ. Ingest: `SHUTDOWN_TIMEOUT_MS` (10 s) + `AMQP_CLOSE_TIMEOUT_MS` (2 s) = 12 s. The emulator: `SHUTDOWN_TIMEOUT_MS` plus a 1 s closing handshake ≈ 11 s. Processing: `SHUTDOWN_TIMEOUT_MS` + `AMQP_CLOSE_TIMEOUT_MS` + **`MONGODB_TIMEOUT_MS`** (5 s) = 17 s, because `main.ts` awaits `consumer.stop()` and then `store.close()` **sequentially**, and `store.close()` is bounded by the MongoDB timeout (`apps/processing/src/store.ts`, `close()`; processing spec decision 20 says the same: "plus one MongoDB timeout"). **Coupling to remember:** `SHUTDOWN_TIMEOUT_MS` and `MONGODB_TIMEOUT_MS` are both exposed environment variables; raising either without raising `stop_grace_period` reintroduces exactly the SIGKILL this decision prevents. The Compose file carries that as a comment.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| 17  | Restart policy                                                        | None (Compose default `no`).                                                                                                                                                                                                                                                                                                                                                                                   | A configuration error exits 1 immediately; a restart policy would turn that into an invisible crash loop. On a development stack a dead container should stay dead and be visible in `docker compose ps`. Trade-off: a crashed instance is not replaced, so the "instance dies" failure story has to be demonstrated by hand (`docker compose kill`) or by an orchestrator in production.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| 18  | Published host ports                                                  | Only `15672` (RabbitMQ management UI) and `27017` (MongoDB). Ingest and processing publish nothing.                                                                                                                                                                                                                                                                                                            | A fixed host port makes `--scale` fail with a port conflict, which would break the headline scaling command. Nothing outside the network needs to reach ingest: the emulator is inside it and the health check runs inside the container. The two published ports belong to services that are never scaled. Trade-off: both can collide with a locally installed broker or database; the fix is to change the left-hand side of the mapping.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| 19  | Persistence                                                           | Named volumes `rabbitmq-data` and `mongodb-data`.                                                                                                                                                                                                                                                                                                                                                              | Without them a broker restart loses the durable queue, and the durability claims from steps 4 and 5 could not be demonstrated. `docker compose down -v` is the documented reset and is what the verification script uses between runs. **Consequence of persisting:** both images apply their credential variables only when they initialise an empty data directory, so changing a password after the first `up` has no effect on the running broker or database and the applications then fail to authenticate. Changing a credential means `docker compose down -v` first. The Compose file says so next to the credentials.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| 20  | Credentials                                                           | Both infrastructure services get a development user: `RABBITMQ_DEFAULT_USER` / `RABBITMQ_DEFAULT_PASS` and `MONGO_INITDB_ROOT_USERNAME` / `MONGO_INITDB_ROOT_PASSWORD`, defined in `docker-compose.yml` with `${VAR:-default}` so the stack starts with no `.env`.                                                                                                                                             | The alternative — no authentication at all — is simpler, but then the dev stack never exercises the code path production uses: a URL with userinfo, `?authSource=admin`, and the logger's redaction of `RABBITMQ_URL` and `MONGODB_URL`. Processing already has a defined behaviour for wrong credentials (its scripted run, scenario 12) that a credential-less stack could not reach. Verified in the probe: the startup line prints `"RABBITMQ_URL":"[redacted]"`. `CLAUDE.md` names `docker-compose.yml` as the one place development credentials live. Both images document the first-boot rule decision 19 relies on: RabbitMQ's `default_user` / `default_pass` "will only be created on first node boot", and for MongoDB "none of the variables below will have any effect if you start the container with a data directory that already contains a database"; with both variables set MongoDB starts with authentication enabled (`mongod --auth`) and the user is created in `admin` with the `root` role. An overridden password goes into two URLs, so it must contain only URL-safe characters or be percent-encoded; the Compose file says so next to the variables.                                                                                                                                                                                                                                 |
| 21  | Which settings are exposed as environment overrides                   | `LOG_LEVEL`, `EMULATOR_DEVICE_COUNT`, `EMULATOR_EVENT_INTERVAL_MS`, `EMULATOR_CHAOS`, `EMULATOR_SEED`, `PROCESSING_PREFETCH`, plus the two credential pairs (`RABBITMQ_USER`, `RABBITMQ_PASSWORD`, `MONGODB_USER`, `MONGODB_PASSWORD`) — each as `${VAR:-default}`. Everything else uses the service's own default. The four credential names are new and are added to `.env.example`, marked as Compose-only. | These are the knobs a reviewer actually turns. Repeating all thirty variables from `.env.example` in the Compose file would create a second source of truth for defaults that already live in `packages/shared/src/config.ts` and each service's `config.ts`. Compose reads a `.env` next to the Compose file for interpolation, so a developer's `.env` (copied from `.env.example`) is one place for both host runs and Compose overrides: `EMULATOR_DEVICE_COUNT=200` in it raises the load on either path. The four credential names exist only for interpolation, no service reads them, which is why `.env.example` marks them so.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| 22  | Scaling ingest and processing                                         | The standard Compose mechanism: `docker compose up -d --scale ingest=2 --scale processing=3`. No `deploy.replicas` in the file.                                                                                                                                                                                                                                                                                | `--scale` is the documented flag and overrides anything in the file. Keeping the file at one instance each makes the default `up` the simple case and the scaled run an explicit command the README can show.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 23  | How devices spread across ingest replicas                             | Unchanged code. Docker's embedded DNS returns **every** container that shares the service-name alias; the emulator already resolves `INGEST_HOSTS` with `dns.lookup(host, {all: true})`, pools every address that answers and picks one at random per connection attempt.                                                                                                                                      | Verified three times: a bare two-container alias probe returned both addresses in rotating order; a hand-wired rehearsal put 8 of 12 devices on one replica and 4 on the other; and the real Compose file at `--scale ingest=2` split 10 devices 5 / 5. What makes it work is decision 14 — every ingest replica is started, and therefore registered in DNS, before the emulator's first device resolves the name. Consequence to document: a device that is already connected stays where it is, so scaling **up** an already-running stack spreads only new connections and reconnects; a clean `up` from `down -v` spreads everything.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| 24  | Scaling emulated devices                                              | Through `EMULATOR_DEVICE_COUNT`, not through `--scale emulator=N`.                                                                                                                                                                                                                                                                                                                                             | Compose gives every replica the same environment, so two emulator replicas would mint the same device ids (`EMULATOR_DEVICE_ID_PREFIX` is shared). The consistency spec already names the outcome (decision 28, trade-off T14): the replicas are "two physical devices fighting over one document, **the higher `sessionId` winning forever**" — a permanent split-brain in which the losing replica's whole ongoing stream silently stops updating state, not just its first message. The secondary case is two replicas starting in the same millisecond: `sessionId` is `Math.max(now, previous + 1)`, so they mint identical `(deviceId, sessionId, seq)` triples that the `identity_unique` index drops as duplicates. Neither is a load test. The Compose file carries a comment saying so.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| 25  | The end-to-end and scaling checks                                     | One committed script, `scripts/compose-check.mjs`, with two modes: default (one instance of each) and `--scale`. Host-side Node, no dependencies, output through `process.stdout.write`.                                                                                                                                                                                                                       | The ledger asks for two verifications; a script makes them repeatable, gives the README a "how do I know it works" answer, and is re-runnable for TODO step 9's clean-clone check. `process.stdout.write` rather than `console.log` because the flat ESLint config sets `no-console: error` for `**/*.{js,mjs,cjs}` — the same convention the existing probes follow.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| 26  | Where the check reads queue counts                                    | The RabbitMQ management HTTP API, **polled** until the expected value or a 30 s timeout.                                                                                                                                                                                                                                                                                                                       | Management statistics lag by `collect_statistics_interval`, verified as 5000 ms on the running node (`rabbitmqctl eval`). Reading once is exactly the bug that failed scenario 8 of the processing scripted run on its first attempt. Noted for the future: `management_metrics_collection` is deprecated in RabbitMQ 4.3 (the boot log says so) but still permitted by default; the image already exposes the Prometheus endpoint on 15692 as the successor.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 27  | Where the check gets credentials                                      | From `docker compose config --format json`, parsing the resolved `RABBITMQ_URL`; MongoDB is queried through `docker compose exec` with the container's own environment variables.                                                                                                                                                                                                                              | Keeps `docker-compose.yml` the single source of truth, and keeps every credential off the host command line and out of the script's output.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| 28  | Compose project name                                                  | `name: telemetry` at the top level.                                                                                                                                                                                                                                                                                                                                                                            | Otherwise the project is named after the directory, which differs between a clone and a worktree; container names then differ and the check's log parsing becomes fragile.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| 29  | Bind mounts, `--watch`, hot reload, profiles                          | None.                                                                                                                                                                                                                                                                                                                                                                                                          | The assignment asks for a stack that runs the system, not a development inner loop. A `profiles` entry that hid the emulator would break the "one command starts everything" requirement.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |

Amended on 2026-09-14, after `/verify` of the Compose plan: decision 18's two mappings bind to the loopback interface (`127.0.0.1:15672:15672`, `127.0.0.1:27017:27017`), so the development credentials in this file are reachable only from the developer's own machine, not from the network it sits on; the Compose file below carries the change. A developer whose Docker engine runs on another host puts `0.0.0.0` (or that host's address) on the left-hand side instead. T60 (the collision with a locally installed broker or database) is unchanged.

## Chosen Approach

One image built from the monorepo with three runtime targets, five Compose services, health checks
on four of them, and a committed script that proves the two properties the ledger asks for.

```
docker-compose.yml           name: telemetry
  rabbitmq    rabbitmq:4.3-management   ports 15672   volume rabbitmq-data   healthcheck: check_port_connectivity
  mongodb     mongo:8.0                 ports 27017   volume mongodb-data    healthcheck: mongosh ping
  ingest      build target ingest       depends_on rabbitmq(healthy)         healthcheck: wget /readyz
  processing  build target processing   depends_on rabbitmq+mongodb(healthy) healthcheck: wget /readyz
  emulator    build target emulator     depends_on ingest(healthy)           no healthcheck
```

**Why this over alternatives:** it adds four files and four lines to `.env.example`, and changes no application code. Every property
the ledger asks for is already true of the code that shipped in steps 3–5 — the readiness
endpoints, the retry-with-backoff behaviour, the emulator's address pooling — so the Compose file
only has to expose them rather than work around them.

The Compose file below was run exactly as written, scaled to two ingest and three processing
replicas, and the three checks the verification script specifies passed against it from a
prototype. Two parts of the script are new code that no probe has run: the script driving
`docker compose up` and `down` itself, and its `--scale` / `--down` flag handling. In the
rehearsal the stack was started by hand and the prototype ran its three checks afterwards,
unconditionally. `/plan` carries verification criteria for those two parts (listed with the script
below); everything else is a transcription of a working rehearsal, not a new design.

## Research (source links)

Every claim below was checked on 2026-09-14 against Docker Engine 29.4.0 and Docker Compose
v5.1.2. Live measurements are in `.local/research/2026-09-14-compose-probe-evidence.md`.

- [Compose `depends_on` / startup order](https://docs.docker.com/compose/how-tos/startup-order#example) — "Compose waits for healthchecks to pass on dependencies marked with `service_healthy`." Decisions 14, 15.
- [Compose `healthcheck`](https://docs.docker.com/reference/compose-file/services#healthcheck) — `test` list form must start with `NONE`, `CMD` or `CMD-SHELL`; `start_interval` introduced in Compose 2.20.2. Decisions 10–13.
- [Dockerfile `HEALTHCHECK`](https://docs.docker.com/reference/dockerfile/#healthcheck) — the semantics Compose inherits, including `start_period`. Decision 13.
- [`docker compose up` reference](https://docs.docker.com/reference/cli/docker/compose/up/) — `--wait`: "Wait for services to be running|healthy. Implies detached mode."; `--wait-timeout`: "Maximum duration in seconds to wait for the project to be running|healthy"; `--scale`: "Scale SERVICE to NUM instances. Overrides the `scale` setting in the Compose file if present." Decisions 15, 22.
- [Compose networking: scaling and ports](https://docs.docker.com/compose/how-tos/networking#inspect-port-mappings) — "When you scale a service, each replica gets its own dynamic port"; fixed host ports and `--scale` do not mix. Decisions 18, 22.
- [Compose network `aliases`](https://docs.docker.com/reference/compose-file/services#aliases) — "A network-wide alias can be shared by multiple containers … exactly which container the name resolves to is not guaranteed." Decision 23.
- [Docker embedded DNS](https://docs.docker.com/engine/network#dns-services) — containers on a user-defined network resolve through the embedded server at 127.0.0.11. Decision 23. The documentation does not state whether every alias holder is returned, so it was **measured**: `dns.lookup('ingest', {all: true})` inside `node:24-alpine` returned both container addresses, order rotating (`.local/research/2026-09-14-docker-dns-alias-probe.sh`).
- [RabbitMQ health checks, stages 1–5](https://www.rabbitmq.com/docs/monitoring#health-checks) — stage 4 is `rabbitmq-diagnostics check_port_connectivity`, "a check on all enabled listeners (using a temporary TCP connection)". Decision 10.
- [RabbitMQ health checks as readiness probes](https://www.rabbitmq.com/docs/monitoring#readiness-probes) — CLI probes join the Erlang distribution on every call; the Kubernetes Operator uses a plain TCP port check. The trade-off named in decision 10.
- [Node `dns.lookup`](https://nodejs.org/api/dns.html#dnslookuphostname-options-callback) — `{all: true}` resolves to an array of every address. Decision 23.
- [pnpm in Docker](https://pnpm.io/docker) — the multi-stage monorepo pattern with one Dockerfile and a stage per app, and the BuildKit cache mount (`--mount=type=cache,id=pnpm,target=/pnpm/store`) that decision 5 names as the upgrade path. Decisions 2, 4, 5.
- [`pnpm deploy`](https://pnpm.io/cli/deploy) — "Version 12.2.0 and later: `pnpm deploy` no longer requires `injectWorkspacePackages`"; files are selected by `files`, then `.npmignore`, then `.gitignore`. The reason decision 5 rejects it on pnpm 10.29.2.
- [`pnpm install --prod`](https://pnpm.io/cli/install#--prod--p) — "will not install any package listed in `devDependencies` and will remove those insofar they were already installed"; `--frozen-lockfile` is on by default in CI environments, which is what `CI=true` in the Dockerfile selects. Decisions 4, 5.
- [`pnpm prune`](https://pnpm.io/cli/prune) — "The prune command does not support recursive execution on a monorepo currently. To only install production-dependencies in a monorepo `node_modules` folders can be deleted and then re-installed with `pnpm install --prod`." Decision 5.
- [Compose `init`](https://docs.docker.com/reference/compose-file/services/#init) — "runs an init process (PID 1) inside the container that forwards signals and reaps processes". Decision 8.
- [`docker run --init`](https://docs.docker.com/reference/cli/docker/container/run/#init) — `docker-init` is backed by tini; the same page: "A process running as PID 1 inside a container is treated specially by Linux: it ignores any signal with the default action." Decision 8.
- [Compose `stop_grace_period`](https://docs.docker.com/reference/compose-file/services/#stop_grace_period) — "Default value is 10 seconds for the container to exit before sending SIGKILL." Decision 16.
- [Compose `depends_on`, long syntax](https://docs.docker.com/reference/compose-file/services/#depends_on) — `condition: service_healthy`; `required` defaults to `true` (Compose 2.20.0). Decision 14.
- [Compose top-level `name`](https://docs.docker.com/reference/compose-file/version-and-name/) — the project name when none is set explicitly, exposed as `COMPOSE_PROJECT_NAME`. Decision 28.
- [`.dockerignore`](https://docs.docker.com/build/concepts/context/#dockerignore-files) — `**` matches any number of directories; the last matching line wins; `Dockerfile` and `.dockerignore` may be listed (still sent to the builder, never copied into the image). Decision 7.
- [Docker Hub `mongo`](https://hub.docker.com/_/mongo) — `MONGO_INITDB_ROOT_USERNAME` / `MONGO_INITDB_ROOT_PASSWORD` create a `root` user in `admin` and start `mongod --auth`; "none of the variables below will have any effect if you start the container with a data directory that already contains a database". Decisions 11, 19, 20.
- [Docker Hub `rabbitmq`](https://hub.docker.com/_/rabbitmq) — `RABBITMQ_DEFAULT_USER` / `RABBITMQ_DEFAULT_PASS` are "now available in RabbitMQ directly"; the `-management` tags serve the UI on 15672; `/var/lib/rabbitmq` is a volume; the image ships no `HEALTHCHECK`. Decisions 9, 19, 20.
- [RabbitMQ access control, default user](https://www.rabbitmq.com/docs/access-control#default-state) — `default_user` / `default_pass` "will only be created on first node boot". Decision 19.
- [Node `UV_THREADPOOL_SIZE`](https://nodejs.org/api/cli.html#uv_threadpool_sizesize) and [`dns.lookup` implementation considerations](https://nodejs.org/api/dns.html#implementation-considerations) — `dns.lookup()` "is implemented as a synchronous call to `getaddrinfo(3)` that runs on libuv's threadpool"; the pool has four threads by default. Scaling table.
- [musl `lookup.h`](https://git.musl-libc.org/cgit/musl/tree/src/network/lookup.h) — `#define MAXADDRS 48`, "a non-sharp bound on the number of addresses that can fit in one 512-byte DNS packet full of v4 results and a second packet full of v6 results". Scaling table.

Measured, not documented (all in the evidence file):

- `node:24-alpine` is Node v24.21.0 with corepack 0.36.0; `rabbitmq:4.3-management` is RabbitMQ 4.3.5; `mongo:8.0` is MongoDB 8.0.30.
- None of the three images declares a `HEALTHCHECK` (`docker inspect` returns `null`), so Compose must supply all of them.
- `collect_statistics_interval` is 5000 ms (`rabbitmqctl eval`). Decision 26.
- Health check costs, timed over `docker exec` (three runs each): `check_port_connectivity` 0.32 s, `mongosh` ping 0.25 s. Busybox `wget` was not in that table; its ≈60 ms comes from the Compose health-check log of the stand-in rig (evidence section 6).
- `init: true`: inside the container `docker-init` is PID 1 and `node` is PID 6, its child (`ps` in the container). Decision 8.
- `docker compose up --wait` prints `Healthy` for a service that has **no** health check as well: in a two-service probe the container without a check was reported `Waiting` then `Healthy` by `--wait`, while `docker compose ps` showed it as `Up` without `(healthy)`. The label belongs to Compose's running-or-healthy condition, so the `telemetry-emulator-1 Healthy` line in the evidence file's section 8 is genuine output, not a sign of a check on the emulator.
- Both health checks keep working once decision 20's credentials are set: `check_port_connectivity` exits 0, and the unauthenticated `ping` returns 1 while a real query is refused with `Unauthorized`.
- The built image is 268 MB and starts, connects, and answers `/readyz` correctly for both ingest and processing.
- `$${VAR}` in a `CMD-SHELL` health check expands inside the container, and `up --wait` returns only after the check passes (three probes, `ExitCode: 0`, ~60 ms each).
- `depends_on: condition: service_healthy` against a dependency scaled to 3: all three replicas started at t+0.2 s, the dependent service at t+12.6 s — every replica is running before the dependent service starts.
- **The Compose file in this spec was run as written.** `docker compose config` resolves it cleanly, and `docker compose up -d --build --scale ingest=2 --scale processing=3 --wait` brought all eight containers up (RabbitMQ, MongoDB, two ingest, three processing, the emulator). The prototype of the verification script's three checks then passed against it: `device_state=10 events=453 alerts=1`, `consumers=3` on `telemetry.events`, and a 5 / 5 device split across the two ingest replicas.

## Design

### Files added or changed

| Path                        | Purpose                                                                                                                                                                                                                                                                                                                                   |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Dockerfile`                | One multi-stage build; three runtime targets.                                                                                                                                                                                                                                                                                             |
| `.dockerignore`             | Keeps the context to tracked sources.                                                                                                                                                                                                                                                                                                     |
| `docker-compose.yml`        | The five services, health checks, volumes, environment surface.                                                                                                                                                                                                                                                                           |
| `scripts/compose-check.mjs` | The end-to-end and scaling verifications.                                                                                                                                                                                                                                                                                                 |
| `.env.example` (changed)    | Four new lines: `RABBITMQ_USER`, `RABBITMQ_PASSWORD`, `MONGODB_USER`, `MONGODB_PASSWORD`, under a comment saying they are read only by Compose interpolation (decision 21), that a change needs `docker compose down -v` (decision 19), and that a password must be URL-safe (decision 20). Values stay empty, as everywhere in the file. |

`README.md` is written in step 8 and will carry the commands; this step does not touch it.

**Requirements the README must state (decision 13):** Docker Engine 25 or newer and Docker Compose
2.20.2 or newer. Nothing else is needed on the host: Node and pnpm run inside the image, and the
verification script is plain Node with no dependencies.

### The image

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

`.dockerignore`:

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

`.claude` must be excluded: it holds `.claude/worktrees/`, whole nested checkouts.

### The Compose file

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
      # Management UI on http://localhost:15672, bound to the loopback interface so that the
      # development credentials are not reachable from the network. Never scaled, so a fixed port
      # is safe; a remote Docker host needs 0.0.0.0 on the left-hand side instead.
      - '127.0.0.1:15672:15672'
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
      # Loopback only, as above.
      - '127.0.0.1:27017:27017'
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

`$${HEALTH_PORT}` is a literal `$` for Compose, so the container's shell expands the variable set
in the same service's `environment`. That keeps the port in one place even when a developer
overrides it.

### The verification script

`scripts/compose-check.mjs`, run as `node scripts/compose-check.mjs [--scale] [--down]`.

Steps, in order. Every check prints one `PASS` or `FAIL` line with its numbers; the checks all run
even after a failure, so one run shows every problem, and the process exits non-zero if any check
failed:

1. **Start.** `docker compose up -d --build --wait --wait-timeout 300`, plus
   `--scale ingest=2 --scale processing=3` in `--scale` mode. `--wait` is itself check 1: it
   returns only when RabbitMQ, MongoDB and every ingest and processing replica are healthy and the
   emulator is running.
2. **Read the resolved configuration.** `docker compose config --format json`, to learn the
   expected device count and to derive the management-API credentials from `RABBITMQ_URL`. Nothing
   from this step is printed.
3. **Data reaches MongoDB.** Poll, budget 120 s:
   `docker compose exec -T mongodb sh -c 'mongosh --quiet -u "$MONGO_INITDB_ROOT_USERNAME" -p "$MONGO_INITDB_ROOT_PASSWORD" --authenticationDatabase admin telemetry --eval "…"'`
   until `device_state` holds one document per expected device and `events` is non-zero. The
   credentials come from the container's own environment, so they never appear on the host command
   line. Reports the three collection counts.
4. **`--scale` only — consumers.** Poll `GET /api/queues/%2F/telemetry.events` on the management
   API until `consumers` equals the processing replica count, budget 30 s. The budget exists
   because the number lags by `collect_statistics_interval` (5 s). The credentials go into an
   `Authorization` header built inside the script.
5. **`--scale` only — devices spread.** For each container id from `docker compose ps -q ingest`,
   read the last `summary` line from `docker logs` and take `open`. Pass when every replica has
   `open > 0` and the sum equals the expected device count. Reports the per-replica split. The
   `summary` line is written at `info` every 10 s (`apps/ingest/src/main.ts`), so this check needs
   `LOG_LEVEL` at `info` or lower, which is the default; the `FAIL` line says so when no summary
   line is found.
6. **Teardown.** `docker compose down -v` only with `--down`; otherwise print the command and leave
   the stack running so a developer can look at it.

No new npm script: the README shows `docker compose up -d --build --wait` and
`node scripts/compose-check.mjs` directly, so there is no wrapper to keep in sync.

**What the rehearsal covered and what it did not.** Steps 2 to 5 ran as a prototype against the
scaled stack of the evidence file's section 8 (the last bullet under Research) and passed. Step 1, step 6 and the
`--scale` / `--down` flag handling are new code: the rehearsal started the stack by hand and the
prototype ran its three checks unconditionally. `/plan` therefore carries these verification
criteria for the script, in addition to the three checks themselves:

- **Cold start.** With no `telemetry` containers present, `node scripts/compose-check.mjs` alone
  brings the stack up, waits, and its first check passes.
- **Teardown.** After `node scripts/compose-check.mjs --down`, `docker compose ps -a` shows no
  `telemetry` container and `docker volume ls` no `telemetry` volume.
- **Flag gating.** Without `--scale`, the two scale-only checks neither run nor appear in the
  output; with `--scale`, `docker compose ps` shows two ingest and three processing containers and
  both scale-only checks report.

### What this step does not change

No file under `apps/` or `packages/` is touched. `.env.example` already documents every service
variable the Compose file sets, including `INGEST_HOSTS` defaulting to `ingest:4000` and
`HEALTH_PORT` being "used by the Compose healthcheck"; its only edit is the four Compose-only
credential names from decision 21.

## Consistency & Failure Modes

This step adds no message path and no write path, so the six invariants are untouched by
construction. What it does is expose the existing behaviour, and two properties are worth stating
because the technical discussion will probe them.

**Invariant 6 (both services scale horizontally; ingest holds no per-device state)** is the one
this step demonstrates. Ingest keeps nothing keyed by device beyond the lifetime of a socket, so
two replicas need no coordination; the split is decided by the emulator's random draw from the DNS
pool (decision 23), not by any shared state. Processing replicas share one queue and compete for
deliveries; correctness across them comes from the conditional update and the `identity_unique`
index (invariants 1–3), not from how Compose starts them.

**Invariant 4 (parallel across devices, serial within one)** is unchanged and, importantly, is not
provided by Compose. Concurrency arrives from two directions at once: several processing replicas
compete for one queue, and inside each replica `PROCESSING_PREFETCH=50` runs handlers
concurrently. Neither is serialised, so the events of one device can be in flight in two replicas
at the same time; the conditional update and the `identity_unique` index are what keep the result
correct.

Measured on the scaled stack (`--scale ingest=2 --scale processing=3`, 10 devices, ~70 s):

```
replica A  received=244 acked=244 created=2 applied=242 stale=0 duplicate=0 failed=0 gaps=4
replica B  received=243 acked=243 created=4 applied=239 stale=0 duplicate=0 failed=0 gaps=4
replica C  received=244 acked=244 created=4 applied=240 stale=0 duplicate=0 failed=0 gaps=6
TOTAL      received=731 acked=731 created=10                stale=0 duplicate=0 failed=0 gaps=14
```

`created` sums to exactly 10 — one state document per device, created once across three
independent replicas — which is the cross-replica form of the invariant. Deliveries split almost
evenly, so all three replicas really did work on the same queue.

`gaps` is the concurrency made visible, not an error. It counts a device-wide `seq` that skipped a
value within one session (consistency spec, decision 27: the pre-update `lastEvent` had the same
`sessionId` and `event.seq > lastEvent.seq + 1`). With `PROCESSING_PREFETCH=50` and three replicas,
consecutive events of one device are in flight at the same time, and the higher `seq` can be
written first. `stale=0` beside it says that the events which then filled the gaps were of other
sections, which the per-section watermarks (decision 7) apply as the newest of their kind. A
gap-filler of the **same** section would be counted as `stale` and left unapplied, which is
invariant 1 doing its job. The evidence file flags this pair for step 7's integration tests.

Failure behaviour of the stack itself:

| Event                                            | What happens                                                                                                                                                                                                                                                           |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| RabbitMQ is slower to boot than the applications | Cannot happen at first start (`depends_on: service_healthy`). If it did, ingest would answer 503 and retry with backoff — verified.                                                                                                                                    |
| RabbitMQ dies while the stack runs               | `depends_on` gates startup only, so nothing is killed. Ingest and processing turn unhealthy in `docker compose ps` and reconnect when it returns.                                                                                                                      |
| MongoDB dies while the stack runs                | Processing reports `reason: "mongodb"` on `/readyz` and turns unhealthy; a paused consumer reports the same, which is intended (processing spec, decision 19).                                                                                                         |
| A container is stopped                           | Compose sends SIGTERM and waits that service's `stop_grace_period` before SIGKILL: 20 s for ingest and the emulator (worst-case drains 12 s and ≈11 s), 30 s for processing (worst case 17 s; decision 16). The lifecycle handler logs `shutting down` then `stopped`. |
| An application crashes                           | It stays down (decision 17) and is visible in `docker compose ps`.                                                                                                                                                                                                     |
| An invalid environment variable                  | The process exits 1 before the logger exists, with a `ConfigError` naming the variable and never its value — verified: `RABBITMQ_URL: Invalid input: expected string, received undefined`.                                                                             |
| `docker compose down` without `-v`               | Volumes survive, so the durable queue and the stored state survive with them. `-v` is the documented reset.                                                                                                                                                            |

## Scaling

| Dimension                    | Command                      | Limit                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ---------------------------- | ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Ingest instances             | `--scale ingest=N`           | None imposed by Compose. Devices land on a replica by random draw at connect time, so the split is only approximately even and only for connections made after the replica existed. The emulator's resolver caps what it can see: musl's `getaddrinfo` returns at most 48 addresses for one name (`MAXADDRS` in `lookup.h`), so a 49th replica would never receive a device; far above anything a development stack runs.                                                                                                                                                                                                                                                                                                   |
| Processing instances         | `--scale processing=N`       | Beyond the useful point they idle: all replicas consume one queue, so throughput is bounded by the queue and by MongoDB, not by the replica count.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Emulated devices             | `EMULATOR_DEVICE_COUNT=N`    | One process holds N WebSocket connections and N timers. Not `--scale emulator=N` — see decision 24.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Emulated devices, at startup | —                            | `Fleet.start()` calls `client.start()` for every device in one synchronous loop, and the randomised stagger applies only to the tick timer, not to the first connect (`apps/emulator/src/fleet.ts`: "Each client's own random tick phase is the stagger; no startup sleep loop"). At `EMULATOR_DEVICE_COUNT=200` that is ~200 simultaneous `dns.lookup` calls, each a synchronous `getaddrinfo(3)` on libuv's threadpool of four threads by default (`UV_THREADPOOL_SIZE`), and ~200 simultaneous connects. Self-healing through the existing reconnect backoff, but it is a real burst and the reason the `RESOLVE_TIMEOUT_MS` (5 s) and `CONNECT_TIMEOUT_MS` (10 s) constants in `apps/emulator/src/connection.ts` exist. |
| Event rate                   | `EMULATOR_EVENT_INTERVAL_MS` | Lower is faster; the outbox (`EMULATOR_OUTBOX_MAX`, 1000) drops the oldest message per device when ingest applies backpressure.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |

The throughput cost of the consistency mechanism is unchanged by this step: one conditional update
and one guarded insert per message, both single-document operations, with no lock held across
devices (invariant 5).

**Forward note for step 7.** The integration tests need their own RabbitMQ and MongoDB, "oddělená
od vývojového běhu". This stack fixes the project name (`telemetry`), the queue names and the
published ports 15672 and 27017, so step 7 must use a different project name or its own Compose
file rather than reuse this one. The seam is named here so that step is not surprised. **Resolved 2026-09-15** by the integration tests spec (`docs/specs/2026-09-14-integration-tests-design.md`, decisions 1 and 2): a file of its own, `docker-compose.test.yml`, under the project name `telemetry-test`, with the loopback ports 5673, 15673 and 27018 and no volumes, so both stacks run side by side.

**Trade-offs to record when the step lands.** The consistency spec's running list ends at T49 in
position but at T54 by number (its own note explains the gap), so the rows this step adds start at
**T55**. `/plan`'s last task appends them in the list's own column shape, which the table below
already follows:

| Row | Trade-off                                                            | What it costs                                                                                                       | When it matters                                                         | Upgrade path                                                                                          | Source                  |
| --- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | ----------------------- |
| T55 | One image for three applications                                     | Each runtime image carries the other two applications' `dist` and 40 compiled test files (2.6 MB of a 268 MB image) | A production image per application, or a registry that charges per byte | `pnpm deploy --filter` once pnpm ≥ 12.2, plus a `files` field per package                             | compose spec, 5 and 6   |
| T56 | Sources are copied before the dependency install                     | Every source change re-installs the whole dependency set on the next `--build`                                      | A developer rebuilding the image many times a day                       | pnpm's BuildKit cache mount on the two install lines                                                  | compose spec, 5         |
| T57 | No restart policy                                                    | A crashed container stays down until someone restarts it                                                            | Any run that must survive a crash with nobody watching                  | `restart: unless-stopped` in the file, or an orchestrator in production                               | compose spec, 17        |
| T58 | The RabbitMQ health check is a CLI probe                             | Each probe joins the Erlang distribution (0.32 s every 10 s)                                                        | Production readiness probes at a short interval, or many nodes          | A plain TCP port check, as the RabbitMQ documentation recommends                                      | compose spec, 10        |
| T59 | Credentials are applied only when a data volume is first initialised | A credential change needs `docker compose down -v`, which also discards the stored queue and state                  | Rotating a credential on a stack whose data must survive                | Change the password inside the running broker and database with their own tools, then update the URLs | compose spec, 19 and 20 |
| T60 | Fixed host ports 15672 and 27017                                     | They collide with a locally installed broker or database                                                            | A developer machine that already runs RabbitMQ or MongoDB               | Change the left-hand side of the mapping, or make it a `${VAR:-default}`                              | compose spec, 18        |

The random address pick (T41), readiness not moving devices between replicas (T33) and emulator
scaling by device count only (T14) already exist in the list and are referenced, not repeated.

## Alternatives Considered

### Three Dockerfiles, one per application

The literal reading of the ledger item. Rejected in decision 2: the three files would be identical
except for one path, and BuildKit would still have to be trusted to share the cache between them.
One file with three targets shares the layers by construction.

### `pnpm deploy --filter` for a one-app image

The purpose-built tool, and what the pnpm documentation recommends. Rejected in decision 5 for this
repository at pnpm 10.29.2: it needs `injectWorkspacePackages` (a workspace-wide change to how
local packages are linked in development) and it selects files by `.gitignore`, which excludes
`dist/` here — the image would ship no compiled output. Both are fixable (a `files: ["dist"]` field
on four packages, and a pnpm upgrade), but neither is worth doing for a development image whose
three targets already share every layer.

### `node:24` (Debian) instead of Alpine

Safer for native modules and ~240 MB larger. Every runtime dependency here is pure JavaScript, and
the one behaviour that could plausibly differ on musl — `dns.lookup` returning every address of a
scaled service — was measured on Alpine and is correct. Rejected.

### A TCP port check for RabbitMQ instead of `rabbitmq-diagnostics`

`bash -c 'exec 3<>/dev/tcp/127.0.0.1/5672'` costs 0.06 s against 0.32 s, and the RabbitMQ
documentation itself calls a TCP port check the best practice for readiness probes. Rejected for a
development stack because it trades a documented, self-describing command for a shell feature that
needs `bash` (not `sh`) and a comment to explain it. The reasoning is recorded in decision 10 so
the choice can be reversed cheaply if the probe cost ever matters.

### `deploy.replicas` in the Compose file instead of `--scale`

Would put the instance count in the file, so `docker compose up` alone would start the scaled
stack. Rejected: the ledger asks for the "standardní mechanismus Compose" to raise the count, and a
flag on the command line is easier to show in a README and to vary in a check than an edit to a
committed file.

### A published port on ingest

Either fixed (breaks `--scale`) or dynamic (`ports: - "4000"`, works with `--scale`, and
`docker compose port --index=N ingest 4000` finds it). Rejected as an unused capability: the
emulator is inside the network and the health check runs inside the container, so nothing needs it
today. One line to add when something does.

### Making `--scale emulator=N` work

The emulator would have to derive `EMULATOR_DEVICE_ID_PREFIX` from something unique per container —
the hostname is the only candidate Compose provides. Rejected: it is an application change outside
this step, and it would break the seeded reproducibility that the emulator design deliberately
bought (`EMULATOR_SEED` replays the same fleet). `EMULATOR_DEVICE_COUNT` already satisfies the
ledger item.
