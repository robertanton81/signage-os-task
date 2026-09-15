# Strengthen Existing Hexagonal Boundaries Implementation Plan

**Status:** Proposed; implementation awaits approval.
**Goal:** Let the processing handler request a state update without constructing MongoDB expressions, and let application consumers import ports without importing adapter modules.
**Approach:** Extract the existing ports into two application-local modules. Move MongoDB pipeline construction into the storage adapter boundary. Keep the flat module layout, existing composition in `main.ts`, and current delivery behavior.
**Design specs:** [Processing](../specs/2026-09-13-processing-design.md), [ingest](../specs/2026-09-13-ingest-design.md), and [consistency](../specs/2026-09-11-telemetry-consistency-design.md). This plan proposes a narrow amendment to the processing port signature and module ownership. All consistency decisions remain binding.
**TODO items:** Optional follow-up to completed sections 4 (ingest) and 5 (processing). This does not complete section 8 documentation or section 9 submission checks. Leave the existing uncommitted `TODO.md` changes untouched.
**Branch:** Create `codex/hexagonal-boundaries` from the current checkout when implementation is approved. Preserve unrelated work and stage only task-owned files.
**Scope:** Ingest and processing, their existing test consumers, and the two service design specs. No changes to shared contracts, dependencies, deployment, wire formats, collection schemas, or queue topology.

## Decisions and limits

- Application-owned ports live in `store-port.ts` and `publish-port.ts`. Adapters implement those interfaces; application consumers import the interfaces directly.
- Keep `StorePort` and `PublishPort` names. Do not add a generic repository, dependency-injection container, new package, or nested architecture layers.
- Change `applyState` to accept `TelemetryMessage` and `receivedAt`. Keep its result union and error behavior unchanged. Two positional arguments of different types follow repository conventions.
- Keep `StoreWatcher` as a separate interface beside `StorePort`; the consumer still requires their intersection.
- Keep publisher readiness, confirmation callbacks, pending count, and stop operations unchanged. Splitting that interface further is outside this plan.
- Keep `StateOutcome`, `SequenceGap`, `classifyOutcome`, and `detectGap` in `state-update.ts`. Put only MongoDB query construction in `mongo-state-update.ts`.
- Keep driver error translation, structural `StoreFailure` values, collision retries, and shared document types as they are. This is a partial separation from infrastructure, not a claim that every application type is storage-independent.
- Do not move delivery decoding or change its input shape. Do not change state machines, scheduling, shutdown, or acknowledgement ownership.
- This refactor is optional for the assignment. Its benefit is a clearer boundary and handler tests that express application intent. Its cost is two port modules, one builder module, and import/test maintenance. It provides no throughput or delivery improvement.

## Research

No new library API or dependency is introduced. Reuse the pinned versions and source-backed behavior recorded in the service specs:

- [MongoDB driver Collection](https://mongodb.github.io/node-mongodb-native/7.6/classes/Collection.html) — `mongodb@7.6.0`; retain the existing `findOneAndUpdate` call, update pipeline, and pre-update result semantics.
- [FindOneAndUpdateOptions](https://mongodb.github.io/node-mongodb-native/7.6/interfaces/FindOneAndUpdateOptions.html) — retain `upsert: true`, `returnDocument: 'before'`, and `maxTimeMS`.
- [amqplib channel API](https://amqp-node.github.io/amqplib/channel_api.html) — `amqplib@2.0.1`, as recorded in the service specs. No AMQP call changes are planned.
- TypeScript `6.0.3` and Vitest `4.1.11` remain pinned in `pnpm-workspace.yaml`; reuse the repository's existing type-only imports and test APIs.

## File Changes

| Action | Path                                                | Purpose                                                                            |
| ------ | --------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Create | `apps/ingest/src/publish-port.ts`                   | Own `PublishRequest` and `PublishPort`.                                            |
| Modify | `apps/ingest/src/publisher.ts`                      | Import and implement the extracted port.                                           |
| Modify | `apps/ingest/src/server.ts`                         | Import the port directly.                                                          |
| Modify | `apps/ingest/src/connection.ts`                     | Import the port directly.                                                          |
| Modify | `apps/ingest/src/test-publisher.ts`                 | Import the port and request directly.                                              |
| Create | `apps/processing/src/store-port.ts`                 | Own `StorePort` and `StoreWatcher`.                                                |
| Modify | `apps/processing/src/store.ts`                      | Implement the port and build the MongoDB update internally.                        |
| Modify | `apps/processing/src/handler.ts`                    | Send the message and timestamp to the port.                                        |
| Modify | `apps/processing/src/consumer.ts`                   | Import storage interfaces directly.                                                |
| Modify | `apps/processing/src/test-store.ts`                 | Record semantic state-write arguments.                                             |
| Modify | `apps/processing/src/consumer.test.ts`              | Update `StoreWatcher` import.                                                      |
| Modify | `apps/processing/src/consumer-registration.test.ts` | Update `StoreWatcher` import.                                                      |
| Modify | `apps/processing/src/handler.test.ts`               | Assert message and timestamp instead of a query.                                   |
| Modify | `apps/processing/src/store.test.ts`                 | Call the semantic state-write interface.                                           |
| Create | `apps/processing/src/mongo-state-update.ts`         | Own `StateUpdate`, `newerThanStoredExpr`, and `buildStateUpdate`.                  |
| Create | `apps/processing/src/mongo-state-update.test.ts`    | Receive existing builder and expression tests.                                     |
| Modify | `apps/processing/src/state-update.ts`               | Retain only pure outcome and gap logic.                                            |
| Modify | `apps/processing/src/state-update.test.ts`          | Retain outcome and gap tests.                                                      |
| Modify | `test/harness/services.ts`                          | Separate concrete store import from port imports.                                  |
| Modify | `test/harness/clients.ts`                           | Import storage interfaces from their owner.                                        |
| Modify | `test/integration/processing-consumer.test.ts`      | Extend C13 to verify the exact received timestamp stored through the real adapter. |
| Modify | `docs/specs/2026-09-13-ingest-design.md`            | Record the port's new owner.                                                       |
| Modify | `docs/specs/2026-09-13-processing-design.md`        | Record the new port signature and builder ownership.                               |

## Tasks

### Task 1: Extract application-owned ports [mechanical]

**Files:** The two new port files; `publisher.ts`, `server.ts`, `connection.ts`, and `test-publisher.ts` in ingest; `store.ts`, `handler.ts`, `consumer.ts`, `test-store.ts`, `consumer.test.ts`, and `consumer-registration.test.ts` in processing; both listed harness files; the ingest design spec.

**Invariant:** No behavior changes. Preserve all six invariants. Existing `test/integration/pipeline.test.ts` P2 and P3 prove duplicate and stale-event behavior; `test/integration/ingest-publisher.test.ts` exercises the actual publisher.

- [ ] Establish the baseline with `pnpm lint && pnpm typecheck && pnpm test`. Record existing failures separately; do not silently expand this refactor to fix them.
- [ ] Move `PublishRequest` and `PublishPort`, including their comments and members, from `publisher.ts` into `publish-port.ts`. Import `TelemetryMessage` there with `import type`.
- [ ] Move `StorePort` and `StoreWatcher` unchanged into `store-port.ts`. For this intermediate commit, import `StateUpdate` from `state-update.ts` and the document types from shared.
- [ ] Update every consumer listed above. In `test/harness/services.ts`, retain the runtime `MongoStore` import from `store.ts` and add a separate type import from `store-port.ts`.
- [ ] Do not leave compatibility re-exports in either adapter. These are private workspace modules; update all consumers instead.
- [ ] Add a dated amendment to the ingest spec naming `publish-port.ts` as the contract owner; retain prior behavioral decisions.
- [ ] Run the scoped checks below and root `pnpm typecheck` to check the harness. No new tests are needed for type-only extraction.
- [ ] Run spec-compliance review, then code-quality and test-quality review. For this task, test-quality review checks that import changes preserve existing assertions. Fix blocking, critical, and high-priority findings before committing.
- [ ] Commit: `Extract application-owned service ports`.

**Verify:**

```bash
pnpm --filter @telemetry/ingest test && pnpm --filter @telemetry/ingest typecheck && pnpm --filter @telemetry/ingest lint
pnpm --filter @telemetry/processing test && pnpm --filter @telemetry/processing typecheck && pnpm --filter @telemetry/processing lint
pnpm typecheck
```

### Task 2: Put MongoDB expressions behind the storage port [integration]

**Files:** `store-port.ts`, `store.ts`, `handler.ts`, `test-store.ts`, `handler.test.ts`, `store.test.ts`, `state-update.ts`, `state-update.test.ts`, and the two new `mongo-state-update` files in processing; `test/harness/clients.ts`; `test/integration/processing-consumer.test.ts`; the processing design spec.

**Invariant:** Preserve logical freshness, duplicate safety, and atomic state writes (1–3). Preserve concurrent processing and scaling (4–6). The storage operation stays a single conditional `findOneAndUpdate`; no read-before-write. Existing pipeline P2–P6 and `test/integration/processing-consumer.test.ts` provide real-service regression coverage. Concurrent same-device execution remains safe through the storage guard; this refactor does not introduce physical serialization.

Use this final port definition:

```ts
import type {
  AlertDocument,
  DeviceStateDocument,
  EventDocument,
  TelemetryMessage,
} from '@telemetry/shared';

export type StorePort = {
  insertEvent(doc: EventDocument): Promise<'inserted' | 'duplicate'>;
  applyState(
    message: TelemetryMessage,
    receivedAt: number,
  ): Promise<{ result: 'updated'; before: DeviceStateDocument | null } | { result: 'duplicate' }>;
  insertAlert(doc: AlertDocument): Promise<'inserted' | 'duplicate'>;
};

export type StoreWatcher = {
  watch(signal: AbortSignal): Promise<'ready' | 'aborted'>;
};
```

- [ ] Move `StateUpdate`, `newerThanStoredExpr`, and `buildStateUpdate` unchanged into `mongo-state-update.ts`. Move their existing test blocks and expression evaluator into `mongo-state-update.test.ts`. Keep outcome/gap tests with `state-update.ts`. Keep each file's needed fixture imports; do not duplicate the evaluator or expand its behavior.
- [ ] Change the port to the exact signature above. Update `TestStore.applyState(message, receivedAt)` to record `{ method: 'applyState', deviceId: message.deviceId, message, receivedAt }`. Change that variant of `StoreCall` accordingly. Preserve its scripted answers and callbacks.
- [ ] Replace the obsolete port comment about accepting a filter-bearing update. Document that `applyState` atomically updates the message's section and `lastEvent` under their separate freshness guards, using the supplied `receivedAt`. Explain that `before` is the pre-update document, or null on creation; `result: 'updated'` also covers a stale no-op. Preserve the documented `StoreError` rejection contract and explain that `result: 'duplicate'` denotes an upsert collision requiring the existing handler retry, not an instruction to skip a redelivered message.
- [ ] Change the existing handler expectations that compare `buildStateUpdate(...)` to assert `message` and `receivedAt` instead. Remove the builder import. Preserve assertions for write order, duplicate repair, collision retry, abort, and acknowledgement outcomes. Update the interface, implementations, and callers as one coherent change before running checks; an intentional compilation failure is not a behavioral test.
- [ ] In the handler, replace query construction and the first call with `let applied = await store.applyState(message, receivedAt);`. Replace the collision retry with `applied = await store.applyState(message, receivedAt);`. Keep both abort checks, the second-collision classification, and all later logic unchanged.
- [ ] In `MongoStore.applyState`, accept the same two arguments and set `const update = buildStateUpdate(message, receivedAt);` before its existing `try` block. Import the builder from `mongo-state-update.ts`. Keep the exact driver call, options, error mapping, and result union. Building before `try` preserves the previous treatment of a builder exception as a programming error rather than a driver error.
- [ ] In `store.test.ts`, replace `store.applyState(buildStateUpdate(exampleMessages.status, EXAMPLE_RECEIVED_AT))` with `store.applyState(exampleMessages.status, EXAMPLE_RECEIVED_AT)` and remove the builder import.
- [ ] In `test/harness/clients.ts`, change the `holdInserts()` wrapper to `applyState: (message, receivedAt) => store.applyState(message, receivedAt)`. This must forward the original timestamp. Run the existing processing consumer integration suite, including C11b, which uses this gate.
- [ ] Extend C13 in `test/integration/processing-consumer.test.ts` using its existing real broker, database, and direct publisher. Define `const receivedAt = 1_700_000_000_123;` and pass it to both calls as `await publisher.publish(message, receivedAt);`. After reading the repaired state, assert `expect(state?.diagnostic?.receivedAt).toBe(receivedAt);` and `expect(state?.lastEvent?.receivedAt).toBe(receivedAt);`. Retain every existing recovery, event-count, alert, and statistics assertion. These exact-value assertions catch an adapter that drops the argument or substitutes its clock; no new test infrastructure or sleep is needed.
- [ ] Search all `apps` and `test` files for `applyState`, `StorePort`, `StoreWatcher`, and `buildStateUpdate`. Check structural wrappers as well as imports for old signatures.
- [ ] Add a dated processing-spec amendment with the final signature and module ownership. State that only the adapter builds the pipeline and that the handler retains write sequencing, collision retry, and outcome classification. Do not mark historical implementation plans as unshipped or rewrite their completion evidence.
- [ ] Run the scoped checks and root checks below. The real-service tests are the authority for MongoDB behavior; the test expression evaluator is not sufficient proof.
- [ ] Run spec-compliance review, then code-quality and test-quality review. Fix blocking, critical, and high-priority findings before committing. Do not add snapshot or import-only tests just to increase coverage.
- [ ] Commit: `Build MongoDB state updates inside the storage adapter`.

**Verify:**

```bash
pnpm --filter @telemetry/processing test && pnpm --filter @telemetry/processing typecheck && pnpm --filter @telemetry/processing lint
pnpm lint && pnpm typecheck && pnpm test
```

## Verification Criteria

| #   | Criterion                                                                                                  | Evidence                                                                                                                                          |
| --- | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Ingest application consumers import the publisher interface without importing the adapter module.          | Inspect imports in `server.ts`, `connection.ts`, and `test-publisher.ts`; no old port re-export remains.                                          |
| 2   | Handler and storage port contain no MongoDB aggregation expressions or `StateUpdate` dependency.           | Inspect `handler.ts` and `store-port.ts`; builder imports appear only in the adapter and builder tests.                                           |
| 3   | The state write remains one conditional operation, with unchanged expression, options, and error behavior. | Review moved builder against its previous version and review `store.ts`; run real-service integration tests.                                      |
| 4   | Duplicate and stale events have no repeated effect or stale overwrite.                                     | Pipeline P2 and P3; processing consumer integration suite.                                                                                        |
| 5   | Section ordering, session ordering, and parallel device processing remain correct.                         | Pipeline P4, P5, and P6; multiple-consumer scenarios in processing integration suite.                                                             |
| 6   | Handler retry, abort, partial-write repair, and final verdict semantics are unchanged.                     | Existing handler tests with semantic port arguments; processing consumer integration suite.                                                       |
| 7   | Every downstream consumer compiles, including integration harness wrappers.                                | Root `pnpm typecheck`.                                                                                                                            |
| 8   | Repository checks pass and documentation reflects the new boundary.                                        | `pnpm lint && pnpm typecheck && pnpm test`; targeted formatting check of touched files; reviewed spec amendments.                                 |
| 9   | The adapter preserves the supplied received timestamp in both the updated section and `lastEvent`.         | Extended C13 in `test/integration/processing-consumer.test.ts` asserts the fixed value after real MongoDB persistence and partial-write recovery. |

## Test Plan and prerequisites

- Use existing tests for the refactor. Move builder tests; update handler arguments without weakening behavioral assertions. Extend C13 with the exact timestamp assertions specified in Task 2 to close the storage-boundary coverage gap found during self-review. Add further tests only if review identifies another real uncovered behavior affected by these changes.
- Docker must be available for the full pre-flight. `test/harness/global-setup.ts` manages the isolated `docker-compose.test.yml` stack. Do not manually start the development stack for these tests.
- Establish one baseline. Run scoped checks after each task, and full pre-flight at completion. A changed test file triggers test-quality review during implementation.
- No runtime or dependency changes are authorized by this plan. No new production feature is included.

## Checkpoint Recovery

1. Read this plan and its status, then inspect `git status` and recent commits.
2. Preserve unrelated edits, especially the pre-existing changes to `TODO.md`.
3. Resume the first unchecked task; verify any partially completed moves before continuing.
4. Record task commits, review outcomes, and verification results here. Mark the plan shipped only after both tasks and final verification pass.

## Backbrief

The final handler passes telemetry intent through an application-owned port, and MongoDB query construction belongs to the storage adapter. Ingest consumers also import their publisher contract independently of the adapter. Atomic freshness checks, the three-write recovery sequence, and acknowledgement timing must remain unchanged. Implementation may adjust imports and test setup within the listed files, but it may not add layers, change delivery guarantees, or broaden the refactor.

## Review

Review completed in two iterations on 2026-09-15: PASS, zero blocking findings. The first review found a missing instruction to forward both state-write arguments in the integration harness. The second review verified that correction, the C11b verification requirement, and the explicit test-quality review for Task 1.

Subsequent self-review identified three corrections, now incorporated: exact timestamp verification through the real adapter in C13; updated behavioral documentation for the storage port; and removal of the deliberate compilation-failure step. The integration test file is included in Task 2 ownership and the file table, and criterion 9 covers its new assertions. Amendment review on 2026-09-15: PASS, zero blocking findings; the reviewer verified the timestamp input, C13 assertions, and port semantics against current code.

Planning verification: `git diff --check` passed. Attempts to run formatting, typecheck, lint, and tests stalled in the local pnpm launcher; even `pnpm --version` did not return. No code checks are claimed as passed. Implementation must establish the baseline specified in Task 1.
