# Processing Service Implementation Plan

**Goal:** Build `apps/processing` so that any number of instances consume `telemetry.events` with a bounded window of concurrent handlers, store every unique event, keep one `device_state` document per device under the server-evaluated freshness guard, create one alert per error diagnostic, acknowledge a delivery only after MongoDB has journaled its writes, dead-letter poison and permanent failures, pause during a MongoDB outage and reconnect after a broker loss, report readiness on `/readyz`, and drain on SIGTERM.

**Approach:** Fourteen tasks in dependency order, each one module plus its tests plus one commit. Task 1 commits this plan and applies the spec's amendments to the earlier specs. Task 2 moves the health server from ingest to `packages/shared` with its tests. Tasks 3–8 build the **pure core** of processing (configuration, delivery decoding, failure classification, the state-update builder, the consumer state machine, the readiness report) with direct unit tests. Tasks 9–12 build the **impure shell** (the MongoDB store, the handler, the amqplib consumer, the entry point): the handler is tested against an in-memory store port, the two shells have no mock of the driver or the broker and are proven by Task 13's scripted run against real `rabbitmq:4.3-management` and `mongo:8.0` containers. Task 14 ticks `TODO.md` and appends the trade-offs T44–T49.

As in the emulator and ingest plans, every task gives exact paths, the exported signatures in full, every constant and the enumerated test cases; function bodies are not transcribed, because the design spec fixes every rule they implement (by decision number) and a transcript would only drift from it.

**Design spec:** `docs/specs/2026-09-13-processing-design.md` (committed in `95f4d98`; review-clean after two `design-reviewer` rounds, `.local/reviews/2026-09-13-processing-design-review.md`, nothing deferred to this plan). Binding above it: `docs/specs/2026-09-11-telemetry-consistency-design.md` (decisions 7–13, 16–29, the failure table) and `docs/specs/2026-09-11-shared-contract-design.md`; `docs/specs/2026-09-13-ingest-design.md` for the message ingest publishes (decisions 6 and 7) and the health server (decision 17).
**TODO items:** `5. Processing service` — all nine items. Step 7 gains one item (added in Task 1: the automated broker-and-database tests of the consumer) that this plan does **not** execute.
**Branch:** `main`, direct, small atomic commits (the repository's practice; the history is part of the assessment). No `Co-Authored-By`, no AI mention.
**Scope:** `apps/processing/**` (the step 1 placeholder replaced in place), `packages/shared/src/{health,health.test,index}.ts`, `apps/ingest/src/{health,health.test,main}.ts`, `pnpm-workspace.yaml`, `pnpm-lock.yaml`, `TODO.md`, the consistency spec, the shared-contract spec, the ingest spec, and one wording edit of the processing spec (A13). No Dockerfile and no Compose file: both are step 6.

## Assumptions decided without asking (standing instruction: work autonomously, log every decision)

| #   | Assumption                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Basis                                                                                                                                                                                                                                                                                                                     |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A1  | This plan is copied to `docs/plans/2026-09-13-processing-plan.md` and committed as Task 1 together with the spec's amendments to the three earlier specs and `TODO.md`, which `95f4d98` (the spec's own commit) did not apply.                                                                                                                                                                                                                                                  | The ingest precedent (`56c8dc7`); `grep` shows none of the five amendments in the tree.                                                                                                                                                                                                                                   |
| A2  | A store port method rejects with `StoreError`, an `Error` subclass carrying the `StoreFailure` view, never with the plain object the spec describes. The handler still never sees a driver class.                                                                                                                                                                                                                                                                               | typescript-eslint 8.70.0 `recommendedTypeChecked` turns on `only-throw-error` and `prefer-promise-reject-errors` (verified in the installed preset, Research); a plain-object rejection fails lint.                                                                                                                       |
| A3  | `transition(state, event)` takes two parameters; `now` travels on the `link_opened` and `link_closed` events; `LINK_RESET_AFTER_MS` is a module constant, not an option.                                                                                                                                                                                                                                                                                                        | `max-params: 2`; the ingest publisher's shape (`attempt_succeeded` and `trigger` carry `now`).                                                                                                                                                                                                                            |
| A4  | The `open` state carries `attempt`, because the reset rule of the `link_closed` row (0 after `LINK_RESET_AFTER_MS` of open link, else + 1) needs the number the link was opened with.                                                                                                                                                                                                                                                                                           | Spec, state table row `open`/any + `link_closed`; the spec's type omitted the field.                                                                                                                                                                                                                                      |
| A5  | `MongoStore.start(signal)` and `watch(signal)` resolve with `'ready' \| 'aborted'`; `start` rejects only with the index-conflict `StoreError` (codes 85, 86). The entry point aborts a start still looping at shutdown, so a database that never came up does not keep the process alive.                                                                                                                                                                                       | Spec decision 10 and 20; a rejection for an abort would force the entry point to tell a conflict from a stop.                                                                                                                                                                                                             |
| A6  | `describeMongoError` lives in `store.ts` and is tested in `store.test.ts`; `failure.test.ts` tests the classification table over views. The `server_selection` view is produced by the real driver against a closed port with a 200 ms `serverSelectionTimeoutMS`, not constructed by hand.                                                                                                                                                                                     | Tests are co-located per module (`CLAUDE.md`); `TopologyDescription`, which `MongoServerSelectionError`'s constructor needs, is a type-only export of the driver's package root (Research), so the class cannot be built in a test; a client against a closed port is the ingest `publisher.test.ts` pattern, not a mock. |
| A7  | The readiness ping is `db.command({ ping: 1, maxTimeMS: timeoutMs })`: the bound goes into the command document.                                                                                                                                                                                                                                                                                                                                                                | Driver 7.6 `Db.command` accepts no `maxTimeMS` option (Research); `maxTimeMS` is a generic server argument accepted by every command (server IDL, Research). `socketTimeoutMS` bounds the call as well.                                                                                                                   |
| A8  | The consume callback reads `properties.headers` as `Record<string, unknown> \| undefined` and each header value as `unknown`.                                                                                                                                                                                                                                                                                                                                                   | amqplib types the header values `any`; the `no-unsafe-*` rules.                                                                                                                                                                                                                                                           |
| A9  | The shell runs the effects of every transition on one serial queue and awaits the asynchronous ones (`cancel_consumer` before `return_held`, `return_held` before `watch_store`). Events are applied to the state synchronously; only their effects lag.                                                                                                                                                                                                                        | Spec decision 12: the held deliveries are returned only after the cancel resolved and the handlers settled; amqplib delivers nothing to a cancelled consumer once `cancel` has resolved.                                                                                                                                  |
| A10 | The held map and the abort controller belong to one **registration** (one `consume` call), not to the link generation: a broker cancel or a pause voids the registration, and the next `consume` on the same link starts a fresh one. A handler acknowledges only through the registration it was dispatched by, and only while that registration is live.                                                                                                                      | Spec decisions 6, 7 and 12 ("a new held map; the generation is unchanged"); the map identity is the guard against a void tag.                                                                                                                                                                                             |
| A11 | The attempt's "a close arrived during the attempt" flag lives on the connection handle, not in the `connecting` state, so the state type stays the spec's.                                                                                                                                                                                                                                                                                                                      | Spec decision 6 (the ingest publisher's `failed` flag); here nothing but the attempt reads it.                                                                                                                                                                                                                            |
| A12 | `close_link` closes the connection only (`model.close()`), which closes its channel, bounded once by `AMQP_CLOSE_TIMEOUT_MS`; the whole stop then fits `SHUTDOWN_TIMEOUT_MS + AMQP_CLOSE_TIMEOUT_MS`, as the spec states.                                                                                                                                                                                                                                                       | The ingest publisher's `#close`; two sequential bounded closes would double the bound the spec promises.                                                                                                                                                                                                                  |
| A13 | One success line per delivery, `delivery processed`, with `outcome`, `duplicate`, `redelivered`, `alert` and `attempts` — at `debug` for `created` and `applied`, at `info` when the outcome is `stale` or `duplicate` is true. There is no separate `resumed` line: a resume shows as `store ready` followed by `consumer registered`.                                                                                                                                         | Spec decision 22 fixes the levels, not the line names; one line keeps the log grep-able.                                                                                                                                                                                                                                  |
| A14 | The ack result carries `gap: boolean`, so the consumer counts `gaps` without parsing log lines.                                                                                                                                                                                                                                                                                                                                                                                 | Spec decision 23 lists `gaps` among the counters.                                                                                                                                                                                                                                                                         |
| A15 | `main.test.ts` runs the child with `MONGODB_TIMEOUT_MS=300`, so the first `store not ready` line arrives within a second; it makes no readiness check during the drain, because nothing is in flight and the drain is instant.                                                                                                                                                                                                                                                  | `serverSelectionTimeoutMS` is what bounds a connect to a closed port; the ingest test could hold a device socket open, processing has nothing equivalent without a broker.                                                                                                                                                |
| A16 | The scripted run starts both containers with `docker run` (Compose is step 6) and random credentials generated in the script, runs the built `dist/main.js` with `MONGODB_TIMEOUT_MS=1000`, `AMQP_HEARTBEAT_S=2`, `PROCESSING_TRANSIENT_ATTEMPTS=3`, `SHUTDOWN_TIMEOUT_MS=3000`, `LOG_LEVEL=debug`, publishes straight to the exchange through amqplib and reads MongoDB through the driver; its evidence goes into this plan's `STATUS` header. Credentials are never printed. | Spec decision 27; ingest plan A3, A6 and A8; the shorter timeouts keep the outage scenarios under a minute.                                                                                                                                                                                                               |
| A17 | The catalog entry `mongodb: 7.6.0` goes in alphabetically (after `eslint-config-prettier`, before `pino`); no other dependency is added, `amqplib` ships its own types.                                                                                                                                                                                                                                                                                                         | Spec decision 2 (vetted 2026-09-13); ingest plan A2.                                                                                                                                                                                                                                                                      |
| A18 | The test count baseline is the number `pnpm test` prints at Task 1 (574 at `95f4d98`); Task 2 keeps it unchanged (moved tests, none duplicated).                                                                                                                                                                                                                                                                                                                                | The handover of 2026-09-13.                                                                                                                                                                                                                                                                                               |

## Research (source links)

The design spec's Research section covers the driver options (`MongoClientOptions`, `WriteConcernSettings`, `FindOneAndUpdateOptions`, `InsertOneOptions`, `CreateIndexesOptions`), `MongoClient.connect()`/`close()`, the server error codes, the `createIndexes` conflict codes, the amqplib channel API pages, the field-table codec, the RabbitMQ 4.3 consumer-timeout post, the consumers guide, `max_message_size` and Node's `timers/promises`; those links are not repeated. This plan adds the typing facts it needs and two corrections of the spec.

- [amqplib `index.d.ts` at v2.0.1](https://github.com/amqp-node/amqplib/blob/v2.0.1/index.d.ts) — `ChannelModel#createChannel(options?: ChannelOptions): Promise<Channel>`; `Channel#consume(queue: string, onMessage: (msg: ConsumeMessage | null) => void, options?: Options.Consume): Promise<Replies.Consume>`; `cancel(consumerTag: string): Promise<Replies.Empty>`; `ack(message: Message, allUpTo?: boolean): void`; `nack(message: Message, allUpTo?: boolean, requeue?: boolean): void`; `reject(message: Message, requeue?: boolean): void`; `prefetch(count: number, global?: boolean): Promise<Replies.Empty>`; a channel's `close` listener is `() => void` (no error argument, unlike the model's `(err?: Error) => void`); `error`, `handler-error` and `cancel` events are typed. Tasks 11 and 13.
- [amqplib `lib/properties.d.ts` at v2.0.1](https://github.com/amqp-node/amqplib/blob/v2.0.1/lib/properties.d.ts) — `ConsumeMessage extends Message` with `fields: ConsumeMessageFields = { deliveryTag: number; redelivered: boolean; exchange: string; routingKey: string; consumerTag: string }`; `properties.headers: MessagePropertyHeaders | undefined`, whose values are `any` (`[key: string]: any`) — read into `unknown` (A8); `Options.Consume = { consumerTag?, noLocal?, noAck?, exclusive?, priority?, arguments? }`; `Replies.Consume = { consumerTag: string }`; `MessagePropertyHeaders['x-death']?: XDeath[]` with `reason: 'rejected' | 'expired' | 'maxlen'` and `queue` (Task 13, scenario 7). Tasks 4, 11 and 13.
- [`Db#command` (driver 7.6)](https://mongodb.github.io/node-mongodb-native/7.6/classes/Db.html#command) — `command(command: Document, options?: { readPreference?; session?; timeoutMS? } & BSONSerializeOptions & Abortable): Promise<Document>`; **no `maxTimeMS` option** (the spec's `{ maxTimeMS }` on the ping is a spec error, A7). [Server `generic_argument.idl`](https://github.com/mongodb/mongo/blob/master/src/mongo/idl/generic_argument.idl) — `maxTimeMS` is in `GenericArguments` (`type: exactInt64`, `validator: {gte: 0, lte: 2147483647}`, `forward_to_shards: true`, `stability: "stable"`), so `{ ping: 1, maxTimeMS }` is accepted by the server. Task 9.
- [`Collection` (driver 7.6)](https://mongodb.github.io/node-mongodb-native/7.6/classes/Collection.html) — `findOneAndUpdate(filter, update: Document[] | UpdateFilter<TSchema>, options: FindOneAndUpdateOptions): Promise<WithId<TSchema> | null>` (the `ModifyResult` overload needs `includeResultMetadata: true`); `insertOne(doc: OptionalUnlessRequiredId<TSchema>, options?: InsertOneOptions): Promise<InsertOneResult<TSchema>>`; `createIndex(indexSpec: IndexSpecification, options?: CreateIndexesOptions): Promise<string>`. `WithId<DeviceStateDocument>` has `_id: string`, so the returned document is a `DeviceStateDocument`. Task 9.
- [Driver `src/error.ts` at v7.6.0](https://github.com/mongodb/node-mongodb-native/blob/v7.6.0/src/error.ts) — constructors: `MongoServerError(message: ErrorDescription)` where `ErrorDescription = { message?, errmsg?, $err?, errorLabels?: string[], errInfo? } & Document` and every other own property of the description (so `code`, `codeName`) is copied onto the error; `MongoNetworkError(message: string, options?)`; `MongoNetworkTimeoutError extends MongoNetworkError` (same signature); `MongoServerSelectionError(message: string, reason: TopologyDescription)`; `MongoClientClosedError()`; `MongoNotConnectedError(message: string)`; `MongoTopologyClosedError(message = 'Topology is closed')`; `MongoWriteConcernError(result: WriteConcernErrorResult) extends MongoServerError`; `MongoError#errorLabels: string[]` and `hasErrorLabel(label)`. Every constructor is "Do not use this constructor! … not subject to semantic versioning" — the tripwire tests of Task 9 exist because of that. Task 9.
- [Driver `src/index.ts` at v7.6.0](https://github.com/mongodb/node-mongodb-native/blob/v7.6.0/src/index.ts) — value exports of `MongoServerError`, `MongoNetworkError`, `MongoNetworkTimeoutError`, `MongoServerSelectionError`, `MongoClientClosedError`, `MongoNotConnectedError`, `MongoTopologyClosedError`, `MongoWriteConcernError`, `ReturnDocument`, `ServerType`, `TopologyType`; **`TopologyDescription` is `export type` only** (A6). Task 9.
- typescript-eslint 8.70.0, `node_modules/.pnpm/@typescript-eslint+eslint-plugin@8.70.0_*/node_modules/@typescript-eslint/eslint-plugin/dist/configs/flat/recommended-type-checked.js` (the preset `eslint.config.js` extends) — turns on `only-throw-error`, `prefer-promise-reject-errors`, `require-await`, `no-floating-promises`, `no-misused-promises`. Consequences: `StoreError extends Error` (A2); the in-memory `TestStore` returns `Promise.resolve(...)`/`Promise.reject(...)` from non-`async` methods; every dispatched promise is `void`-ed on purpose. Tasks 5, 9, 10, 11.
- `packages/shared/src/config.ts:45` — `envInt({ min, max?, defaultValue })`, `.max()` before `.default()`, bounds checked at import time; `:148` `mongodbEnv` (`MONGODB_URL`, `MONGODB_DB`, `MONGODB_WRITE_W: 'majority' | number`, `MONGODB_TIMEOUT_MS`). Task 3.
- `packages/shared/src/framing.ts:4,59` — `MAX_FRAME_BYTES = 64 * 1024`; `decodeUtf8Strict(bytes: Uint8Array): { ok: true; text } | { ok: false; detail }`; `decode.ts:33` `decodeTelemetryMessage(text): DecodeResult` with `identity: RawIdentity` on failure. Task 4.
- `packages/shared/src/identity.ts:38` — `isNewer(candidate: OrderKey, stored: OrderKey)`, the single definition of "newer"; `:21` `messageIdentity`. `collections.ts` — `EVENTS_IDENTITY_INDEX_SPEC = { key, name: 'identity_unique', unique: true }`, `DUPLICATE_KEY_ERROR_CODE = 11000`. `documents.ts` — `EventDocument` (no `_id`), `DeviceStateDocument` (`_id: string`), `AlertDocument` (`_id: string`), `SectionMeta`, `LastEvent`. Tasks 6, 9, 10.
- `packages/shared/src/settle.ts:14` — `settleWithin(promise, timeoutMs): Promise<Settled<T>>`, never rejects, clears its timer. `backoff.ts:25` — `backoffDelay({ attempt, baseMs, maxMs, random })`. `lifecycle.ts:36` — `createLifecycleHandlers({ logger, shutdown, exit })`, `FAILURE_EXIT_CODE`. `logger.ts:221,230` — `messageLogger(logger, identity)`, `rejectedMessageLogger(logger, rawIdentity)`; a raw `.child()` fails lint. Tasks 9–12.
- `apps/ingest/src/publisher.ts` — the shell pattern the consumer mirrors: the `#dispatch` queue (`:229`), listeners with the generation captured in a closure (`:403`, `:438`), `#mayContinue` after every await (`:368`), `nextTurn()` before a close (`:607`), `settleWithin` on connect setup and close (`:307`, `:616`), the backoff `warn` line (`:638`). `apps/ingest/src/main.test.ts` — the child-process test (`--experimental-transform-types --import test-source-hooks.ts`, `expect.soft`, `freePorts`). `apps/ingest/src/health.ts` and `health.test.ts` — the server and the ten cases that move. Tasks 2, 11, 12.
- Docker (checked 2026-09-13): `docker info` answers (server 29.4.0, OrbStack); `docker manifest inspect mongo:8.0` resolves; `rabbitmq:4.3-management` is already pulled, `mongo:8.0` is not. Task 13.

## File Changes

| Action | Path                                                                           | Purpose                                                                                                             |
| ------ | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| Create | `docs/plans/2026-09-13-processing-plan.md`                                     | This plan (Task 1)                                                                                                  |
| Modify | `docs/specs/2026-09-11-telemetry-consistency-design.md`                        | Step 5 log-level amendment (Task 1); rows T44–T49 (Task 14)                                                         |
| Modify | `docs/specs/2026-09-11-shared-contract-design.md`                              | Package layout: `health.ts` (Task 1)                                                                                |
| Modify | `docs/specs/2026-09-13-ingest-design.md`                                       | Decision 17 and the module table: the server is imported from shared (Task 1)                                       |
| Modify | `docs/specs/2026-09-13-processing-design.md`                                   | Decision 22 and the Tests section's scenario 8: no separate `resumed` line (Task 1, A13)                            |
| Modify | `TODO.md`                                                                      | Step 7 item (Task 1); step 5 ticks and note (Task 14)                                                               |
| Create | `packages/shared/src/health.ts`, `packages/shared/src/health.test.ts`          | The readiness server, moved from ingest; `ReadinessReport<Reason>` generic (decision 3)                             |
| Modify | `packages/shared/src/index.ts`                                                 | `export * from './health.js'`                                                                                       |
| Modify | `apps/ingest/src/health.ts`, `apps/ingest/src/health.test.ts`                  | Keep `readinessReport` and its cases only                                                                           |
| Modify | `apps/ingest/src/main.ts`                                                      | Import `startHealthServer` from shared                                                                              |
| Modify | `pnpm-workspace.yaml`, `pnpm-lock.yaml`                                        | Catalog entry `mongodb: 7.6.0` (decision 2)                                                                         |
| Modify | `apps/processing/package.json`                                                 | `amqplib`, `mongodb`, `zod` (catalog); `vitest` dev dependency                                                      |
| Create | `apps/processing/src/config.ts`, `config.test.ts`                              | `loadProcessingConfig` (decision 24)                                                                                |
| Create | `apps/processing/src/fixtures.ts`                                              | Test support: one message per type, the expected documents (decision 25)                                            |
| Create | `apps/processing/src/delivery.ts`, `delivery.test.ts`                          | `decodeDelivery` (decision 14)                                                                                      |
| Create | `apps/processing/src/failure.ts`, `failure.test.ts`                            | `StoreFailure`, `StoreError`, `classifyFailure` (decision 9)                                                        |
| Create | `apps/processing/src/state-update.ts`, `state-update.test.ts`                  | `buildStateUpdate`, `newerThanStoredExpr`, `classifyOutcome`, `detectGap` (decisions 16–18)                         |
| Create | `apps/processing/src/consumer-state.ts`, `consumer-state.test.ts`              | The consumer state machine (decisions 5, 6, 12, 20)                                                                 |
| Create | `apps/processing/src/health.ts`, `health.test.ts`                              | `readinessReport` for processing (decision 19)                                                                      |
| Create | `apps/processing/src/store.ts`, `store.test.ts`                                | `StorePort`, `MongoStore`, `describeMongoError` (decisions 8–11)                                                    |
| Create | `apps/processing/src/handler.ts`, `handler.test.ts`, `test-store.ts`           | `processDelivery` and the in-memory port (decisions 13, 15–17, 22)                                                  |
| Create | `apps/processing/src/consumer.ts`, `consumer.test.ts`                          | `AmqpConsumer`, the amqplib shell (decisions 4–7, 12, 20, 23)                                                       |
| Modify | `apps/processing/src/main.ts`                                                  | Entry point (decisions 20, 21)                                                                                      |
| Create | `apps/processing/src/main.test.ts`, `apps/processing/src/test-source-hooks.ts` | Child-process test of the entry point; the source hooks it needs (a copy of ingest's, apps never import each other) |
| Create | `.local/research/2026-09-13-processing-scripted-run.mjs`                       | The scripted run (gitignored; evidence goes into this plan's header)                                                |

## Tasks

### Task 1: Commit the plan and the spec amendments [mechanical]

**Files:** Create `docs/plans/2026-09-13-processing-plan.md` (this document, unchanged); modify `docs/specs/2026-09-11-telemetry-consistency-design.md`, `docs/specs/2026-09-11-shared-contract-design.md`, `docs/specs/2026-09-13-ingest-design.md`, `docs/specs/2026-09-13-processing-design.md`, `TODO.md`
**Invariant:** none touched.
**Verify:** `pnpm format:check && git status --short` (clean after the commit)

The spec's section "Amendments to earlier specs" names five edits; `grep` shows none of them applied. Apply exactly these, plus the one edit of the processing spec itself that assumption A13 requires:

- [ ] Consistency spec, section "Processing", handler step 5 (line 172): replace `Log at info: identity, type, outcome of step 3, `duplicate`, `redelivered` flag.` with `Log the outcome with the identity, `type`, the outcome of step 3, `duplicate`and`redelivered`—`created`and`applied`at`debug`, `stale`and`duplicate`at`info` (processing spec, 2026-09-13, decision 22).`
- [ ] Shared-contract spec, "Package layout after step 2" (the code block at lines 79–94): add the line `  health.ts            startHealthServer, HealthServer, ReadinessReport<Reason>, READINESS_PATH, HEALTH_IDLE_TIMEOUT_MS (moved from ingest on 2026-09-13, processing spec decision 3)` after the `config.ts` line, aligned like the others.
- [ ] Ingest spec, decision 17 (line 43): append to the decision cell the sentence `Since 2026-09-13 the server lives in `packages/shared/src/health.ts`and ingest keeps only`readinessReport` (processing spec, decision 3).`; module table row for `health.ts` (line 118): replace the third cell with `` `readinessReport({ publisherState, shuttingDown })` (decision 17); the server is `startHealthServer` from shared since 2026-09-13 ``.
- [ ] Processing spec, decision 22 (the lifecycle list `consumer registered`, `consumer cancelled`, `resumed`, `stopped`): replace `resumed` with `a resume shows as `store ready`followed by`consumer registered``; and in the Tests section, scenario 8, replace `; `resumed`;` with `; `store ready`then`consumer registered`;` (A13: one registration line per `consume`, no separate `resumed` line).
- [ ] `TODO.md`, step 7: after the ingest publisher item (line 112) add `- [ ] Test: processing consumer proti skutečnému RabbitMQ a MongoDB — dvanáct scénářů skriptovaného běhu: normální tok, duplicita, pořadí uvnitř sekce i napříč sekcemi, restart session, dvě instance, poison zprávy, zastavená a zamrzlá MongoDB (pauza a obnovení konzumace), restart brokeru, SIGTERM s rozpracovanými zprávami, špatné přihlašovací údaje (processing spec 2026-09-13, rozhodnutí 27).`
- [ ] `pnpm format:check` passes (prettier reformats the tables; the amended files are formatted, not hand-aligned).
- [ ] Commit all six files: `Add the processing service implementation plan`

### Task 2: Move the readiness server to the shared package [integration]

**Files:** Create `packages/shared/src/health.ts`, `packages/shared/src/health.test.ts`; modify `packages/shared/src/index.ts`, `apps/ingest/src/health.ts`, `apps/ingest/src/health.test.ts`, `apps/ingest/src/main.ts`
**Invariant:** none touched; ingest's readiness answers stay identical (its `readinessReport` cases stay green).
**Verify:** `pnpm --filter @telemetry/shared test && pnpm --filter @telemetry/shared typecheck && pnpm --filter @telemetry/shared lint && pnpm --filter @telemetry/ingest test && pnpm --filter @telemetry/ingest typecheck && pnpm --filter @telemetry/ingest lint`

```ts
// packages/shared/src/health.ts
export const READINESS_PATH = '/readyz';
export const HEALTH_IDLE_TIMEOUT_MS = 10_000;
export type ReadinessReport<Reason extends string> =
  { ready: true } | { ready: false; reason: Reason };
export type HealthServer = { port: number; close(): Promise<void> };
export type HealthServerOptions<Reason extends string> = {
  port: number;
  /** Called on every `GET /readyz` request, so the answer always reflects the current state. */
  report: () => ReadinessReport<Reason>;
  logger: Logger;
  /** Defaults to HEALTH_IDLE_TIMEOUT_MS; only the tests shorten it. */
  idleTimeoutMs?: number;
};
export function startHealthServer<Reason extends string>(
  options: HealthServerOptions<Reason>,
): Promise<HealthServer>;
```

Rules: the server, `send` and `closeServer` move unchanged from `apps/ingest/src/health.ts` with their comments (the `http.Server#timeout` note, the `closeAllConnections()` note and its probe reference). `Logger` is imported from `./logger.js`. `index.ts` adds `export * from './health.js';` after `settle.js`.

Ingest keeps in `apps/ingest/src/health.ts`:

```ts
export type IngestReadinessReason = 'connecting' | 'blocked' | 'shutting_down';
export function readinessReport({
  publisherState,
  shuttingDown,
}: {
  publisherState: PublisherState;
  shuttingDown: boolean;
}): ReadinessReport<IngestReadinessReason>;
```

with `ReadinessReport` imported as a type from `@telemetry/shared`; `main.ts` imports `startHealthServer` and `type HealthServer` from `@telemetry/shared` (the `report` closure is unchanged). Run `grep -rn "from './health.js'" apps/ingest/src` and fix every import.

- [ ] Move the ten `startHealthServer` cases of `apps/ingest/src/health.test.ts` (lines 87–232) to `packages/shared/src/health.test.ts` unchanged, with the three reasons `'connecting' | 'blocked' | 'shutting_down'` kept as sample strings of the generic parameter: (1) 200 and the JSON body while ready; (2) 503 with each reason; (3) the report is asked on every request; (4) a query string is accepted; (5) `GET /healthz`, `POST /readyz`, `PUT /readyz` → 404 with `{}`; (6) `HEAD /readyz` → 404; (7) a port in use rejects with `EADDRINUSE`; (8) `close()` resolves with a pipelined in-flight request (the 10 s test timeout stays, with a one-line comment that the bound is the 2 s race plus slack); (9) the port is free after `close()`; (10) the idle timeout closes a silent connection. Ingest's `health.test.ts` keeps only the `readinessReport` describe (the `STATES` table).
- [ ] Verify the shared test file fails (module missing).
- [ ] Implement the move; delete the moved code from ingest.
- [ ] Verify tests pass in both packages; the total test count is unchanged (A18).
- [ ] Commit: `Move the readiness server to the shared package`

### Task 3: Processing dependencies and configuration [mechanical]

**Files:** Modify `pnpm-workspace.yaml`, `pnpm-lock.yaml`, `apps/processing/package.json`; create `apps/processing/src/config.ts`, `apps/processing/src/config.test.ts`
**Invariant:** none touched.
**Verify:** `pnpm install && pnpm --filter @telemetry/processing test && pnpm --filter @telemetry/processing typecheck && pnpm --filter @telemetry/processing lint`

`pnpm-workspace.yaml` catalog gains `mongodb: 7.6.0` (A17). `apps/processing/package.json` `dependencies` gains `"amqplib": "catalog:"`, `"mongodb": "catalog:"`, `"zod": "catalog:"`; `devDependencies: { "vitest": "catalog:" }`; the scripts stay. `pnpm install` adds `mongodb@7.6.0` with `bson`, `@mongodb-js/saslprep`, `mongodb-connection-string-url` and their dependencies to the lockfile; none of the optional peers (`socks`, `snappy`, `kerberos`, `gcp-metadata`, `@mongodb-js/zstd`, `mongodb-client-encryption`, `@aws-sdk/credential-providers`) is installed — check with `pnpm why kerberos` (no result).

```ts
// apps/processing/src/config.ts
export const processingEnvSchema = z.object({
  ...logLevelEnv,
  ...shutdownEnv,
  ...rabbitmqEnv,
  ...healthEnv,
  ...mongodbEnv,
  /** Unacknowledged deliveries per instance, the concurrency of handlers; 2 000 is the quorum-queue cap. */
  PROCESSING_PREFETCH: envInt({ min: 1, max: 2_000, defaultValue: 50 }),
  /** Consecutive transient failures of one handler before the instance pauses (decision 12). */
  PROCESSING_TRANSIENT_ATTEMPTS: envInt({ min: 1, defaultValue: 5 }),
});
export type ProcessingConfig = z.output<typeof processingEnvSchema>;
export function loadProcessingConfig(env: NodeJS.ProcessEnv = process.env): ProcessingConfig;
```

Same rules as ingest: no type annotation on the schema, `z.object` never `.strict()`, `loadConfig` throws `ConfigError` naming the variable, never its value; the entry point does not catch it. Every test sets `RABBITMQ_URL=amqp://localhost` and `MONGODB_URL=mongodb://localhost`, because both are required.

- [ ] Write failing tests in `config.test.ts`: (1) defaults — `LOG_LEVEL` `info`, `SHUTDOWN_TIMEOUT_MS` 10 000, `AMQP_HEARTBEAT_S` 10, `HEALTH_PORT` 8080, `MONGODB_DB` `telemetry`, `MONGODB_WRITE_W` 1, `MONGODB_TIMEOUT_MS` 5 000, `PROCESSING_PREFETCH` 50, `PROCESSING_TRANSIENT_ATTEMPTS` 5; (2) a missing `RABBITMQ_URL` is rejected with a `ConfigError` whose `problems` entry names `RABBITMQ_URL`; (3) a missing `MONGODB_URL` is rejected naming `MONGODB_URL`, and no `problems` entry contains the value `amqp://localhost`; (4) `PROCESSING_PREFETCH=0` and `=2001` are rejected naming the variable, `=1` and `=2000` are accepted; (5) `PROCESSING_TRANSIENT_ATTEMPTS=0` is rejected, `=1` accepted; (6) `MONGODB_WRITE_W=majority` gives the string `majority` and `=3` the number 3; (7) values are trimmed (`PROCESSING_PREFETCH=' 7 '` gives 7).
- [ ] Verify tests fail
- [ ] Implement
- [ ] Verify tests pass
- [ ] Commit: `Add the processing configuration and its dependencies`

### Task 4: Delivery decoding [mechanical]

**Files:** Create `apps/processing/src/fixtures.ts`, `apps/processing/src/delivery.ts`, `apps/processing/src/delivery.test.ts`
**Invariant:** 2 passes through — the identity reaches the handler from the validated body, never from the AMQP `messageId` (case 1 asserts the decoded message equals the input; nothing reads `properties`).
**Verify:** `pnpm --filter @telemetry/processing test && pnpm --filter @telemetry/processing typecheck && pnpm --filter @telemetry/processing lint`

```ts
// fixtures.ts — not named *.test.ts (the unit project would report an empty suite)
export const EXAMPLE_RECEIVED_AT = 1_700_000_000_600;
export const EXAMPLE_PROCESSED_AT = 1_700_000_000_700;
/** One valid message per type, deviceId dev-0001, sessionId 1_700_000_000_000, seq 1–4 (ingest's literals). */
export const exampleMessages: { [T in TelemetryEventType]: TelemetryMessageOf<T> };
/** The EventDocument each message produces with EXAMPLE_RECEIVED_AT and EXAMPLE_PROCESSED_AT. */
export const exampleEvents: { [T in TelemetryEventType]: EventDocument };
/** The alert of the diagnostic message (severity error, code E_OVERHEAT). */
export const exampleAlert: AlertDocument;
/** The device_state document after the four messages in seq order: four sections and lastEvent = the diagnostic's key. */
export const exampleState: DeviceStateDocument;
```

```ts
// delivery.ts
export type DecodedDelivery = {
  message: TelemetryMessage;
  receivedAt: number;
  receivedAtSource: 'header' | 'clock';
  redelivered: boolean;
};
export type DeliveryRejectionReason =
  'body_too_large' | 'invalid_utf8' | 'invalid_json' | 'invalid_schema';
export type DeliveryRejection = {
  reason: DeliveryRejectionReason;
  detail: string;
  identity: RawIdentity;
  bytes: number;
};
export type DeliveryInput = {
  content: Buffer;
  headers: Record<string, unknown> | undefined;
  redelivered: boolean;
  /** Read only when the header is unusable. */
  clock: () => number;
};
export type DecodeDeliveryResult =
  { ok: true; delivery: DecodedDelivery } | { ok: false; rejection: DeliveryRejection };
export function decodeDelivery(input: DeliveryInput): DecodeDeliveryResult;
```

Rules (decision 14): `content.length > MAX_FRAME_BYTES` → `body_too_large` with `detail` `` `${bytes} bytes exceed the limit of ${MAX_FRAME_BYTES}` `` and `identity: {}`, before anything is decoded; then `decodeUtf8Strict(content)` → `invalid_utf8` with its `detail`; then `decodeTelemetryMessage(text)` → `invalid_json` / `invalid_schema` with its `detail` and `identity`. The header `headers?.[RECEIVED_AT_HEADER]` is used when `typeof value === 'number' && Number.isSafeInteger(value) && value >= 0`, otherwise `clock()` with `receivedAtSource: 'clock'`. `bytes` is `content.length` on every rejection. Pure, no logging.

- [ ] Write failing tests using `exampleMessages`: (1) each of the four messages as `Buffer.from(JSON.stringify(message), 'utf8')` with headers `{ 'x-received-at': EXAMPLE_RECEIVED_AT }` decodes to a message deep-equal to the input, `receivedAt` from the header, `receivedAtSource` `header`, and `redelivered` passed through for `true` and `false`; (2) a 65 537-byte body that is valid JSON with a 65 500-byte unknown key (schema-invalid) is rejected as `body_too_large` with `bytes` 65 537 — the size check runs before JSON and schema; (3) the diagnostic message with the byte `0xff` inside `payload.message` (build the buffer by concatenation) → `invalid_utf8`, non-empty `detail`, `identity` `{}`; (4) `not json` → `invalid_json`; (5) `{"type":"bogus","deviceId":"dev-0001","sessionId":1700000000000,"seq":9}` → `invalid_schema` with `identity` `{ deviceId: 'dev-0001', sessionId: 1700000000000, seq: 9 }`; (6) the clock is used, with `receivedAtSource` `clock`, for headers `undefined`, a missing key, `-1`, `1.5`, the string `'1700000000600'`, `2 ** 53` and `true` (an `it.each`), and the clock is not called in case 1; (7) header `0` counts as a header value.
- [ ] Verify tests fail
- [ ] Implement `fixtures.ts` and `delivery.ts`
- [ ] Verify tests pass
- [ ] Commit: `Decode one AMQP delivery into a validated message`

### Task 5: Failure classification [mechanical]

**Files:** Create `apps/processing/src/failure.ts`, `apps/processing/src/failure.test.ts`
**Invariant:** none touched (the failure table of the spec: a good message is never dead-lettered for a transient failure — case 1–3 prove every transient view is `transient`).
**Verify:** `pnpm --filter @telemetry/processing test && pnpm --filter @telemetry/processing typecheck && pnpm --filter @telemetry/processing lint`

```ts
export type StoreFailure =
  | { kind: 'server'; code: number | undefined; codeName: string | undefined; labels: readonly string[]; message: string }
  | { kind: 'network'; message: string }
  | { kind: 'server_selection'; message: string }
  | { kind: 'closed'; message: string }
  | { kind: 'other'; name: string; message: string };
/** What a store port method rejects with: the structural view, never a driver class (A2). */
export class StoreError extends Error {
  override readonly name = 'StoreError';
  constructor(readonly failure: StoreFailure); // super(failure.message)
}
export type FailureClass = 'transient' | 'permanent' | 'closed';
export const RETRYABLE_WRITE_LABEL = 'RetryableWriteError';
/** LockTimeout, MaxTimeMSExpired, WriteConcernTimeout, ShutdownInProgress, ExceededTimeLimit, NotWritablePrimary, InterruptedAtShutdown. */
export const TRANSIENT_SERVER_CODES: ReadonlySet<number> = new Set([24, 50, 64, 91, 262, 10107, 11600]);
export function classifyFailure(failure: StoreFailure): FailureClass;
```

Rules: the spec's table (decision 9) — `network`, `server_selection` → `transient`; `server` with the label or a listed code → `transient`; `closed` → `closed`; every other `server` and `other` → `permanent`. A `switch` on `kind` with `assertNever`.

- [ ] Write failing tests: (1) `network` and `server_selection` → `transient`; (2) `server` with `labels: ['RetryableWriteError']` and `code` undefined → `transient`; (3) each of the seven codes → `transient` (an `it.each`); (4) `server` with code 121 (`DocumentValidationFailure`), 18 (`AuthenticationFailed`), 11000, and no code → `permanent`; (5) `closed` → `closed`; (6) `other` → `permanent`; (7) `new StoreError(failure)` is an `Error` with `name` `StoreError`, `message` equal to the view's message and `failure` the same object.
- [ ] Verify tests fail
- [ ] Implement
- [ ] Verify tests pass
- [ ] Commit: `Classify MongoDB failures for the processing handler`

### Task 6: The conditional state update [mechanical]

**Files:** Create `apps/processing/src/state-update.ts`, `apps/processing/src/state-update.test.ts`
**Invariant:** 1 and 3 — the guard is the server-evaluated `$or` derived from `isNewer` (cases 1–2 prove the two agree on every case of the consistency spec); the update is one pipeline on the `_id` filter, no read before it. 2 — an equal key is not newer (case 1d).
**Verify:** `pnpm --filter @telemetry/processing test && pnpm --filter @telemetry/processing typecheck && pnpm --filter @telemetry/processing lint`

```ts
export type StateUpdate = {
  filter: { _id: string };
  /** The consistency spec's pipeline: one $set with the section and lastEvent, both under $cond. Driver-free; mutable, because the driver's parameter is `Document[]`, and a readonly array is not assignable to it. */
  pipeline: Record<string, unknown>[];
};
export type StateOutcome = 'created' | 'applied' | 'stale';
export type SequenceGap = { previousSeq: number; seq: number };
/** `{ $or: [missing, older session, same session and lower seq] }` for `$${path}` (consistency spec, "The conditional upsert"). */
export function newerThanStoredExpr(path: string, key: OrderKey): Record<string, unknown>;
export function buildStateUpdate(message: TelemetryMessage, receivedAt: number): StateUpdate;
/** null → created; section absent or isNewer(message, before[type]) → applied; otherwise stale (decision 16). */
export function classifyOutcome(
  before: DeviceStateDocument | null,
  message: TelemetryMessage,
): StateOutcome;
/** Defined only when before.lastEvent has the same sessionId and message.seq > lastEvent.seq + 1 (decision 17). */
export function detectGap(
  before: DeviceStateDocument | null,
  message: TelemetryMessage,
): SequenceGap | undefined;
```

Rules: `next = { sessionId, seq, occurredAt, receivedAt, ...payload }` under `{ $literal: next }`, `else: `$${type}``; `lastEvent` `then` is `{ $literal: { sessionId, seq, type, receivedAt } }`, `else: '$lastEvent'`; the three `$or` branches verbatim from the consistency spec (`$type` … `'missing'`, `$lt` on `sessionId`, `$and` of `$eq` on `sessionId` and `$lt` on `seq`). Both functions are pure over the shared types; no `mongodb` import in this module.

- [ ] Write failing tests: (1) a tiny evaluator in the test file (`$or`, `$and`, `$eq`, `$lt`, `$type` returning `'missing'` for an absent path, `$`-prefixed field paths with dots, literals) runs `newerThanStoredExpr('metrics', key)` against the five documents of the consistency spec — (a) no `metrics` section, (b) older session, (c) same session and lower `seq`, (d) the same key, (e) newer session with a lower `seq` — and asserts each answer equals `isNewer(key, stored)` (true for (a)); (2) the same five for `newerThanStoredExpr('lastEvent', key)`; (3) `buildStateUpdate(exampleMessages.diagnostic with message '$set me', EXAMPLE_RECEIVED_AT)` has `filter { _id: 'dev-0001' }`, one stage, and the diagnostic section's `then` is `{ $literal: { sessionId, seq, occurredAt, receivedAt, severity, code, message: '$set me' } }` with `else` `'$diagnostic'`, and `lastEvent`'s `then` is `{ $literal: { sessionId, seq, type: 'diagnostic', receivedAt } }`; (4) `classifyOutcome` for `null` → `created`, a document without the section → `applied`, an older stored key → `applied`, the same key → `stale`, a newer stored key → `stale`; (5) `detectGap` for `null`, no `lastEvent`, another session, contiguous (`seq` = `lastEvent.seq + 1`), a gap (`seq` = `lastEvent.seq + 3` → `{ previousSeq, seq }`), a stale message (`seq` < `lastEvent.seq`) and the same `seq`.
- [ ] Verify tests fail
- [ ] Implement
- [ ] Verify tests pass
- [ ] Commit: `Build the conditional device-state update and classify its outcome`

### Task 7: The consumer state machine [mechanical]

**Files:** Create `apps/processing/src/consumer-state.ts`, `apps/processing/src/consumer-state.test.ts`
**Invariant:** 4 and 6 — the consumer is registered only while the link is open and the store is ready (`isConsuming`, cases 8–9), nothing in the state is keyed by device; the failure table's "MongoDB down" and "broker cancels the consumer" rows are the rows of this table (cases 3–5).
**Verify:** `pnpm --filter @telemetry/processing test && pnpm --filter @telemetry/processing typecheck && pnpm --filter @telemetry/processing lint`

```ts
type Flags = { generation: number; storeReady: boolean };
export type ConsumerState =
  | ({ name: 'backoff'; attempt: number } & Flags)
  | ({ name: 'connecting'; attempt: number } & Flags)
  | ({ name: 'open'; consumer: 'idle' | 'active'; attempt: number; openedAt: number } & Flags)
  | ({ name: 'draining' } & Flags)
  | ({ name: 'stopped' } & Flags);
export type ConsumerEvent =
  | { type: 'backoff_elapsed'; generation: number }
  | { type: 'link_opened'; generation: number; now: number }
  | { type: 'link_failed'; generation: number; reason: string }
  | { type: 'link_closed'; generation: number; reason: string; now: number }
  | { type: 'consumer_registered'; generation: number }
  | { type: 'broker_cancelled'; generation: number }
  | { type: 'drained'; generation: number }
  | { type: 'store_ready' }
  | { type: 'store_unavailable' }
  | { type: 'stop' };
export type Effect =
  | { kind: 'open_link' }
  | { kind: 'schedule_backoff'; attempt: number; reason: string }
  | { kind: 'consume' }
  | { kind: 'cancel_consumer' }
  | { kind: 'abort_handlers' }
  | { kind: 'return_held' }
  | { kind: 'watch_store' }
  | { kind: 'close_link' };
export type Transition = { state: ConsumerState; effects: Effect[] };
/** An open link resets the backoff attempt once it stayed open this long (decision 6). */
export const LINK_RESET_AFTER_MS = 10_000;
export const INITIAL_STATE: ConsumerState = {
  name: 'backoff',
  attempt: 0,
  generation: 0,
  storeReady: false,
};
export function transition(state: ConsumerState, event: ConsumerEvent): Transition;
/** open, active and storeReady: the input of the readiness report. */
export function isConsuming(state: ConsumerState): boolean;
```

Rows (the spec's table, with A3–A4; `switch` on `state.name` and `assertNever`, the `switch-exhaustiveness-check` rule):

| State                                  | Event                                                                                                                                                                                | Next state                                                                          | Effects                                                                 |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `backoff`                              | `backoff_elapsed`                                                                                                                                                                    | `connecting`, generation + 1, attempt kept                                          | `open_link`                                                             |
| `connecting`                           | `link_opened`                                                                                                                                                                        | `open`/`idle`, `openedAt = now`, attempt kept                                       | `consume` if `storeReady`                                               |
| `connecting`                           | `link_failed`                                                                                                                                                                        | `backoff`, attempt + 1                                                              | `schedule_backoff { attempt: attempt + 1, reason }`                     |
| `open`/any                             | `link_closed`                                                                                                                                                                        | `backoff`, attempt = 0 if `now - openedAt >= LINK_RESET_AFTER_MS`, else attempt + 1 | `abort_handlers`, `schedule_backoff { attempt, reason }`                |
| `open`/`idle`                          | `consumer_registered`                                                                                                                                                                | `open`/`active`                                                                     | —                                                                       |
| `open`/`active`                        | `broker_cancelled`                                                                                                                                                                   | `open`/`idle`                                                                       | `abort_handlers`, then `consume` if `storeReady`                        |
| `open`/`active`                        | `store_unavailable`                                                                                                                                                                  | `open`/`idle`, `storeReady = false`                                                 | `cancel_consumer`, `abort_handlers`, `return_held`, `watch_store`       |
| `backoff`, `connecting`, `open`/`idle` | `store_unavailable`                                                                                                                                                                  | same, `storeReady = false`                                                          | `watch_store` only if `storeReady` was true                             |
| `backoff`, `connecting`, `open`/`idle` | `store_ready`                                                                                                                                                                        | same, `storeReady = true`                                                           | `consume` only if the state is `open`/`idle` and `storeReady` was false |
| `open`/`active`                        | `store_ready`                                                                                                                                                                        | same                                                                                | —                                                                       |
| `open`/any                             | `stop`                                                                                                                                                                               | `draining`, generation and `storeReady` kept                                        | `cancel_consumer` if `active`                                           |
| `backoff`                              | `stop`                                                                                                                                                                               | `stopped`                                                                           | —                                                                       |
| `connecting`                           | `stop`                                                                                                                                                                               | `stopped`                                                                           | `close_link`                                                            |
| `draining`                             | `drained`                                                                                                                                                                            | `stopped`                                                                           | `abort_handlers`, `close_link`                                          |
| `draining`                             | `link_closed`                                                                                                                                                                        | `stopped`                                                                           | `abort_handlers`                                                        |
| `draining`                             | `broker_cancelled`                                                                                                                                                                   | `draining`                                                                          | `abort_handlers`                                                        |
| `draining`                             | `consumer_registered`                                                                                                                                                                | `draining`                                                                          | `cancel_consumer`                                                       |
| `draining`                             | `store_ready`, `store_unavailable`                                                                                                                                                   | `draining`, flag updated                                                            | —                                                                       |
| `stopped`                              | anything                                                                                                                                                                             | `stopped`                                                                           | —                                                                       |
| any                                    | a generation-carrying event of another generation, or a same-generation pair without a row (for example `connecting` + `link_closed`, `open` + `link_opened`, `backoff` + `drained`) | same                                                                                | —                                                                       |

The `store_ready` guard "only if `storeReady` was false" keeps a second `store_ready` (the entry point's after `start()` and a watch's) from registering a second consumer on one channel. `stop` from `draining` or `stopped` changes nothing (the lifecycle handler exits on a second signal).

- [ ] Write failing tests, each as an event sequence with the expected state and the exact effect list in order: (1) every row above, one `it.each` case per state variant it applies to (the "any" rows for `idle` and `active`, the three-state rows for each of the three), 26 cases; (2) the start: `INITIAL_STATE` + `backoff_elapsed` → `connecting` with generation 1 and `open_link`; (3) the pause: `open`/`active` + `store_unavailable` yields exactly `[cancel_consumer, abort_handlers, return_held, watch_store]`, a second `store_unavailable` yields no effect, and `store_ready` then yields `[consume]` with `storeReady` true; (4) the broker cancel: `open`/`active` + `broker_cancelled` yields `[abort_handlers, consume]` and `consumer_registered` makes it `active` again; (5) the drain: `open`/`active` + `stop` → `draining` with `[cancel_consumer]`, then `drained` → `stopped` with `[abort_handlers, close_link]`; `open`/`idle` + `stop` → `draining` with no effect; (6) the reset rule: `link_closed` with `now - openedAt` of 10 000 gives attempt 0 and 9 999 gives attempt + 1; (7) generation: for every state variant, every generation-carrying event with `generation - 1` and with `generation + 1` returns the same state and no effects; (8) the no-row rule: a loop over every state variant × every event type with the current generation asserts that pairs not in the table return the same state and no effects — the table rows are listed once in the test as `(stateName, consumer, eventType)` triples and the loop skips them; (9) `isConsuming` is true only for `open`/`active` with `storeReady` true (every variant tested); (10) `stop` from every state ends in `stopped` or `draining`, and every later event on `stopped` returns it unchanged; (11) `link_opened` while `storeReady` is false yields no `consume`, and the following `store_ready` yields `[consume]`.
- [ ] Verify tests fail
- [ ] Implement
- [ ] Verify tests pass
- [ ] Commit: `Add the processing consumer state machine`

### Task 8: The readiness report [mechanical]

**Files:** Create `apps/processing/src/health.ts`, `apps/processing/src/health.test.ts`
**Invariant:** none touched.
**Verify:** `pnpm --filter @telemetry/processing test && pnpm --filter @telemetry/processing typecheck && pnpm --filter @telemetry/processing lint`

```ts
export type ProcessingReadinessReason = 'connecting' | 'mongodb' | 'shutting_down';
/** shutting_down wins; then mongodb while the store is not ready; then connecting unless isConsuming (decision 19). */
export function readinessReport({
  consumerState,
  shuttingDown,
}: {
  consumerState: ConsumerState;
  shuttingDown: boolean;
}): ReadinessReport<ProcessingReadinessReason>;
```

- [ ] Write failing tests: (1) a `STATES` table with every variant (`backoff`, `connecting`, `open`/`idle`, `open`/`active`, `draining`, `stopped`, each with `storeReady` true and false) → `shutting_down` when `shuttingDown`; (2) `storeReady` false → `mongodb` for every variant; (3) `storeReady` true → `ready` only for `open`/`active`, `connecting` for the rest.
- [ ] Verify tests fail
- [ ] Implement
- [ ] Verify tests pass
- [ ] Commit: `Add the processing readiness report`

### Task 9: The MongoDB store [integration]

**Files:** Create `apps/processing/src/store.ts`, `apps/processing/src/store.test.ts`
**Invariant:** 2 — the unique index is created before `start()` resolves, so nothing consumes before it exists (proven by Task 13 scenario 1's `listIndexes` and scenario 2's duplicate; the index options are the shared `EVENTS_IDENTITY_INDEX_SPEC`). 3 — `applyState` is one `findOneAndUpdate` with the pipeline, no read before it (`grep -c 'findOneAndUpdate' apps/processing/src/store.ts` is 1 and the file has no `findOne(`).
**Verify:** `pnpm --filter @telemetry/processing test && pnpm --filter @telemetry/processing typecheck && pnpm --filter @telemetry/processing lint`

```ts
export type StorePort = {
  insertEvent(doc: EventDocument): Promise<'inserted' | 'duplicate'>;
  applyState(
    deviceId: string,
    update: StateUpdate,
  ): Promise<{ result: 'updated'; before: DeviceStateDocument | null } | { result: 'duplicate' }>;
  insertAlert(doc: AlertDocument): Promise<'inserted' | 'duplicate'>;
};
/** The pause's ping loop (decision 10). */
export type StoreWatcher = { watch(signal: AbortSignal): Promise<'ready' | 'aborted'> };
export type MongoStoreOptions = {
  url: string;
  dbName: string;
  writeW: 'majority' | number;
  timeoutMs: number;
  logger: Logger;
};
export const STORE_BACKOFF_BASE_MS = 500;
export const STORE_BACKOFF_MAX_MS = 10_000;
/** IndexOptionsConflict, IndexKeySpecsConflict: a deployment bug no retry fixes (decision 10). */
export const INDEX_CONFLICT_CODES: ReadonlySet<number> = new Set([85, 86]);
/** Maps a driver error to the structural view; the only function that touches the driver's classes (decision 9). */
export function describeMongoError(error: unknown): StoreFailure;
export class MongoStore implements StorePort, StoreWatcher {
  constructor(options: MongoStoreOptions); // no I/O
  /** connect() then createIndex, retried with backoff until both succeed or the signal aborts; rejects only on an index conflict. */
  start(signal: AbortSignal): Promise<'ready' | 'aborted'>;
  watch(signal: AbortSignal): Promise<'ready' | 'aborted'>;
  insertEvent(doc: EventDocument): Promise<'inserted' | 'duplicate'>;
  applyState(
    deviceId: string,
    update: StateUpdate,
  ): Promise<{ result: 'updated'; before: DeviceStateDocument | null } | { result: 'duplicate' }>;
  insertAlert(doc: AlertDocument): Promise<'inserted' | 'duplicate'>;
  /** client.close() bounded by timeoutMs through settleWithin; never rejects. */
  close(): Promise<void>;
}
```

Fixed points:

- The client (decision 11): `new MongoClient(url, { connectTimeoutMS: timeoutMs, serverSelectionTimeoutMS: timeoutMs, socketTimeoutMS: timeoutMs, writeConcern: { w: writeW, journal: true, wtimeoutMS: timeoutMs }, appName: 'processing' })`; `db = client.db(dbName)`; `events: Collection<EventDocument>`, `state: Collection<DeviceStateDocument>`, `alerts: Collection<AlertDocument>` from the shared collection names.
- `describeMongoError`: `MongoServerError` (which covers `MongoWriteConcernError`) → `{ kind: 'server', code, codeName, labels: error.errorLabels, message }`; `MongoNetworkError` (which covers `MongoNetworkTimeoutError`) → `network`; `MongoServerSelectionError` → `server_selection`; `MongoClientClosedError | MongoNotConnectedError | MongoTopologyClosedError` → `closed`; any other `Error` → `{ kind: 'other', name: error.name, message }`; a non-error → `{ kind: 'other', name: 'non-error', message: String(error) }`. `instanceof` checks, in that order.
- Every port method: one driver call with `maxTimeMS: timeoutMs`, inside `try`; a caught error is described; a `server` view with `code === DUPLICATE_KEY_ERROR_CODE` becomes the `'duplicate'` result; anything else throws `new StoreError(failure)`. `applyState` is `state.findOneAndUpdate(update.filter, update.pipeline, { upsert: true, returnDocument: 'before', maxTimeMS: timeoutMs })` (a `Record<string, unknown>[]` is assignable to the driver's `Document[]`, whose element type is `{ [key: string]: any }`; the pipeline is deliberately not `readonly`, see Task 6); `insertEvent` is `events.insertOne(doc, { maxTimeMS })`; `insertAlert` is `alerts.insertOne(doc, { maxTimeMS })`. The translation of a caught 11000 into the `'duplicate'` result has no unit test against the driver (trade-off T44); `describeMongoError`'s 11000 case below is the unit-level tripwire. For `insertEvent` and `insertAlert` the translation is exercised deterministically by Task 13's scenario 2: the second delivery's event insert hits the unique index and its alert insert hits the `_id`. For `applyState` the 11000 is the racing first insert of a new device (consistency spec, decision 29, "expected never to fire"): no scripted scenario reproduces it reliably — scenario 6's concurrent fresh devices on two instances are the only plausible trigger, and that is timing-dependent — so the handler's one-shot retry is proven only against `TestStore` (Task 10, cases 16–17).
- `start(signal)`: loop `{ if aborted → 'aborted'; try { await client.connect(); await events.createIndex(EVENTS_IDENTITY_INDEX_SPEC.key, { name: EVENTS_IDENTITY_INDEX_NAME, unique: true, maxTimeMS }); log info 'store ready'; return 'ready' } catch → failure = describe; if server and code in INDEX_CONFLICT_CODES → throw new StoreError(failure) (the entry point logs it at fatal, once); else warn 'store not ready' { attempt, failure }; sleep backoffDelay({ attempt, baseMs: STORE_BACKOFF_BASE_MS, maxMs: STORE_BACKOFF_MAX_MS, random: Math.random }) through timers/promises setTimeout with { signal }, an AbortError → 'aborted'; attempt += 1 }`.
- `watch(signal)`: the same loop around `db.command({ ping: 1, maxTimeMS: timeoutMs })` (A7), `warn` `store not ready` per failure and `info` `store ready` once.
- `close()`: `settleWithin(client.close(), timeoutMs)`; `rejected` and `timed_out` are logged at `warn` (`store close`, with `outcome`), never thrown.

- [ ] Write failing tests in `store.test.ts`: (1) `describeMongoError` over constructed driver errors — `new MongoServerError({ code: 50, codeName: 'MaxTimeMSExpired', errmsg: 'x' })` → `{ kind: 'server', code: 50, codeName: 'MaxTimeMSExpired', labels: [], message: 'x' }`; `new MongoServerError({ code: 11600, errmsg: 'y', errorLabels: ['RetryableWriteError'] })` → labels `['RetryableWriteError']`; `new MongoServerError({ code: 11000, errmsg: 'E11000' })` → `server` with code 11000; `new MongoNetworkError('n')` and `new MongoNetworkTimeoutError('t')` → `network`; `new MongoClientClosedError()`, `new MongoNotConnectedError('c')`, `new MongoTopologyClosedError()` → `closed`; `new Error('e')` → `{ kind: 'other', name: 'Error', message: 'e' }`; the string `'boom'` → `{ kind: 'other', name: 'non-error', message: 'boom' }` (the tripwire for a driver change, decision 9); (2) against a closed port (a `net` server bound to 127.0.0.1:0 and closed): `insertEvent(exampleEvents.status)` rejects with a `StoreError` whose `failure.kind` is `server_selection` — the driver against nothing, not a mock — with `timeoutMs: 200`; (3) `start(signal)` against the closed port logs `store not ready` with `attempt: 0` and a `server_selection` failure, and resolves `'aborted'` promptly once the test aborts the signal after that line (a `vi.waitFor` on the captured lines, then `abort()`; assert the resolution takes under 100 ms); (4) `watch(signal)` with an already-aborted signal resolves `'aborted'` without a driver call (no log line); (5) `close()` resolves on a client that never connected and resolves again on a second call.
- [ ] Verify tests fail
- [ ] Implement
- [ ] Verify tests pass
- [ ] Commit: `Add the MongoDB store behind the processing store port`

### Task 10: The handler and the in-memory store [mechanical]

**Files:** Create `apps/processing/src/test-store.ts`, `apps/processing/src/handler.ts`, `apps/processing/src/handler.test.ts`
**Invariant:** 1 — the outcome is read from the pre-update document through `classifyOutcome` and a `stale` message changes nothing (case 5); 2 — a duplicate insert is normal control flow and the alert insert is keyed (cases 4, 16, 2); every write is idempotent, so a restart from step 2 after a transient failure is safe (case 9). The acknowledgement comes only after the three writes resolved (case 1's call order).
**Verify:** `pnpm --filter @telemetry/processing test && pnpm --filter @telemetry/processing typecheck && pnpm --filter @telemetry/processing lint`

```ts
// test-store.ts — the in-memory StorePort (decision 8); not named *.test.ts
export type StoreCall =
  | { method: 'insertEvent'; doc: EventDocument }
  | { method: 'applyState'; deviceId: string; update: StateUpdate }
  | { method: 'insertAlert'; doc: AlertDocument };
export type StoreAnswer =
  | { outcome: 'ok'; before?: DeviceStateDocument | null } // before: applyState only, default null
  | { outcome: 'duplicate' }
  | { outcome: 'fail'; failure: StoreFailure } // rejects with new StoreError(failure)
  | { outcome: 'throw'; error: Error }; // rejects with the error itself (a programmer error)
export class TestStore implements StorePort {
  /** Every call in order, with its arguments. */
  readonly calls: StoreCall[];
  /** Queues the answer for the next call of `method`; an unscripted call answers `{ outcome: 'ok' }`. */
  answer(method: StoreCall['method'], answer: StoreAnswer): void;
  /** Runs after every call is recorded (a test aborts the handler's signal from here). */
  onCall: ((call: StoreCall) => void) | undefined;
  insertEvent(doc: EventDocument): Promise<'inserted' | 'duplicate'>;
  applyState(
    deviceId: string,
    update: StateUpdate,
  ): Promise<{ result: 'updated'; before: DeviceStateDocument | null } | { result: 'duplicate' }>;
  insertAlert(doc: AlertDocument): Promise<'inserted' | 'duplicate'>;
}
```

The methods are not `async` (`require-await`): they return `Promise.resolve(...)` or `Promise.reject(...)`.

```ts
// handler.ts
export const HANDLER_BACKOFF_BASE_MS = 200;
export const HANDLER_BACKOFF_MAX_MS = 5_000;
export type HandlerResult =
  | {
      verdict: 'ack';
      outcome: StateOutcome;
      duplicate: boolean;
      alert: 'created' | 'exists' | 'none';
      gap: boolean;
      attempts: number;
    }
  | { verdict: 'reject'; reason: DeliveryRejectionReason | 'permanent'; attempts: number }
  | { verdict: 'abandon'; cause: 'aborted' | 'closed' | 'store_unavailable'; attempts: number };
export type HandlerInput = {
  content: Buffer;
  headers: Record<string, unknown> | undefined;
  redelivered: boolean;
  store: StorePort;
  clock: () => number;
  /** Resolves after ms, rejects when the signal aborts (timers/promises setTimeout in production). */
  sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  /** For backoffDelay; Math.random in production. */
  random: () => number;
  signal: AbortSignal;
  transientAttempts: number;
  logger: Logger;
};
/** Never rejects (decision 15). */
export function processDelivery(input: HandlerInput): Promise<HandlerResult>;
```

Rules, the spec's "One delivery, from queue to acknowledgement":

1. `decodeDelivery({ content, headers, redelivered, clock })`; a rejection → `rejectedMessageLogger(logger, identity).warn({ reason, detail, bytes }, 'message rejected')` → `{ verdict: 'reject', reason, attempts: 0 }`. From here on `log = messageLogger(logger, message)`. A `receivedAtSource` of `clock` → `log.warn({ receivedAt }, 'received-at header missing')`.
2. The attempt loop, `attempt` from 0: if `signal.aborted` → abandon `aborted`. `store.insertEvent({ deviceId, sessionId, seq, type, occurredAt, receivedAt, processedAt: clock(), payload })`; `'duplicate'` → `duplicate = true`.
3. If aborted → abandon. `store.applyState(deviceId, buildStateUpdate(message, receivedAt))`; a `'duplicate'` result → if aborted → abandon, else the same call once more within this attempt; a second `'duplicate'` → handled exactly like a transient `StoreError` (the transient branch below, with the view `{ kind: 'server', code: 11000, codeName: 'DuplicateKey', labels: [], message: 'state upsert collided twice' }` in the log line), **without** calling `classifyFailure`, which calls 11000 permanent — the collision is the racing first insert of a new device, and the retry path is correct for it (decision 16). `outcome = classifyOutcome(before, message)`; `gap = detectGap(before, message)`, logged at `info` as `sequence gap` with `previousSeq` and `seq`.
4. If aborted → abandon. For `type === 'diagnostic' && payload.severity === 'error'`: `store.insertAlert({ _id: messageIdentity(message), deviceId, sessionId, seq, code, message: payload.message, occurredAt, createdAt: clock() })` → `alert = 'created'`, `'duplicate'` → `'exists'`; otherwise `'none'`.
5. If aborted → abandon. `delivery processed` with `{ outcome, duplicate, redelivered, alert, attempts }` at `info` when `outcome === 'stale' || duplicate`, else `debug` (A13) → `{ verdict: 'ack', … }`.

Failure handling around steps 2–4, one `try` per attempt: a `StoreError` → `classifyFailure(error.failure)`: `permanent` → `log.error({ failure, step }, 'permanent store failure')` → `reject('permanent')`; `closed` → `log.warn({ failure, step }, 'store closed')` → abandon `closed`; `transient` → `log.warn({ failure, step, attempt: attempt + 1 }, 'transient store failure')`; if `attempt + 1 < transientAttempts` → `await sleep(backoffDelay({ attempt, baseMs: HANDLER_BACKOFF_BASE_MS, maxMs: HANDLER_BACKOFF_MAX_MS, random }), signal)` (a rejection of the sleep → abandon `aborted`) and the next attempt restarts at step 2; else → abandon `store_unavailable`. Any other throw is a programmer error: `log.error({ err }, 'handler failed')` → `reject('permanent')`. `attempts` in every result is the number of attempts started (0 for a rejection before step 2). The `step` field is `'insertEvent' | 'applyState' | 'insertAlert'`.

- [ ] Write failing tests in `handler.test.ts` with `exampleMessages`, `exampleEvents`, `exampleAlert`, a `TestStore` per test, `clock: () => EXAMPLE_PROCESSED_AT`, `random: () => 0.5`, a recording `sleep` that resolves at once (or rejects when its signal is already aborted, and records `ms`), an `AbortController`, `transientAttempts: 3`, and a capturing logger at `debug`; every case names the content as `Buffer.from(JSON.stringify(message))` with the header `EXAMPLE_RECEIVED_AT` unless stated: (1) the status message: `calls` equals `[insertEvent(exampleEvents.status), applyState('dev-0001', buildStateUpdate(message, EXAMPLE_RECEIVED_AT))]`, result `{ ack, created, duplicate false, alert none, gap false, attempts 1 }`, one `delivery processed` line at `debug` with the identity fields; (2) the diagnostic message: three calls, the third `insertAlert(exampleAlert)`, `alert: 'created'`; (3) diagnostics with severity `info` and `warning` → two calls, `alert: 'none'`; (4) `insertEvent` answered `duplicate` → `duplicate: true`, the outcome still computed from `before`, the line at `info`; (5) `applyState` answered with a `before` whose section is newer → `outcome: 'stale'`, the line at `info`; (6) `before.lastEvent` of the same session with `seq` 2 for a message with `seq` 5 → `gap: true` and a `sequence gap` line `{ previousSeq: 2, seq: 5 }`; (7) no header → `receivedAt` is the clock in both documents and a `received-at header missing` line at `warn` with the identity; (8) a permanent failure (`server` code 121) at each of the three steps (an `it.each`) → `reject('permanent')`, an `error` line `permanent store failure` with `step` and the identity, no further call; (9) a transient failure (`network`) at `insertEvent` then success → ack with `attempts: 2`, one `transient store failure` at `warn` with `attempt: 1`, `sleep` called once with 100 ms (0.5 × 200), and `calls` is `[insertEvent, insertEvent, applyState]` (the restart from step 2); (10) three transient failures → `abandon('store_unavailable')`, `attempts: 3`, two sleeps of 100 and 200 ms; (11) the controller aborted while the handler is inside `sleep` (the recording sleep rejects) → `abandon('aborted')`, no store call after the failed one; (12) a signal aborted before the call → `abandon('aborted')` with `attempts: 1` and no store call; (13) `onCall` aborts the signal after `insertEvent` → `abandon('aborted')`, `calls` has one entry; (14) a `closed` failure → `abandon('closed')` and a `store closed` line at `warn`; (15) each rejection reason (oversized, invalid UTF-8, invalid JSON, invalid schema) → `reject(reason)`, a `message rejected` line at `warn` with `reason`, `bytes` and the raw identity fields present, no store call; (16) `applyState` answered `duplicate` once, then ok → `calls` is `[insertEvent, applyState, applyState]`, ack with `attempts: 1`; (17) `applyState` answered `duplicate` twice, then the whole attempt succeeds → `attempts: 2`, one transient line, one sleep; (18) `insertEvent` answered `{ outcome: 'throw', error: new TypeError('bug') }` → `reject('permanent')` and a `handler failed` line at `error`.
- [ ] Verify tests fail
- [ ] Implement `test-store.ts` and `handler.ts`
- [ ] Verify tests pass
- [ ] Commit: `Process one delivery through the store port`

### Task 11: The amqplib consumer shell [integration]

**Files:** Create `apps/processing/src/consumer.ts`, `apps/processing/src/consumer.test.ts`
**Invariant:** 4 — the consume callback dispatches each delivery with `void` and never awaits a handler, so `PROCESSING_PREFETCH` handlers run concurrently and the broker bounds them (`grep -n 'void this.#run(' apps/processing/src/consumer.ts` finds the one dispatch); 5 — individual acks, no `allUpTo`, no batching; 6 — one connection and one channel per instance, the held map per registration, nothing per device. The pause and the cancel sequences are Task 7's tested rows; the shell is proven by Task 13 (scenarios 8–11), no mock of amqplib (`CLAUDE.md`).
**Verify:** `pnpm --filter @telemetry/processing test && pnpm --filter @telemetry/processing typecheck && pnpm --filter @telemetry/processing lint`

```ts
export type ConsumerStats = {
  received: number;
  acked: number;
  created: number;
  applied: number;
  stale: number;
  duplicate: number;
  alerts: number;
  gaps: number;
  rejected: number;
  failed: number;
  retries: number;
  returned: number;
  abandoned: number;
  inFlight: number;
  paused: boolean;
  generation: number;
  registered: boolean;
};
export type AmqpConsumerOptions = {
  url: string;
  heartbeatSeconds: number;
  prefetch: number;
  transientAttempts: number;
  shutdownTimeoutMs: number;
  store: StorePort & StoreWatcher;
  logger: Logger;
  /** For `connection_name`; defaults to os.hostname(). */
  hostname?: string;
};
export const AMQP_CONNECT_TIMEOUT_MS = 10_000;
export const AMQP_SETUP_TIMEOUT_MS = 10_000;
export const AMQP_CLOSE_TIMEOUT_MS = 2_000;
export const LINK_BACKOFF_BASE_MS = 500;
export const LINK_BACKOFF_MAX_MS = LINK_RESET_AFTER_MS; // 10 000, taken from the reset constant on purpose
export class AmqpConsumer {
  constructor(options: AmqpConsumerOptions); // no I/O
  /** Dispatches backoff_elapsed on the start state; never throws. Called once. */
  start(): void;
  /** Feeds store_ready; the entry point calls it once store.start() resolved 'ready'. */
  storeReady(): void;
  get state(): ConsumerState;
  stats(): ConsumerStats;
  /** stop → drain up to shutdownTimeoutMs → drained → close; resolves within shutdownTimeoutMs + AMQP_CLOSE_TIMEOUT_MS. */
  stop(): Promise<void>;
}
```

Fixed points the implementer must not vary (the spec's "Shell" bullets, A9–A12):

- `#dispatch(event)`: runs `transition` synchronously, stores the state, then appends the effects to one serial promise chain (`#effects = #effects.then(() => this.#runEffects(effects, generation))`), where every runner catches and logs its own errors (`debug` for an amqplib method on a closed channel, `warn` otherwise) and never rejects the chain. Effects of one transition run in order; `consume`, `cancel_consumer`, `return_held` and `close_link` are awaited, `open_link`, `schedule_backoff`, `abort_handlers` and `watch_store` are not.
- The link: one `Link = { handle: ModelHandle; channel: Channel }` set by the attempt before it dispatches `link_opened`. `ModelHandle` is ingest's (`generation`, `model`, `closed`, `closeError`, `closing`, `abandoned`) plus `failed: boolean` (A11).
- The attempt (`open_link`, on `queueMicrotask`): `connect(href, { timeout: AMQP_CONNECT_TIMEOUT_MS, clientProperties: { connection_name: `processing@${hostname}` } })` with `heartbeat` in the URL's query as ingest does; `#watchModel`; then under `settleWithin(…, AMQP_SETUP_TIMEOUT_MS)`: `createChannel()`, `#watchChannel`, the six declarations in ingest's order with the shared constants, `prefetch(prefetch, false)`; `#mayContinue(handle)` (`!abandoned && !failed && state is connecting on this generation`) checked before every step and once more at the end. A `connect` rejection, a setup rejection, a timeout (`abandoned = true`) and a lost `#mayContinue` end the attempt: close what it opened with nobody waiting, and dispatch `link_failed { reason }` unless the state is `stopped` (reasons `connect_failed`, `setup_failed`, `setup_timed_out`, `superseded`, or the close's reason when `failed`). Success: `#link = { handle, channel }`, dispatch `link_opened { generation, now: Date.now() }`, log `info` `consumer connected` `{ generation, attempt }`.
- Listeners (the generation captured in a closure): model `close` → `handle.closed = true`, `handle.closeError = error`; while the attempt is in flight `handle.failed = true` (the attempt reports it), otherwise dispatch `link_closed { generation, reason: 'connection_closed', now }`; channel `close` → the same with `channel_closed`; model `error` and channel `error` → `logger.error({ err, generation }, 'amqp connection error' | 'amqp channel error')`; channel `handler-error` → `logger.error({ err, eventName, generation }, 'amqp handler error')`; model `blocked` → `warn` `connection blocked` `{ reason }`, `unblocked` → `info` `connection unblocked`. A `link_closed` drops `#link` and the registration (`live = false`).
- Registrations (A10): `Registration = { controller: AbortController; held: Map<number, ConsumeMessage>; dispatched: Set<Promise<void>>; consumerTag: string | undefined; live: boolean }`. `consume`: creates a registration, `await channel.consume(TELEMETRY_QUEUE, onMessage, { noAck: false })` → `consumerTag`, dispatch `consumer_registered`, log `info` `consumer registered` `{ generation, consumerTag }`; a rejection is logged at `debug` (the channel's `close` is the real event). The effect is a no-op while a registration of this link is live (the guard against a double consume). `onMessage(null)` → `registration.live = false`, log `info` `consumer cancelled` `{ generation }`, dispatch `broker_cancelled`. `onMessage(msg)` → `held.set(msg.fields.deliveryTag, msg)`, `received += 1`, `inFlight += 1`, `dispatched.add(promise)` where `promise = this.#run(registration, msg)` and the call site is `void`.
- `#run(registration, msg)`: `processDelivery({ content: msg.content, headers: msg.properties.headers, redelivered: msg.fields.redelivered, store, clock: Date.now, sleep, random: Math.random, signal: registration.controller.signal, transientAttempts, logger })` with `sleep = (ms, signal) => setTimeout(ms, undefined, { signal })` from `node:timers/promises`; then, only if `registration.live` and `#link` is set: `ack` → `channel.ack(msg)` (never `allUpTo`), `reject` → `channel.reject(msg, false)`; both delete the tag from `held`; an `ack`/`reject` throw is logged at `warn` with the identity (`acknowledge failed`). Counters: `acked`, `created | applied | stale`, `duplicate`, `alerts` (`alert === 'created'`), `gaps`, `rejected` (a body reason), `failed` (`permanent`), `retries += attempts - 1`, `abandoned`; an `abandon('store_unavailable')` also dispatches `store_unavailable`. Finally `inFlight -= 1`, `dispatched.delete(promise)`. The whole body is inside `try`/`finally`; `processDelivery` never rejects, so no `catch` hides a programmer error.
- `cancel_consumer`: `await settleWithin(channel.cancel(consumerTag), AMQP_SETUP_TIMEOUT_MS)` when a tag exists; the outcome logged at `debug`. `abort_handlers`: `registration.controller.abort()`. `return_held`: `await Promise.allSettled([...registration.dispatched])`, then for every entry still in `held` `channel.nack(msg, false, true)` inside `try` (a throw ends the loop, logged at `debug`), `returned += n`, `held.clear()`, `registration.live = false`, `paused = true`, log `warn` `consumer paused` `{ generation, returned: n }`. `watch_store`: at most one at a time — `void store.watch(#stopController.signal).then((outcome) => { if (outcome === 'ready') { paused = false; dispatch store_ready } })`. `close_link`: `await` the model's close (ingest's `#closeHandle`: on the next turn, skipped when `handle.closed`, `settleWithin(model.close(), AMQP_CLOSE_TIMEOUT_MS)`, the outcome logged), then `#link = undefined`. `schedule_backoff`: `backoffDelay({ attempt, baseMs: LINK_BACKOFF_BASE_MS, maxMs: LINK_BACKOFF_MAX_MS, random: Math.random })`, log `warn` `consumer reconnect scheduled` `{ reason, attempt, delayMs, err? }` (the close error of the link that ended, as ingest), `setTimeout` dispatching `backoff_elapsed` with the generation.
- `stop()`: `clearTimeout(#backoffTimer)`; `#stopController.abort()` (ends a store watch); dispatch `stop`; log `info` `consumer stopping` `{ from }`; if the state is now `draining`: `const outcome = await settleWithin(Promise.allSettled([...dispatched]), shutdownTimeoutMs)`; `timed_out` → `warn` `shutdown drain ended at its budget` `{ inFlight }`; dispatch `drained { generation }`. Then `await #effects` (the close has run) and resolve.
- `stats()` reads the counters and `{ inFlight, paused, generation: state.generation, registered: isConsuming(state) }`.

- [ ] Write failing tests in `consumer.test.ts` (ingest's `publisher.test.ts` pattern: a refused port and a silent TCP server, never a mock; `store` is a `TestStore` extended with `watch: () => new Promise(() => undefined)`): (1) `stop()` from `backoff` — `Math.random` at 0.5, a refused port, wait for one `consumer reconnect scheduled` line with `reason: 'connect_failed'` and `attempt: 1`, `state.name` `backoff`; `stop()` resolves under 100 ms, `state.name` `stopped`; after a 700 ms wait (the assertion is that the retry never runs) the lines are exactly `consumer reconnect scheduled`, `consumer stopping`; (2) `stop()` during a connect attempt — a `net` server that accepts and never answers; wait until it accepted; `state.name` `connecting`; `stop()` resolves under 100 ms with `stopped`; the accepted socket receives `close` within 100 ms after the test destroys nothing (the abandoned attempt closes what it opened); (3) `storeReady()` before any link — `state.storeReady` becomes true and `stats().registered` stays false; (4) `stats()` before `start()` is all zeros with `paused: false`, `generation: 0`, `registered: false`.
- [ ] Verify tests fail
- [ ] Implement `consumer.ts`
- [ ] Verify tests pass; lint passes against amqplib's `any`-typed `headers` (read as `unknown`, A8)
- [ ] Commit: `Add the amqplib consumer shell`

### Task 12: The entry point [integration]

**Files:** Modify `apps/processing/src/main.ts`; create `apps/processing/src/test-source-hooks.ts` (a copy of `apps/ingest/src/test-source-hooks.ts` with the comment naming processing), `apps/processing/src/main.test.ts`
**Invariant:** 2 — the consumer registers only after `store.start()` resolved (`consumer.storeReady()` is called from its `then`), so the unique index exists before the first insert.
**Verify:** `pnpm --filter @telemetry/processing test && pnpm --filter @telemetry/processing typecheck && pnpm --filter @telemetry/processing lint && pnpm --filter @telemetry/processing build`

`main.ts` keeps `export const SERVICE_NAME = 'processing'`, adds `export const SUMMARY_INTERVAL_MS = 10_000` and `export async function main(): Promise<void>` in the spec's startup order (decision 21): `loadProcessingConfig()` (not wrapped); `createLogger({ service: SERVICE_NAME, level: config.LOG_LEVEL })`; `logger.info({ ...config }, 'processing starting')` (the logger redacts both URLs); `const store = new MongoStore({ url: config.MONGODB_URL, dbName: config.MONGODB_DB, writeW: config.MONGODB_WRITE_W, timeoutMs: config.MONGODB_TIMEOUT_MS, logger })`; `const consumer = new AmqpConsumer({ url: config.RABBITMQ_URL, heartbeatSeconds: config.AMQP_HEARTBEAT_S, prefetch: config.PROCESSING_PREFETCH, transientAttempts: config.PROCESSING_TRANSIENT_ATTEMPTS, shutdownTimeoutMs: config.SHUTDOWN_TIMEOUT_MS, store, logger })`; `const startup = new AbortController()`; the lifecycle handlers with `shutdown: async () => { shuttingDown = true; startup.abort(); await consumer.stop(); await store.close(); await health?.close(); }` (decision 20); the four `process.on` registrations; `startHealthServer({ port: config.HEALTH_PORT, report: () => readinessReport({ consumerState: consumer.state, shuttingDown }), logger })` first, a failure logged at `fatal` (`health server failed to listen`, `port`) and `process.exit(FAILURE_EXIT_CODE)`; then `consumer.start()` and `void store.start(startup.signal).then((outcome) => { if (outcome === 'ready') consumer.storeReady(); }, (error: unknown) => { logger.fatal({ err: error }, 'index conflict'); process.exit(FAILURE_EXIT_CODE); })` — both started in the same tick, no step waits for a dependency; the unref'd summary interval logging `consumer.stats()` at `info` as `summary`. The direct-run guard from ingest's `main.ts` is kept.

- [ ] Write failing tests in `main.test.ts` (ingest's harness: `startProcessing(env)` spawns `process.execPath --experimental-transform-types --import test-source-hooks.ts main.ts`, JSON lines, `waitForLog`, `closed`, `freePorts`, `afterEach` SIGKILL): (1) with `RABBITMQ_URL=amqp://probe:PLACEHOLDER_SECRET@127.0.0.1:<closed>`, `MONGODB_URL=mongodb://probe:PLACEHOLDER_SECRET@127.0.0.1:<closed>`, `MONGODB_TIMEOUT_MS=300`, `HEALTH_PORT=<free>`, `SHUTDOWN_TIMEOUT_MS=500`, `LOG_LEVEL=info`: wait for `store not ready` and `consumer reconnect scheduled`; `GET /readyz` → 503 `{ status: 'not_ready', reason: 'mongodb' }`; `SIGTERM`; await `closed`; with `expect.soft`: `lines[0]` is `processing starting` with `RABBITMQ_URL: '[redacted]'` and `MONGODB_URL: '[redacted]'`; the joined output does not contain `PLACEHOLDER_SECRET`; the `store not ready` line has `attempt: 0` and `failure.kind` `server_selection`; the `consumer reconnect scheduled` line has `reason: 'connect_failed'`, `attempt: 1` and a numeric `delayMs`; the messages after `shutting down` that are in `['shutting down', 'consumer stopping', 'stopped']` equal that list in order; no `store not ready` line follows `shutting down`; the exit is `{ code: 0, signal: null }` and the lifetime after the signal is under 2 000 ms (15 s test timeout); (2) `HEALTH_PORT` already bound → exactly one level-60 line `health server failed to listen` with `port` and exit `{ code: 1, signal: null }`.
- [ ] Verify tests fail
- [ ] Implement `main.ts` and the hooks
- [ ] Manually verify without infrastructure: `pnpm --filter @telemetry/processing build && RABBITMQ_URL=amqp://127.0.0.1:1 MONGODB_URL=mongodb://127.0.0.1:1 MONGODB_TIMEOUT_MS=1000 node apps/processing/dist/main.js` logs the config line with both URLs redacted, `store not ready` and `consumer reconnect scheduled` lines with growing delays, `curl -s localhost:8080/readyz` answers 503 `mongodb`, and `Ctrl+C` exits 0 within the budget.
- [ ] Verify tests pass
- [ ] Commit: `Wire the processing entry point and its readiness signal`

### Task 13: Scripted run against RabbitMQ 4.3 and MongoDB 8.0 [integration]

**Files:** Create `.local/research/2026-09-13-processing-scripted-run.mjs` (gitignored); modify `docs/plans/2026-09-13-processing-plan.md` (this plan's header with the evidence)
**Invariant:** 1, 2 and 3 end-to-end — every scenario ends with `events` holding exactly the distinct identities sent, every section holding its device's highest key, and one alert per distinct error diagnostic; the run counts these through the driver after every scenario.
**Verify:** `docker info` (OrbStack up), `docker pull mongo:8.0`, `pnpm --filter @telemetry/processing build`, then `node .local/research/2026-09-13-processing-scripted-run.mjs > .local/research/2026-09-13-processing-scripted-run-output.txt; echo SCRIPTED_EXIT=$?` exits 0

The script follows `.local/research/2026-09-13-ingest-scripted-run.mjs` (driven from Node, never a shell wrapper): it removes leftover containers by name, starts `rabbitmq:4.3-management` as `processing-probe-rabbit` (`RABBITMQ_DEFAULT_USER`/`RABBITMQ_DEFAULT_PASS`, ports 127.0.0.1:5672 and 15672) and `mongo:8.0` as `processing-probe-mongo` (`MONGO_INITDB_ROOT_USERNAME`/`MONGO_INITDB_ROOT_PASSWORD`, port 127.0.0.1:27017), both with random passwords from `randomBytes(18)` that `out()` redacts from every line; waits for the management API's `/overview` and for a driver `ping` (`authSource=admin`); prints `rabbitmq_version`, `erlang_version` and the MongoDB `buildInfo.version`. `amqplib` and `mongodb` are loaded through `createRequire(new URL('../../apps/processing/package.json', import.meta.url))`. A publisher helper opens a confirm channel, asserts the topology with the shared constants (so the run does not depend on ingest) and publishes bodies to `TELEMETRY_EXCHANGE` with routing key `event`, `persistent`, `contentType: 'application/json'`, `messageId`, `timestamp` and `x-received-at: Date.now()`, waiting for the confirm. `startProcessing(name, env)` spawns `apps/processing/dist/main.js` with `RABBITMQ_URL`, `MONGODB_URL`, `MONGODB_TIMEOUT_MS=1000`, `AMQP_HEARTBEAT_S=2`, `PROCESSING_TRANSIENT_ATTEMPTS=3`, `SHUTDOWN_TIMEOUT_MS=3000`, `LOG_LEVEL=debug`, a `HEALTH_PORT` per instance (8081, 8082), and collects JSON lines and stderr. Every scenario polls with `waitFor(predicate, timeoutMs)`, reads MongoDB through the driver (`countDocuments`, `distinct('seq')` per device, `findOne` on `device_state`, `listIndexes`), reads the queues through the management API (`GET /api/queues/%2F/<queue>` for `messages`, `POST .../get` with `ackmode: 'ack_requeue_false'` to drain `telemetry.dead`), and calls `report(name, ok, detail)`; the `finally` block kills the children (SIGTERM raced against 15 s), stops both containers, prints the per-message log counts and every `warn`/`error` line except `message rejected`, then `ALL PASS (12 scenarios)` or the failure count, exit 0 or 1. Every device id carries the scenario number (`s01-dev-0001`) so the counts are per scenario.

1. **Normal flow** — instance A; two devices × the four types (the diagnostic with severity `error`): `events` 8, two `device_state` documents with the four sections and `lastEvent` equal to the diagnostic's key, `alerts` 2, eight `delivery processed` lines (`LOG_LEVEL=debug` logs every acknowledged delivery), `telemetry.events` `messages` 0, and `listIndexes` on `events` shows `identity_unique` with `unique: true`.
2. **Duplicate** — one error diagnostic (a new `seq`) published twice: `events` + 1, `alerts` + 1, the second `delivery processed` line at `info` with `duplicate: true` and `outcome: 'stale'`.
3. **Out of order within a section** — `metrics` `seq` 6 then 5: `events` + 2, the stored `metrics.seq` is 6, the second line has `outcome: 'stale'`.
4. **Out of order across sections** — `metrics` 8 then `status` 7: both `applied`; `status.seq` 7, `metrics.seq` 8, `lastEvent.seq` 8.
5. **Session restart and straggler** — a new `sessionId` with `status` `seq` 1 and `counters` `seq` 2 (`operationsTotal` 0): every section written carries the new `sessionId`, `counters.operationsTotal` is 0; then an old-session `metrics` `seq` 9 → `stale`, the document unchanged.
6. **Two instances** — instance B started; 20 devices × 50 messages generated from a seeded PRNG with 5 % exact duplicates and 5 % adjacent swaps, all four types, some error diagnostics: `events` count equals the number of distinct identities (1 000), every section of every device holds that device's highest key of its type, `alerts` equals the distinct error diagnostics, and both instances logged `delivery processed` lines (the counts recorded). B is stopped (SIGTERM, exit 0).
7. **Poison** — four bodies: `not json`, `{"type":"bogus"}`, the diagnostic message with a `0xff` byte inside `payload.message`, a 70 KiB body: `telemetry.dead` holds 4 messages, a peeked one has `x-death[0].reason` `rejected` and `queue` `telemetry.events`; the four `message rejected` lines carry `invalid_json`, `invalid_schema`, `invalid_utf8`, `body_too_large`; `events` unchanged; the dead queue is drained afterwards.
8. **MongoDB stopped, then back** — `docker stop processing-probe-mongo`; 30 messages published: `transient store failure` lines at `warn`, then `consumer paused` with `returned` ≥ 1 (recorded), `/readyz` 503 `mongodb`, `telemetry.events` `messages` ≥ the returned count; `docker start`; `store ready` then `consumer registered`; every one of the 30 identities in `events` exactly once and `alerts` correct; `/readyz` 200.
9. **MongoDB frozen** — `docker pause`; 10 messages: `transient store failure` lines whose `failure.kind` is `network` (a socket timeout) or `server` with code 50 — record which; the first such line arrives within `MONGODB_TIMEOUT_MS` + 1 000 ms of the first delivery (record the measured gap); `consumer paused`, 503 `mongodb`; `docker unpause`; resume; the 10 stored once.
10. **Broker restart** — 100 messages published at 20 per second while `docker restart processing-probe-rabbit` runs (the publisher helper reconnects and republishes its unconfirmed ones): `consumer reconnect scheduled` with reason `connection_closed` or `channel_closed` (record which), `/readyz` 503 `connecting` during the restart, `consumer registered` again afterwards; all 100 identities in `events` exactly once; the count of `delivery processed` lines with `duplicate: true` is recorded (redeliveries).
11. **SIGTERM with deliveries in flight** — 300 messages published in one burst, then SIGTERM to A at once: exit 0 within `SHUTDOWN_TIMEOUT_MS + AMQP_CLOSE_TIMEOUT_MS + 1 000` ms; the lines `shutting down`, `consumer stopping`, `stopped` in order; A's `delivery processed` line count plus `telemetry.events` `messages` after the exit is 300 (record both, and the `inFlight` of the drain-budget line if it appears); a fresh instance A finishes the rest; `events` holds 300 distinct identities and `alerts` one per distinct error diagnostic.
12. **Wrong credentials** — an instance started with a wrong MongoDB password: `store not ready` lines with `attempt` 0, 1, 2 and `failure.kind` `server` with code 18 (`AuthenticationFailed`), `/readyz` 503 `mongodb`, the process alive after 5 s; SIGTERM → exit 0; the same instance restarted with the right password → `store ready`, `/readyz` 200.

- [ ] Write and run the script; fix whatever it finds in `consumer.ts`, `store.ts` or `handler.ts` (each fix is its own commit with the scenario in the subject)
- [ ] Record the evidence in this plan's header: the date, the RabbitMQ and MongoDB versions, one line per scenario with the numbers, the two recorded outcomes of scenarios 9 and 10, and the output file name
- [ ] Commit: `Record the processing consumer's scripted run against RabbitMQ and MongoDB`

### Task 14: Ledger and trade-offs [mechanical]

**Files:** Modify `TODO.md`, `docs/specs/2026-09-11-telemetry-consistency-design.md`
**Invariant:** none touched.
**Verify:** `pnpm format:check && pnpm lint && pnpm typecheck && pnpm test`

- [ ] Tick all nine boxes under `## 5. Processing service` and add a one-line note above them naming this plan, the commit range and the test counts, in the style steps 2–4 use (`Hotovo 2026-09-13 podle docs/specs/2026-09-13-processing-design.md a docs/plans/2026-09-13-processing-plan.md (N commitů …, M testů processing, celkem K). Skriptovaný běh proti RabbitMQ 4.3 a MongoDB 8.0 prošel všemi dvanácti scénáři; výsledky jsou v hlavičce plánu.`).
- [ ] Append rows T44–T49 from the design spec's "Trade-offs added to the running list" after the T42–T43 block of the consistency spec, introduced by `Rows T44–T49 come from the processing design spec (`docs/specs/2026-09-13-processing-design.md`), added when TODO step 5 landed on 2026-09-13.`, preserving the column order and pointing the Decision column at `processing spec, N`.
- [ ] Full pre-flight green.
- [ ] Commit: `Mark the processing step done and record its trade-offs`

## Verification Criteria

| #   | Criterion (TODO step 5 item, or invariant)                                                                                 | How to verify                                                                                                                                                                                                 |
| --- | -------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Consumption from RabbitMQ that keeps the per-device result correct and spreads the load across instances                   | `consumer-state.test.ts` cases 1–5; `state-update.test.ts` cases 1–2; scripted scenarios 3, 4 and 6 (two instances, every section at its highest key)                                                         |
| 2   | Deduplication: a repeated message has no business effect                                                                   | `handler.test.ts` cases 4, 5, 16; `state-update.test.ts` case 4 (same key → `stale`); scripted scenario 2 (one event, one alert)                                                                              |
| 3   | Every processed event is stored in MongoDB                                                                                 | `handler.test.ts` case 1 (`insertEvent` first, with the document of the fixtures); scripted scenario 1                                                                                                        |
| 4   | The device state is updated atomically and only when the message is newer                                                  | `state-update.test.ts` cases 1–3 (the guard equals `isNewer`, `$literal`); `store.ts` has one `findOneAndUpdate` and no `findOne(`; scripted scenarios 3, 5                                                   |
| 5   | Counters and alerts are idempotent                                                                                         | `handler.test.ts` cases 2, 4 (`exists`); scripted scenarios 2 and 5 (`operationsTotal` 0 after a restart); cumulative counters are the contract's                                                             |
| 6   | Errors: retry, dead-letter for unprocessable messages, acknowledgement only after a successful store                       | `handler.test.ts` cases 8–15, 18; `failure.test.ts`; scripted scenarios 7 (dead-lettered with `x-death`), 8, 9 (pause and resume, nothing lost)                                                               |
| 7   | Indexes and unique constraints exist (dedup, state lookup)                                                                 | `store.ts` creates `EVENTS_IDENTITY_INDEX_SPEC` before `start()` resolves and `main.ts` registers the consumer only then; scripted scenario 1 (`listIndexes`), scenario 2 (the duplicate is rejected)         |
| 8   | Graceful shutdown and the readiness signal                                                                                 | `main.test.ts` cases 1–2; `health.test.ts` (processing and shared); `consumer.test.ts` cases 1–2; scripted scenarios 8, 10, 11, 12 (`/readyz` reasons, exit 0 with deliveries in flight)                      |
| 9   | Unit tests of the decision logic: freshness, dedup, atomicity of the update                                                | `state-update.test.ts`, `failure.test.ts`, `consumer-state.test.ts`, `handler.test.ts`, `delivery.test.ts`                                                                                                    |
| 10  | Invariant 1: older telemetry never overwrites newer known state                                                            | `state-update.test.ts` cases 1(d)(e), 4; scripted scenarios 3 and 5                                                                                                                                           |
| 11  | Invariant 2: a redelivered or duplicated message causes no second effect                                                   | `handler.test.ts` cases 4, 16; scripted scenarios 2, 10 (redeliveries after a broker restart), 11 (requeued remainder)                                                                                        |
| 12  | Invariant 3: one conditional single-document write, no unguarded read-modify-write                                         | `store.ts` (`grep -c findOneAndUpdate` = 1, no `findOne(`, no transaction); `state-update.test.ts` case 3 (one stage, the `$cond`s)                                                                           |
| 13  | Invariant 4: parallel across devices, serial within one                                                                    | `consumer.ts` dispatches with `void this.#run(` (grep finds it) and `prefetch(prefetch, false)`; scripted scenario 6                                                                                          |
| 14  | Invariant 5: minimal throughput cost — no routing, no batching, individual acks, the pause only during an outage           | `grep -n 'ack(' apps/processing/src/consumer.ts` shows no `true` second argument; no `bulkWrite`; scripted scenario 8's `returned` count equals the held deliveries, nothing more                             |
| 15  | Invariant 6: processing shares nothing but the queue and the database; the held map dies with its registration             | `consumer.ts` `Registration` type; `grep -rn "deviceId" apps/processing/src/consumer.ts` shows it only in log fields                                                                                          |
| 16  | An invalid configuration fails at startup naming the variable, never its value; both URLs are redacted in the startup line | `config.test.ts` cases 2–5; `main.test.ts` case 1 (`[redacted]`, no `PLACEHOLDER_SECRET`)                                                                                                                     |
| 17  | No `console.*`; every line about a message carries `deviceId`, `sessionId`, `seq`                                          | `pnpm --filter @telemetry/processing lint`; `grep -rn 'console\.' apps/processing/src` returns nothing; `handler.test.ts` cases 1, 8, 15 assert the identity fields on the lines                              |
| 18  | The health server move changes no behaviour                                                                                | Task 2: the total test count is unchanged and ingest's `readinessReport` cases stay green                                                                                                                     |
| 19  | Every socket, AMQP and MongoDB operation has a timeout; reconnect with backoff; the stop is bounded                        | `store.ts` client options and `maxTimeMS` on every call (grep `maxTimeMS` ≥ 4); `consumer.ts` `settleWithin` on setup, cancel, close and the drain; scripted scenarios 9 (frozen database) and 11 (exit time) |

## Test Plan

- Per task: the scoped verify command of the task (`@telemetry/shared`, `@telemetry/ingest` or `@telemetry/processing`).
- **No Docker is needed for Tasks 1–12.** The store test drives the real driver against a closed port; the consumer test drives amqplib against a refused port and a silent TCP server; the handler runs against `TestStore`; the entry point runs as a child process against closed ports. These files live in `src/` and run in the `unit` project; `apps/processing/test/integration/` stays empty until step 7.
- **Task 13 needs OrbStack** (`docker info`), pulls `mongo:8.0`, and is a scripted run, not a vitest test — the automated version is the step 7 item added in Task 1.
- Every test waits on an event or a log line (`vi.waitFor`, `waitForLog`, `closed`), never on a sleep; the one timed wait is `consumer.test.ts` case 1, where the absence of a retry is the assertion (the ingest precedent).
- Full pre-flight before reporting done: `pnpm format:check && pnpm lint && pnpm typecheck && pnpm test`.
- Expected count after Task 14: about 130 new cases on top of the 574 at `95f4d98`.

## Checkpoint Recovery

If interrupted mid-implementation, resume by:

1. Read this plan.
2. `git log --oneline` — each task ends with exactly one commit whose subject is quoted in the task (Task 13 may add fix commits before its own).
3. Pick up from the first task whose commit is missing. Tasks run in numeric order: Task 2's `startHealthServer` is imported by Task 12; Task 3's `ProcessingConfig` by Task 12; Task 4's `decodeDelivery` and fixtures by Tasks 6 and 10; Task 5's `StoreError` and `classifyFailure` by Tasks 9 and 10; Task 6's `StateUpdate` by Tasks 9 and 10; Task 7's `transition` by Tasks 8 and 11; Task 8's `readinessReport` by Task 12; Task 9's `StorePort` and `StoreWatcher` by Tasks 10 and 11; Task 10's `processDelivery` by Task 11; Task 11's `AmqpConsumer` by Task 12. Task 13 needs Task 12's built entry point.
