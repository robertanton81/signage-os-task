# CI Follow-up Implementation Plan

**Goal:** Make CI green again and true: C11b asserts the at-least-once handoff that a graceful stop actually gives, behind a drain boundary that is established on the queue's own state and a barrier dispatched after every redelivery; the specs, the ledger and the consumer's own comments stop claiming an exact handoff; and the two unit tests that flake on GitHub's runner get assertions that hold there.

**Approach:** Five small commits on `main`, then the user's push and one green CI run recorded in a sixth. The C11b change is proven by reproductions in a throwaway worktree, none of them timed: mutant M1 (the consumer drops the acknowledgement frames of its last 16 deliveries) reproduces the CI failure text (`acked 166 of 150`) against the current test and passes the new one; mutant M3 (M1 plus a link close that waits for a gate the test releases) holds the pending-redelivery state for as long as the test wants and shows that the previous boundary accepts that state while the new one waits and then finds all 16; mutant M2 (no drain) still fails the new test. No queue counter is read anywhere: for a quorum queue `rabbitmqctl list_queues` reports tick metrics, and `checkQueue` has no unacknowledged count — but its consumer count is a live query of the queue's consumer map, and that map keeps a cancelled consumer until everything it held is settled or returned. No product behaviour changes: under `apps/*/src` only the two test files and two doc comments of the consumer change; the consumer keeps the channel-first close of `1f0a783`, which narrows the window and costs nothing.

**Design spec:** none new. Binding: `docs/specs/2026-09-14-integration-tests-design.md` (decisions 13 and 24 and the C11b row, all amended by Task 2), `docs/specs/2026-09-13-processing-design.md` (decision 20, corrected by Task 2), `docs/specs/2026-09-11-telemetry-consistency-design.md` (T70, reopened by Task 2). Verification report: the `/verify` of `docs/plans/2026-09-15-integration-tests-plan.md` on 2026-09-15 (criterion 19 FAIL, F1 and F2), whose findings this plan executes.
**TODO items:** `7. Integrační testy` — the CI item (`Volitelně: CI pipeline`) is ticked but red; this plan makes it green and corrects the T70 sentence of the step's paragraph. No new item.
**Branch:** `main`, small atomic commits, imperative subjects, no `Co-Authored-By`, no AI mention. Before the first commit: `git status` clean, `git log -1` at `932e809` or a descendant, `ListAgents` shows no active peer session on this repository (three idle ones existed on 2026-09-15 afternoon). Mutants run only in a throwaway worktree under the session scratchpad, never in the main checkout.
**Scope:** Modify `test/integration/processing-consumer.test.ts`, `apps/ingest/src/server.test.ts`, `apps/emulator/src/connection.test.ts`, two doc comments in `apps/processing/src/consumer.ts` (no behaviour change), three specs, `TODO.md`, the header of `docs/plans/2026-09-15-integration-tests-plan.md`. Nothing under `apps/*/src` except the two `*.test.ts` files and those two comments; nothing in `packages/`; nothing in `test/harness/`.

**Reading this plan:** every block that is to be pasted or matched verbatim sits in a `text` fence with its real indentation, because Prettier reformats fenced `ts` blocks and normalizes inline code spans (both happened to the first draft of this plan; the plan reviewer caught it). Task 2's `Old:` blocks are proven verbatim against the live files by `grep -F` before the task starts (its first step).

**Review corrections (2026-09-15):** plan-reviewer round 1 — the consumer's doc comments carried the disproved claim (now Edits 2.1 and 2.2), the worktree path is session-specific, M2 must be measured alone, one stale sentence in the C11b row (Edit 2.11). Round 2 — Prettier artifacts, fixed by the `text` fences. The user's first review — (P1) the boundary `queueDepth.ready === 0 && inFlight === 0` cannot see a delivery the broker has already sent that amqplib has not dispatched yet, and the database cannot see a duplicate; (P2) the CI run must be the push run of the pushed commit's full `headSha` (A10, Task 5). The user's second review — (P1) `rabbitmqctl list_queues` counts are cached metrics for a quorum queue (`queue_coarse_metrics`, written on a 5 s tick, missing entry read as 0) — dropped; (P2) a proof built on a two-second timer depends on machine speed — the mutant waits for a gate the test releases (A4); (P3) `Number(null)` coercion in the count parser — moot, the parser no longer exists. The user's third review — (P1) `connection.close_ok` is sent once the reader has forgotten the channel at `channel_closing`, before the channel process exits, so it proves nothing about the queue's DOWN: the barrier is now preceded by a queue-side requeue boundary, the live consumer count of `checkQueue` reading 1 (A2, Research); (P2) a global gate awaited by every link close could deadlock cleanup: the gate holds only the first link close in the process (a's), is released on the test's abort and by the recovery stack, and the global is removed with it (A4); (P2) `awaitEndState` can complete before b's last handler settles: the gated variant waits `awaitAcked(b, 150)` before it inspects the old boundary; (P2) criterion 10's grep matched a comment: narrowed to uses.

## Assumptions decided without asking (standing instruction: work autonomously, log every decision)

| #   | Decision                                                                                                                                                                                                                                                                                                                                                                                                             | Why                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A1  | The consumer keeps the channel-first close of `1f0a783`; no behaviour change in product code. Only the two doc comments in `consumer.ts` that repeat the disproved claim (`stop()`, `#closeLink`) are corrected, in Task 2 (plan review, 2026-09-15).                                                                                                                                                                | The user chose option A on 2026-09-15 ("as you recommend"). The close order removes the losses a fast machine sees (7 of 7, then 8 starved-container runs) and costs no time; only the claim attached to it was wrong, and the code's own comments carry that claim too.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| A2  | C11b's drain boundary, after `awaitEndState(expected)`, in two steps: (1) `queueDepth(env).consumers === 1` — b alone in the queue's consumer map; (2) one barrier message (a `status` of device `c11b-barrier`) published through the direct publisher, b's `delivery processed` line of that device, then `b.stats().inFlight === 0`. The barrier's event counts in the totals (`151 + n` deliveries, 201 events). | Step 1 is queue-side and live: `checkQueue`'s consumer count comes from `rabbit_fifo_client:stat`, a `local_query` of `rabbit_fifo:query_stat` = `{messages_ready, maps:size(Consumers)}`; a consumer cancelled by `basic.cancel` stays in that map with `status = cancelled` until its checked-out set is empty ("there are unsettled items so need to keep around"), and its channel's DOWN removes it after `return_all` (Research). So a count of 1 means everything a held was settled or returned — and returned messages sit in `returns`, drained before `messages`. Step 2: the barrier is enqueued after that, so it is dispatched to b after every returned delivery, and one channel dispatches in order: once b processed the barrier, a redelivered duplicate still on the wire has been dispatched, and `inFlight === 0` then means every dispatched handler settled. The connection close-ok is not a boundary (the user's finding: the reader forgets a channel at `channel_closing`, before the channel process exits). |
| A3  | The at-least-once assertions are the pre-`d1be9f9` shape: `b.received === 151 + n`, `b.acked === 151 + n`, `n <= 50`, every redelivered line `outcome: 'stale', duplicate: true`.                                                                                                                                                                                                                                    | That shape was measured on this machine before the fix (one redelivery) and matches CI's numbers (16); `stale` because the stopped instance applied the state before it acknowledged, `duplicate` because the event insert hits the unique index. The `+1` is the barrier.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| A4  | The reproductions are untimed. M1 drops the acknowledgement frames of a's deliveries beyond the 34th while counting them, active only after `stop()` was entered. M3 gates the first link close in the process (a's) on a promise the test resolves; the gated variant releases it itself, on the test's abort signal and from the recovery stack, and deletes the global with the release.                          | The loss cannot be reproduced on this machine by starving a container (8 runs green); M1 produces exactly what the CI runner produced (`acked 166 of 150`) deterministically, and only instance a stops during the test, so b is unaffected. The gate holds the pending-redelivery state without a timer; gating only the first close keeps b's stop and `dispose()` free of it, and the three release paths keep a failed variant from hanging the hook (the user's findings).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| A5  | The timer tolerance in `server.test.ts` is 5 ms, a named constant.                                                                                                                                                                                                                                                                                                                                                   | Node guarantees no exact timing for a timer; CI measured 299.94 ms for a 300 ms budget. The alternative the assertion rules out (the ping closing the socket) would end the connection at about 100 ms, 200 ms away, so 5 ms keeps the distinction with room for a whole millisecond of drift.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| A6  | The black-hole handshake test asserts that at least one attempt failed and that every failure reason is the handshake timeout, instead of stopping the connection at its first `backoff`.                                                                                                                                                                                                                            | Full Jitter can schedule the second attempt almost at once (`backoffDelay`, `[0, 500 ms)` for attempt 0) and `vi.waitFor` polls every 50 ms, so a second attempt can time out before the poll on a slow runner. Stopping inside the poll callback would couple the test to the poll cadence.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| A7  | The CI run id is recorded in a separate docs commit after the user's push (two pushes).                                                                                                                                                                                                                                                                                                                              | A record that names a run must follow the run. The second push carries a docs-only commit.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| A8  | The integration-tests plan's header gets one corrected sentence in its deferral (1).                                                                                                                                                                                                                                                                                                                                 | That header says the `150 + n` tolerance "is history"; a reader of the plan would otherwise take the exact remainder as a proven property.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| A9  | Decision 13 is amended (Edit 2.17): the consumer count is a requeue boundary and the barrier a dispatch boundary; neither is a completion signal — the rejection of sentinels as the completion signal stands, because handlers run concurrently and the barrier's own processing proves nothing about the others; completion stays the end state plus `inFlight === 0`, now read after the barrier.                 | Without the amendment the spec and C11b would contradict each other; with it, the reasoning that rejected sentinels is kept and the new use is limited to what a live consumer query and a single channel's in-order dispatch guarantee. The amendment also records why no queue counter serves (the tick metrics) and why the connection close-ok does not.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| A10 | Task 5 selects the CI run by the pushed commit's full `headSha` among the CI workflow's push runs, polling until that run exists, and Task 6 records that run's id.                                                                                                                                                                                                                                                  | The latest run of the branch can be an older commit's run while GitHub has not created the new one yet (the user's finding); a record must name the run of the commit it claims green.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| A11 | The test stack is one broker node, and the ordering argument of A2 is stated for one node.                                                                                                                                                                                                                                                                                                                           | `docker-compose.test.yml` runs one `rabbitmq` container; a cluster would add a leader on another node and cross-node signal timing that this argument does not cover. Recorded in the decision 13 amendment.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |

## Research (source links)

- [`rabbit_fifo_client.erl` at tag v4.3.5](https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.3.5/deps/rabbit/src/rabbit_fifo_client.erl) — read 2026-09-15: `-define(SOFT_LIMIT, 32)`; `settle/3` stashes the settle in `unsent_commands` once the client is slow ("we've reached the soft limit so will stash the command to be sent once we have seen enough notifications"), otherwise sends it with `normal` priority; the stash is sent again from the `{applied, Seqs}` ra_event handler when `map_size(pending) < SftLmt`; `close/1` evicts a cache and sends nothing. This is the loss C11b sees on CI. Also `stat(Leader, Timeout)` → `local_query(Leader, query_stat, Timeout)` → `{ok, R, C}`: the ready count and the consumer count that `rabbit_quorum_queue:stat/2` hands to `queue.declare` (amqplib `checkQueue`, `consumerCount`) — a live query of the leader's state. A2, step 1.
- [`rabbit_fifo.erl` at tag v4.3.5](https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.3.5/deps/rabbit/src/rabbit_fifo.erl) — read 2026-09-15 (the raw file, 4 328 lines): `query_stat(#?STATE{consumers = Consumers} = State) -> {messages_ready(State), maps:size(Consumers)}` — the whole map, cancelled consumers included; `maybe_return_all` for reason `cancel` keeps the consumer through `update_or_remove_con` with `lifetime = once, credit = 0, status = cancelled`, and `update_or_remove_con` removes such a consumer only when `map_size(Checked)` is 0 ("we're done with this consumer") and otherwise keeps it ("there are unsettled items so need to keep around"); for any other reason (`down`) `maybe_return_all` calls `return_all` and then `maps:remove`; every consumer's channel pid carries a `{monitor, process, Pid}` effect and `apply_(Meta, {down, Pid, _Info}, …)` → `handle_down` → `cancel_consumer(…, down)`; returned messages live in the `returns` lqueue (`messages_ready` = `rabbit_fifo_pq:len(M) + lqueue:len(R)`) and `take_next_msg` drains `returns` before `messages`. A2: a consumer count of 1 after b registered means a's consumer record is gone, which happens only once everything a held was settled or returned. Measured 2026-09-15 on the test stack with an amqplib probe (scratchpad only, not in the repository) against a quorum queue: a consumer holding 5 unacknowledged deliveries read `consumers=1` after its cancel-ok and still after acknowledging 3 of the 5; closing its channel returned the 2 unsettled (`ready=2`) and removed the record (`consumers=0`).
- [`rabbit_reader.erl` at tag v4.3.5](https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.3.5/deps/rabbit/src/rabbit_reader.erl) — read 2026-09-15 (the user's third-review finding): `handle_other({channel_closing, ChPid}, State)` calls `rabbit_channel_common:ready_for_close(ChPid)` and then `channel_cleanup`, which erases the channel and decrements `channel_count` while the channel process is still alive; `maybe_close` sends `#'connection.close_ok'{}` in its `channel_count = 0` clause, so `connection.close_ok` can be sent before the channel process exits and before the queue receives its DOWN; the channel's later DOWN reaches `handle_dependent_exit` with `Channel = undefined` and is ignored. Therefore neither close-ok is a requeue boundary; the consumer count is.
- [`rabbit_channel.erl` at tag v4.3.5](https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.3.5/deps/rabbit/src/rabbit_channel.erl) — read 2026-09-15: `basic.ack` → `settle_acks` → `rabbit_queue_type:settle` (asynchronous); `channel.close` notifies the queues, hands off to the reader and replies `close_ok` from `ready_for_close`; `terminate/2` calls `rabbit_queue_type:close` and flushes no pending settle.
- [`rabbit_quorum_queue.erl` at tag v4.3.5](https://github.com/rabbitmq/rabbitmq-server/blob/v4.3.5/deps/rabbit/src/rabbit_quorum_queue.erl#L1978-L1983) — read 2026-09-15 (the user's second-review citation): `i(messages_ready, Q)` and `i(messages_unacknowledged, Q)` are `ets:lookup_element(queue_coarse_metrics, QName, 2 | 3, 0)` — a cached metric with default 0 — written by `handle_tick` (`rabbit_core_metrics:queue_stats`) on the state machine's tick, `TICK_INTERVAL` 5000 ms; `i(consumers, Q)` reads `queue_metrics` the same way. `stat/2`, behind AMQP `queue.declare` passive, calls `rabbit_fifo_client:stat(Leader, Timeout)` — live, ready count and consumer count only. So `rabbitmqctl list_queues` cannot be a boundary and `checkQueue` cannot see unacknowledged deliveries; the dev-stack reading of 129 ready in the `/verify` session was a tick's snapshot, not a live count.
- [Consumer acknowledgements, automatic requeueing](https://www.rabbitmq.com/docs/confirms#automatic-requeueing) — "any delivery (message) that was not acked is automatically requeued when the channel (or connection) on which the delivery happened is closed"; redeliveries carry `redelivered: true`; consumers must be idempotent. [Deliveries are asynchronous](https://www.rabbitmq.com/docs/confirms#channel-prefetch-setting-qos): "Messages are delivered (sent) to clients asynchronously, and there can be more than one message 'in flight' on a channel at any given moment" — the window the user's first finding named; the barrier closes it by in-order dispatch on b's channel.
- `packages/shared/src/logger.ts`, `messageLogger` — every log line about a message carries the identity fields (`deviceId`, `sessionId`, `seq`) as separate bindings (consistency spec, decision 21), so the barrier's `delivery processed` line is matched on `deviceId`. `apps/processing/src/handler.ts` line 106 builds the handler's logger with it; `LOG_LEVEL=debug` reaches the in-process capture (integration spec, decision 14). Task 1.
- `test/harness/environment.ts`, `dispose()` — the recovery stack runs in reverse registration order before the harness's own connections close; `startProcessing` registers an instance's stop on that stack (`test/harness/services.ts`). A gate registered between a's start and b's start is therefore released after b's stop and before a's — with the gate on a's close only, no cleanup step waits on it. A4.
- [Node.js timers, `setTimeout`](https://nodejs.org/api/timers.html#settimeoutcallback-delay-args) — "Node.js makes no guarantees about the exact timing of when callbacks will fire, nor of their ordering." Task 3.
- [Vitest `vi.waitFor`](https://vitest.dev/api/vi.html#vi-waitfor) — vitest 4.1.11; `interval` default 50 ms, `timeout` default 1000 ms; the callback is retried until it stops throwing. Task 4.
- `packages/shared/src/backoff.ts` — `backoffDelay` is Full Jitter, uniform in `[0, min(maxMs, baseMs * 2 ** attempt))`; the emulator's `BACKOFF_BASE_MS` is 500 (`apps/emulator/src/connection.ts`), so the first retry can start almost at once. Task 4.
- `gh run list --workflow ci.yml --event push --branch main --json databaseId,headSha,status,conclusion` — measured 2026-09-15: `34950460095 932e809418ea69eccdaa39748a790ec0394ef96b completed failure` and the run of `5b04f12` below it; `headSha` is the full 40-character sha. Task 5.

## File Changes

| Action | Path                                                    | Purpose                                                                                                  |
| ------ | ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Create | `docs/plans/2026-09-15-ci-followup-plan.md`             | This plan                                                                                                |
| Modify | `test/integration/processing-consumer.test.ts`          | C11b: end-state completion, the two-step drain boundary, at-least-once assertions, `LogLine` import      |
| Modify | `apps/processing/src/consumer.ts`                       | Two doc comments (`stop()`, `#closeLink`): what the close-ok proves; no behaviour change                 |
| Modify | `docs/specs/2026-09-11-telemetry-consistency-design.md` | T70 reopened with the mechanism and the bound                                                            |
| Modify | `docs/specs/2026-09-13-processing-design.md`            | Decision 20 (table cell, decisions log line, effects line, the 2026-09-15 amendment): the close-ok claim |
| Modify | `docs/specs/2026-09-14-integration-tests-design.md`     | Decisions 13 and 24, the C11b row, invariant rows 2 and 6, the concurrency row                           |
| Modify | `TODO.md`                                               | Step 7 paragraph: the T70 sentence; the CI run (Task 6)                                                  |
| Modify | `docs/plans/2026-09-15-integration-tests-plan.md`       | Header, deferral (1)                                                                                     |
| Modify | `apps/ingest/src/server.test.ts`                        | Timer tolerance on the close-budget bound                                                                |
| Modify | `apps/emulator/src/connection.test.ts`                  | Handshake-timeout assertion that allows a second attempt                                                 |

## Tasks

### Task 1: C11b asserts the at-least-once handoff behind a two-step drain boundary [integration]

**Files:** Modify `test/integration/processing-consumer.test.ts`
**Invariant:** 2 (every redelivered message is absorbed as `duplicate` + `stale`: no event, counter, alert or state effect repeats), 6 (a second instance takes over the rest). Proven by C11b itself; the reproductions below show that the assertions fail a stop that does not drain, and that the boundary waits on a pending redelivery which the previous boundary accepted as absent.
**Verify:** `pnpm test:integration test/integration/processing-consumer.test.ts -t C11b` (three runs, all green), then `pnpm typecheck && pnpm lint && pnpm exec prettier --check test/integration`.

The reproductions run in a throwaway worktree so that the main checkout never holds a mutant (`[[feedback-parallel-sessions]]`). `WT` below is that worktree's path; the Docker test stack is started and removed by each run's global setup, so the runs are one at a time. Every mutant is applied to `$WT/apps/processing/src/consumer.ts`; the worktree's copy of the test file is refreshed from the main checkout with `cp` where the steps say so, and the gated variant edits that copy only.

- [ ] Create the worktree at the current commit and install offline. `WT` is a directory under the scratchpad of the session that runs the task (the path below is the authoring session's; a later session derives its own from its system prompt):

```bash
WT=/private/tmp/claude-501/-Users-robertanton-Projects-Rob-signage-os-task/97ced0d5-519f-4571-aa8c-0b2eacd1c133/scratchpad/ci-followup-worktree
git worktree add --detach "$WT" HEAD
cd "$WT" && pnpm install --offline --frozen-lockfile
```

- [ ] Apply mutant M1 to `$WT/apps/processing/src/consumer.ts` (the acknowledgement frames of a's deliveries beyond the 34th are never sent, while the counters say they were — the stash the broker drops). Three insertions, shown with the file's indentation:

```text
  // (1) a new private field, next to `#inFlight = 0;`
  /** MUTANT M1: set by stop(); acknowledgements past the 34th are counted but never sent. */
  #dropAcks = false;

  // (2) the first statement of `async stop(): Promise<void> {`
    this.#dropAcks = true;

  // (3) in `#acknowledge`, right after `registration.held.delete(message.fields.deliveryTag);`
    if (this.#dropAcks && this.#counters.acked > 34) {
      return;
    }
```

- [ ] In `$WT`: `pnpm test:integration test/integration/processing-consumer.test.ts -t C11b` → **fails** with `wait timed out after 20000 ms: acked 166 of 150, inFlight 0` — the CI failure, reproduced.
- [ ] In the main checkout, change the import of the wait helpers and add the barrier's device id after the two timeout constants:

```text
import { WARN_LEVEL, byMsg, type LogLine } from '../harness/wait.js';
```

```text
/** The device of C11b's barrier message: distinct from the load's `load-NNNN` devices. */
const BARRIER_DEVICE = 'c11b-barrier';
```

- [ ] In the main checkout, in C11b replace everything from the line `const b = await registeredProcessing(env, { hostname: 'b' });` to the line `expect((await queueDepth(env))?.ready).toBe(0);` (inclusive; both sit at four spaces inside the `it` callback) with the block below, pasted with its indentation:

```text
    const b = await registeredProcessing(env, { hostname: 'b' });
    // The handoff is at-least-once (T70): a's channel close-ok proves that the channel received
    // the acknowledgements, not that the queue applied them (RabbitMQ 4.3.5's quorum-queue client
    // stashes settles once 32 commands are pending and never flushes the stash at a channel
    // close), so the queue can return some of a's fifty when a's channel goes down — none on a
    // fast machine, 16 of 50 on the 2-vCPU CI runner — and b stores them as duplicates.
    const redelivered = (): LogLine[] =>
      b.logs.filter((line) => line.msg === 'delivery processed' && line['redelivered'] === true);
    await env.awaitEndState(expected);
    // The drain boundary (integration spec, decision 13 as amended), in two steps. (1) The queue
    // keeps a's cancelled consumer in its consumer map until every delivery it held is settled
    // or, on a's channel DOWN, returned; `checkQueue`'s consumer count is a live query of that
    // map, so once it reads 1 (b alone) whatever a never settled has been returned, ahead of
    // anything enqueued later. (2) A barrier published now is dispatched to b after every one of
    // them, and b's channel dispatches in order — so once b has processed the barrier, a
    // redelivered duplicate still on the wire has been dispatched too, and `inFlight === 0` then
    // means every dispatched handler settled. The connection close-ok proves less (the reader
    // forgets a channel at `channel_closing`, before the channel process exits), the database
    // cannot see a duplicate, and no queue counter can say it either: for a quorum queue the
    // `messages_unacknowledged` of `rabbitmqctl` is a 5 s tick metric.
    let depth: QueueDepth | undefined;
    await env.waitFor(
      async () => {
        depth = await queueDepth(env);
        return depth?.consumers === 1;
      },
      { describe: () => `queue ${JSON.stringify(depth)}, b ${JSON.stringify(b.stats())}` },
    );
    const barrier = messages(BARRIER_DEVICE, SESSION_A).status(1);
    await publisher.publish(barrier);
    await b.logs.waitForLine(
      (line) => line.msg === 'delivery processed' && line['deviceId'] === BARRIER_DEVICE,
    );
    await env.waitFor(() => b.stats().inFlight === 0, {
      describe: () => `b ${JSON.stringify(b.stats())}`,
    });

    const [sa, sb] = [a.stats(), b.stats()];
    const n = redelivered().length;
    const detail = `a ${JSON.stringify(sa)}, b ${JSON.stringify(sb)}, redelivered ${String(n)}`;
    // A stop that does not cancel first shows as `a.acked > 50` and `b.received < 151`; one that
    // does not wait for its handlers as `a.abandoned > 0` and redeliveries that are not duplicates.
    expect(sa, detail).toMatchObject({ received: 50, acked: 50, abandoned: 0, failed: 0 });
    expect(a.logs.find(byMsg('shutdown drain ended at its budget'))).toBeUndefined();
    // The other 150, the barrier, and the redeliveries.
    expect(sb, detail).toMatchObject({ received: 151 + n, acked: 151 + n, failed: 0 });
    // Only acknowledgements of the one drain can be lost, and a had stored each redelivered message.
    expect(n, detail).toBeLessThanOrEqual(50);
    for (const line of redelivered()) {
      expect(line, detail).toMatchObject({ outcome: 'stale', duplicate: true });
    }
    const events = await readEvents(env);
    expect(identitiesOf(events)).toEqual(
      new Set([...expected.identities, messageIdentity(barrier)]),
    );
    expect(events).toHaveLength(201);
    expect(new Set((await readAlerts(env)).map((alert) => alert._id))).toEqual(expected.alerts);
    expect(await stateMismatches(env, expected)).toEqual([]);
    expect((await queueDepth(env))?.ready).toBe(0);
```

- [ ] `pnpm exec prettier --write test/integration/processing-consumer.test.ts`. The comments above `const stopping = a.stop();` describe the gate and stay.
- [ ] Copy the edited test into the worktree, M1 still applied: `cp test/integration/processing-consumer.test.ts "$WT/test/integration/"`. Run C11b in `$WT` → **passes** (the old test failed on these numbers, the new one holds them).
- [ ] Apply mutant M3 on top of M1 (deliberately combined: M1 supplies the 16 unsettled deliveries, M3 holds a's channel open until the test says otherwise). In `$WT/apps/processing/src/consumer.ts`, two insertions:

```text
  // (1) module scope, after the imports
  /** MUTANT M3: the first link close in this process (a's stop) waits for the test's gate. */
  let closeGateUsed = false;

  // (2) the first statements of `async #closeLink(): Promise<void> {`
    if (!closeGateUsed) {
      closeGateUsed = true;
      await (globalThis as { __closeGate?: Promise<void> }).__closeGate;
    }
```

- [ ] Make the gated variant of the test in the worktree's copy only (`$WT/test/integration/processing-consumer.test.ts`), three edits inside C11b. (G1) Right before the line `const startedAt = performance.now();` insert:

```text
    // GATED VARIANT: the mutant's first `#closeLink` (a's) waits for this promise. Released by
    // the test, on the test's abort, and by the recovery stack; the global goes with the release.
    const closeGate = Promise.withResolvers<void>();
    const gateHolder = globalThis as { __closeGate?: Promise<void> };
    gateHolder.__closeGate = closeGate.promise;
    const releaseCloseGate = (): void => {
      closeGate.resolve();
      delete gateHolder.__closeGate;
    };
    env.signal.addEventListener('abort', releaseCloseGate, { once: true });
    env.undo(() => {
      releaseCloseGate();
      return Promise.resolve();
    }, 'release close gate');
```

(G2) Replace everything from the line `await stopping;` through the line `await env.awaitEndState(expected);` (inclusive: the stop bound, `const b`, the first comment, `redelivered`, the end-state wait) with:

```text
    // GATED VARIANT: a's link stays open with its 16 unsettled deliveries while b stores the
    // other 150 — the pending-redelivery state the review named — until the gate is released.
    const b = await registeredProcessing(env, { hostname: 'b' });
    const redelivered = (): LogLine[] =>
      b.logs.filter((line) => line.msg === 'delivery processed' && line['redelivered'] === true);
    await env.awaitEndState(expected);
    // b has settled everything it was given (a's channel is held, so nothing else can arrive).
    await env.awaitAcked(b, 150);
    // The previous boundary accepts this state: nothing ready, nothing in flight, no redelivery
    // seen — while the queue still counts a's cancelled consumer, which the new boundary waits on.
    expect((await queueDepth(env))?.ready).toBe(0);
    expect(redelivered()).toHaveLength(0);
    expect((await queueDepth(env))?.consumers).toBe(2);
    releaseCloseGate();
    await stopping;
    const stopMs = performance.now() - startedAt;
    expect(stopMs).toBeLessThan(
      shutdownTimeoutMs + AMQP_CLOSE_TIMEOUT_MS + MONGODB_TIMEOUT_MS + 2_000,
    );
```

(G3) Right after the line `const detail = ...;` (the template literal that starts with `` `a ${JSON.stringify(sa)}``) insert:

```text
    expect(n, detail).toBe(16);
```

- [ ] `cd "$WT" && pnpm test:integration test/integration/processing-consumer.test.ts -t C11b` → **passes**: the expectations of (G2) held (the previous boundary would have completed with `redelivered 0` while 16 deliveries were pending on a's open channel, and the queue's consumer count was 2 — the user's findings, measured without a timer), and after the release the consumer count reached 1, the barrier followed the 16, and (G3) found exactly 16. No step of this run depends on machine speed: the state is held by the gate, and every wait is on a state the gate controls.
- [ ] Revert M1 and M3 so that M2 is measured alone: `git -C "$WT" checkout -- apps/processing/src/consumer.ts && cp test/integration/processing-consumer.test.ts "$WT/test/integration/"`. Then apply mutant M2 (no drain: abort the handlers at once). Replace the whole `if (this.#state.name === 'draining') { … }` block of `stop()` with:

```text
    if (this.#state.name === 'draining') {
      // MUTANT M2: no drain — the handlers are aborted at once.
      this.#dispatch({ type: 'drained', generation: this.#state.generation });
    }
```

- [ ] Run C11b in `$WT` → **fails** at `expect(sa, detail).toMatchObject({ received: 50, acked: 50, abandoned: 0, failed: 0 })` with `abandoned: 50` in the detail (the new assertions still catch a stop that does not drain).
- [ ] Remove the worktree: `git worktree remove --force "$WT" && git worktree prune`; `git worktree list` shows only the main checkout.
- [ ] Main checkout: the verify line above (three green C11b runs; `n` is 0 on this machine, so the loop over `redelivered()` runs zero times, which is why the mutant steps exist). Nothing left in Docker: `docker compose -f docker-compose.test.yml ps -aq | wc -l` → 0. `git status --porcelain apps/processing test/harness` prints nothing; `grep -c "__closeGate" test/integration/processing-consumer.test.ts` → 0.
- [ ] Commit the test file — subject: `Assert the at-least-once handoff in C11b`.

What fails it (the convention of the integration-tests plan): a stop that closes the connection without the channel close-ok shows as `n >= 1` here and as `acked 151 of 150` in the old form (measured before `1f0a783`); a stop that does not cancel first as `a.acked > 50`; a stop that does not wait for its handlers as `a.abandoned > 0` (M2); a handler that stores a redelivered message again as a `redelivered: true` line without `duplicate: true` or as `events.length > 201`; a boundary without step 1 or without the barrier as `redelivered 0` in the gated run (G3).

### Task 2: The specs, the ledger, the plan header and the consumer's comments stop claiming an exact handoff [mechanical]

**Files:** Modify `docs/specs/2026-09-11-telemetry-consistency-design.md`, `docs/specs/2026-09-13-processing-design.md`, `docs/specs/2026-09-14-integration-tests-design.md`, `TODO.md`, `docs/plans/2026-09-15-integration-tests-plan.md`, `apps/processing/src/consumer.ts` (two doc comments)
**Invariant:** none touched (documentation; the consumer's behaviour is unchanged).
**Verify:** `pnpm exec prettier --write` on the five Markdown files, then `pnpm format:check`; `grep -rn "T70 closed\|asserts the exact remainder again\|přesný zbytek 150" docs/specs TODO.md docs/plans/2026-09-15-integration-tests-plan.md apps/processing/src/consumer.ts` prints nothing (the past tense "asserted the exact remainder again" is what remains); `pnpm --filter @telemetry/processing test && pnpm --filter @telemetry/processing typecheck && pnpm --filter @telemetry/processing lint`; `git show HEAD -- apps/processing/src/consumer.ts | grep -E '^[+-][^+-]' | grep -vE '^[+-] *(\*|/\*\*)'` prints nothing (only comment lines changed); `git show --stat HEAD` lists exactly the six files.

Each edit below replaces the `Old:` text by the `New:` text, once, in the named file. The Markdown tables are one line per row, so an `Old:` text that is part of a row is a substring of one line; Prettier re-pads the columns afterwards. The two comment edits replace whole lines of the TypeScript file.

- [ ] Before any edit, prove every `Old:` block verbatim against the live files: for each edit, `grep -F -c -- '<Old text>' <file>` → 1 (a multi-line `Old:` block is checked with `pnpm exec node -e` reading the file and `String.prototype.includes`). A mismatch stops the task: re-copy the text from the file, do not retype it.

**Edit 2.1 — `apps/processing/src/consumer.ts`, the doc comment of `stop()`.**

Old:

```text
   * channel first so that the last acknowledgements take effect (T70).
```

New:

```text
   * channel first, which keeps the acknowledgements the channel received from being lost with the
   * connection (T70; not a proof that the queue applied them, see `#closeLink`).
```

**Edit 2.2 — `apps/processing/src/consumer.ts`, the doc comment of `#closeLink` (the whole comment directly above `async #closeLink(): Promise<void> {`).**

Old:

```text
  /**
   * The `close_link` effect: closes the channel and waits for its close-ok, then the connection,
   * both within one `AMQP_CLOSE_TIMEOUT_MS` (decision 20, amended 2026-09-15). The broker applies a
   * channel's frames in order, so the close-ok proves that every acknowledgement sent before it
   * took effect; a connection close right after the last acknowledgement lost it, and the broker
   * redelivered that message to the next instance (T70, measured with C11b).
   */
```

New:

```text
  /**
   * The `close_link` effect: closes the channel and waits for its close-ok, then the connection,
   * both within one `AMQP_CLOSE_TIMEOUT_MS` (decision 20, amended 2026-09-15). The close-ok proves
   * that the channel received every acknowledgement sent before it — a connection close right
   * after the last acknowledgement lost it, and the broker redelivered that message (T70, measured
   * with C11b). It does not prove that the queue applied them: the quorum-queue client stashes
   * settles above 32 pending commands until a Ra `applied` event and never flushes the stash at a
   * channel close (RabbitMQ 4.3.5, `rabbit_fifo_client.erl`, `SOFT_LIMIT`), so a graceful stop
   * stays at-least-once and the next instance absorbs the redeliveries as duplicates (16 of 50
   * measured on the 2-vCPU CI runner, none on a fast machine).
   */
```

**Edit 2.3 — `docs/specs/2026-09-11-telemetry-consistency-design.md`, the T70 row (the whole line).**

Old:

```text
| T70 | A graceful stop redelivers the message acknowledged right before the link close | The consumer closes the connection as soon as the last handler acknowledged; the broker (quorum queue) loses that last acknowledgement and redelivers the message to the next instance, which stores nothing new (`duplicate`, `stale`). Measured 2026-09-15 in three runs of three (C11b) | Every graceful stop with deliveries in flight: one extra delivery per stop, absorbed by the dedup | Closed 2026-09-15: `#closeLink` closes the channel and awaits its close-ok before the connection close, both within one `AMQP_CLOSE_TIMEOUT_MS` (`1f0a783`); C11b asserts the exact remainder again (`d1be9f9`, seven runs of seven) | processing spec, 20 (amended 2026-09-15); integration spec, 24 |
```

New:

```text
| T70 | A graceful stop can redeliver messages acknowledged right before the channel close | The consumer cancels, drains and acknowledges every held delivery, then closes the channel (its close-ok awaited) and the connection (`1f0a783`). The close-ok proves that the channel received the acknowledgements, not that the queue applied them: RabbitMQ 4.3.5's quorum-queue client (`rabbit_fifo_client.erl`, `SOFT_LIMIT` 32) stashes settles once 32 commands are pending and sends the stash only on a Ra `applied` event; neither `close/1` nor the channel's terminate flushes it, so a channel closed right after a burst of acknowledgements can leave some never sent, and the queue returns those as unacknowledged. AMQP 0-9-1 confirms no acknowledgement, so no client can close the window. Measured 2026-09-15: one redelivery of 50 on this machine before `1f0a783`, none after (seven of seven, eight more with a CPU-starved broker or MongoDB); 16 of 50 in both CI runs on the 2-vCPU GitHub runner (`acked 166 of 150`) | Every graceful stop with deliveries in flight: at most the deliveries of one drain (`PROCESSING_PREFETCH`) come again, in practice those above the client's soft limit of 32 (16 of 50 measured); each was stored by the stopped instance and is absorbed as `duplicate` + `stale` by the next one, so no counter, alert or state effect repeats (invariant 2) | Reopened 2026-09-15 after `/verify`: C11b asserts the at-least-once handoff (`a.acked === 50`, no drain-budget line, `b.received === 151 + n` with every redelivered delivery `duplicate` and `stale`, the exact end state, an empty queue) behind a two-step drain boundary — the stopped instance's cancelled consumer has left the queue's consumer map (`checkQueue`, a live query), then a barrier message dispatched after every returned delivery; an exact handoff would need an acknowledgement confirmation the protocol does not have | processing spec, 20 (amended 2026-09-15 twice); integration spec, 13 and 24 |
```

**Edit 2.4 — `docs/specs/2026-09-13-processing-design.md`, decision 20, the end of the reasoning cell (the line starting `| 20  | Graceful shutdown order`).**

Old:

```text
the registration tests assert the order after an acknowledgement and the shared budget; C11b asserts the exact remainder again (`d1be9f9`, seven runs of seven); T70 closed. |
```

New:

```text
the registration tests assert the order after an acknowledgement and the shared budget; C11b asserted the exact remainder again (`d1be9f9`, seven runs of seven). **Corrected 2026-09-15 after `/verify`:** the close-ok proves that the channel received the acknowledgements, not that the queue applied them — RabbitMQ 4.3.5's quorum-queue client stashes settles once 32 commands are pending until a Ra `applied` event and never flushes the stash at a channel close (`rabbit_fifo_client.erl`, `SOFT_LIMIT`), and AMQP 0-9-1 confirms no acknowledgement; the 2-vCPU CI runner redelivered 16 of the 50 in both runs while this machine redelivers none. The channel-first close stays (it narrows the window at no cost), the exact remainder is not a property this protocol can give, T70 is reopened as a known limit and C11b asserts the at-least-once handoff (integration spec, 24). |
```

**Edit 2.5 — `docs/specs/2026-09-13-processing-design.md`, the effects line (the line starting with the `cancel_consumer` bullet).**

Old:

```text
which lost the last acknowledgement, T70);
```

New:

```text
which lost the last acknowledgement, T70; the close-ok does not prove that the queue applied them, T70 reopened 2026-09-15 — decision 20);
```

**Edit 2.6 — `docs/specs/2026-09-13-processing-design.md`, the end of the paragraph starting `**Amendment of 2026-09-15 (the channel's close-ok before the connection close, T70):**`.**

Old:

```text
and C11b asserts the exact remainder again (`1f0a783`, `d1be9f9`).
```

New:

```text
and C11b asserted the exact remainder again (`1f0a783`, `d1be9f9`). **Corrected 2026-09-15 after `/verify`:** the exact remainder held on this machine only; the CI runner redelivered 16 of the 50 in both runs, because the quorum-queue client stashes settles above 32 pending commands and never flushes the stash at a channel close — see decision 20 and T70 (reopened). C11b asserts `151 + n` (the other 150, its barrier message and the `n` redeliveries) with every redelivered delivery `duplicate` and `stale`.
```

**Edit 2.7 — `docs/specs/2026-09-13-processing-design.md`, the decisions-log line starting `Decision 20.`.**

Old:

```text
Amended 2026-09-15: the link close is the channel's close-ok, then the connection, within one close budget (T70, `1f0a783`).
```

New:

```text
Amended 2026-09-15: the link close is the channel's close-ok, then the connection, within one close budget (T70, `1f0a783`), which narrows but cannot close the window of a lost acknowledgement (T70 reopened after `/verify` the same day; the close-ok does not prove that the queue applied the acknowledgements).
```

**Edit 2.8 — `docs/specs/2026-09-14-integration-tests-design.md`, decision 24, the decision cell (the line starting `| 24  | The consumer's broker-restart and SIGTERM scenarios`).**

Old:

```text
**Fixed 2026-09-15** (`1f0a783`): the consumer closes the channel and awaits its close-ok before the connection close; C11b asserts `b.received === 150` and no `redelivered: true` line again (`d1be9f9`); T70 closed.
```

New:

```text
**Fixed 2026-09-15** (`1f0a783`): the consumer closes the channel and awaits its close-ok before the connection close; C11b asserted `b.received === 150` and no `redelivered: true` line again (`d1be9f9`). **Corrected 2026-09-15 after `/verify`:** the exact remainder holds on a fast machine only — the 2-vCPU CI runner redelivered 16 of the 50 in both runs (`acked 166 of 150`), because the quorum-queue client stashes settles above 32 pending commands and never flushes the stash at a channel close (T70, reopened); C11b's completion signal is `awaitEndState`, then the two-step drain boundary of decision 13 as amended — `queueDepth(env).consumers === 1` (a's cancelled consumer has left the queue's consumer map: everything it held was settled or returned), then one `status` message of device `c11b-barrier` published through the direct publisher, b's `delivery processed` line of that device, then `inFlight === 0` — and it asserts `b.received === 151 + n` and `b.acked === 151 + n` (the other 150, the barrier, the `n` deliveries with `redelivered: true`), each redelivered one `duplicate: true` and `stale`, `n <= 50`, and 201 events (the load's 200 plus the barrier).
```

**Edit 2.9 — `docs/specs/2026-09-14-integration-tests-design.md`, the C11b row, the completion cell (the line starting `| C11b | graceful drain with deliveries in flight`).**

Old:

```text
then `env.awaitAcked(b, 150)`
```

New:

```text
then `env.awaitEndState(expected)`, then one wait for `queueDepth(env).consumers === 1`, then the barrier: `publisher.publish(messages('c11b-barrier', SESSION_A).status(1))`, `b.logs.waitForLine` for its `delivery processed` line (matched on `deviceId`), then one wait for `b.inFlight === 0`
```

**Edit 2.10 — `docs/specs/2026-09-14-integration-tests-design.md`, the C11b row, the assert cell (the count of events included).**

Old:

```text
`b.received === 150` and no `delivery processed` line of `b` carries `redelivered: true` (the 150 were never delivered before; amended to `150 + n` on 2026-09-15 after the plan's probe measured the lost last acknowledgement, and back to the exact count the same day once the consumer closed the channel before the connection, `1f0a783`, T70); 200 distinct events, each once, and 20 alerts;
```

New:

```text
`b.received === 151 + n` and `b.acked === 151 + n`, where `n` is the number of `delivery processed` lines of `b` with `redelivered: true`, each `outcome: 'stale'` and `duplicate: true`, `n <= 50` (the 150 were never delivered before, the 151st is the barrier; `n` was 0 on this machine after `1f0a783` and 16 on the CI runner — T70: an acknowledgement sent right before the channel close is not always applied by the queue); 201 distinct events (the load's 200 and the barrier), each once, and 20 alerts;
```

**Edit 2.11 — `docs/specs/2026-09-14-integration-tests-design.md`, the C11b row, the end of the assert cell.**

Old:

```text
one that does not wait for its handlers as `a.abandoned > 0` and `b.received === 200` |
```

New:

```text
one that does not wait for its handlers as `a.abandoned > 0` (`b.received === 201` alone would also fit `n = 50`) |
```

**Edit 2.12 — `docs/specs/2026-09-14-integration-tests-design.md`, invariant row 2 (the line starting `| 2 Duplicates have no effect`).**

Old:

```text
C10 and C11b produce no redelivery in a correct run and assert the end state only (a lost acknowledgement in C10 would show as `acked > 200`, reported, not asserted)
```

New:

```text
C10 produces no redelivery in a correct run and asserts the end state only (a lost acknowledgement would show as `acked > 200`, reported, not asserted); C11b's redeliveries after a graceful stop (T70) must each be `duplicate` and `stale`
```

**Edit 2.13 — `docs/specs/2026-09-14-integration-tests-design.md`, invariant row 6 (the line starting `| 6 Both services scale horizontally`).**

Old:

```text
C11b (a stopped instance acknowledges exactly what it held and a second instance receives exactly the rest)
```

New:

```text
C11b (a stopped instance acknowledges exactly what it held and a second instance receives the rest plus at most the redeliveries of T70, each a stored duplicate)
```

**Edit 2.14 — `docs/specs/2026-09-14-integration-tests-design.md`, the concurrency row (the line starting `| Concurrency inside a scenario`).**

Old:

```text
C11b's 200 messages exist to leave an exact remainder, not to load.
```

New:

```text
C11b's 200 messages exist to leave a known remainder (150 plus the T70 redeliveries, then its barrier), not to load.
```

**Edit 2.15 — `TODO.md`, the step 7 paragraph (the line starting `Hotovo 2026-09-15 podle`).**

Old:

```text
Oprava T70 (`1f0a783`, `d1be9f9`): consumer při zastavení zavře kanál a počká na jeho close-ok před zavřením spojení, takže poslední potvrzení nezmizí; C11b znovu tvrdí přesný zbytek 150.
```

New:

```text
Oprava T70 (`1f0a783`): consumer při zastavení zavře kanál a počká na jeho close-ok před zavřením spojení. Doplněno 2026-09-15 po `/verify`: close-ok dokazuje jen to, že kanál potvrzení přijal, ne že je fronta použila — klient quorum fronty v RabbitMQ 4.3.5 odkládá potvrzení nad 32 čekajících příkazů a při zavření kanálu je už neodešle; na CI runneru (2 vCPU) se tak 16 z 50 zpráv doručilo znovu. Předání při graceful stop je tedy at-least-once: C11b tvrdí `b.received === 151 + n` (zbylých 150, jedna zpráva-bariéra a `n` znovu doručených) a každou znovu doručenou zprávu jako duplikát bez efektu (`duplicate`, `stale`); test nejprve počká, až zrušený consumer zastavené instance zmizí z mapy consumerů fronty (živý dotaz `checkQueue`: fronta ho drží, dokud vše, co držel, není potvrzeno nebo vráceno), a teprve pak pošle bariéru, která se doručí za vším, co fronta vrátila — zachytí tak i znovudoručení, které je ještě na cestě; T70 zůstává v seznamu kompromisů jako známý limit (`docs/plans/2026-09-15-ci-followup-plan.md`).
```

**Edit 2.16 — `docs/plans/2026-09-15-integration-tests-plan.md`, the header's deferral (1) (the line starting `> **Deferrals worth tracking:**`).**

Old:

```text
(1) T70 — closed the same day, after this header, by `1f0a783` (the channel's close-ok before the connection close, one shared close budget) and `d1be9f9` (C11b asserts the exact remainder again); the `150 + n` tolerance the review notes above describe is history.
```

New:

```text
(1) T70 — closed the same day, after this header, by `1f0a783` (the channel's close-ok before the connection close, one shared close budget) and `d1be9f9` (C11b asserted the exact remainder again), then reopened on 2026-09-15 after `/verify`: the CI runner redelivered 16 of the 50, the `150 + n` form is back (as `151 + n`, behind a consumer-count wait and a barrier message) with the mechanism recorded in the consistency spec (`docs/plans/2026-09-15-ci-followup-plan.md`).
```

**Edit 2.17 — `docs/specs/2026-09-14-integration-tests-design.md`, decision 13, the decision cell (the line starting `| 13  | Waiting, and what "processing has finished" means`).**

Old:

```text
**A queue count is never a completion signal**, and a threshold read while messages still move is `≥`, never `===` (I2: the count can pass the value between two polls).
```

New:

```text
**A queue count is never a completion signal**, and a threshold read while messages still move is `≥`, never `===` (I2: the count can pass the value between two polls). **Amended 2026-09-15** (C11b, after the reviews of the CI follow-up plan): where a redelivery adds only duplicates, the end state cannot see a duplicate and `inFlight` starts only when amqplib dispatches the delivery, so a delivery the broker has sent but the client has not dispatched is in neither. C11b's drain boundary therefore has two steps. (1) A queue-side requeue boundary: `checkQueue`'s consumer count must read 1, the next instance alone — `rabbit_fifo_client:stat` is a live `local_query` of `rabbit_fifo:query_stat`, `maps:size(Consumers)` (RabbitMQ 4.3.5); the queue keeps a consumer cancelled by `basic.cancel` in that map with `status = cancelled` until its checked-out set is empty (`maybe_return_all`, `update_or_remove_con`: "there are unsettled items so need to keep around") and removes it on the channel's DOWN after `return_all`, so a count of 1 means every delivery the stopped instance held was settled or returned, the returned ones now in `returns`, which the next checkout drains before `messages`. Neither close-ok is such a boundary: the reader forgets a channel at `channel_closing`, before the channel process exits (`rabbit_reader`, `channel_cleanup`), so `connection.close_ok` can precede the queue's DOWN. (2) A barrier message published after step 1 is dispatched after every returned delivery, and one channel dispatches in order, so the next instance's `delivery processed` line of the barrier, then `inFlight === 0`, is a dispatch boundary — not a completion signal (the sentinel rejected below stays rejected: handlers run concurrently, so the barrier's own processing proves nothing about the others; completion is still the end state plus `inFlight === 0`, read after the barrier). No queue counter serves: for a quorum queue, `rabbitmqctl list_queues` reads `messages_ready` and `messages_unacknowledged` from `queue_coarse_metrics`, written on the 5 s tick, a missing entry read as 0 (`rabbit_quorum_queue`, `i/2`, `handle_tick`), and `checkQueue`'s live `stat` carries no unacknowledged count. Stated for the one-node test broker.
```

- [ ] Apply Edits 2.1–2.17.
- [ ] `pnpm exec prettier --write docs/specs/2026-09-11-telemetry-consistency-design.md docs/specs/2026-09-13-processing-design.md docs/specs/2026-09-14-integration-tests-design.md TODO.md docs/plans/2026-09-15-integration-tests-plan.md`, then the verify line.
- [ ] Commit — subject: `Record the at-least-once handoff at a graceful stop`.

### Task 3: The ingest close-budget test tolerates an early timer [mechanical]

**Files:** Modify `apps/ingest/src/server.test.ts`
**Invariant:** none touched (a test bound). The test still proves that a closing connection is ended by the shutdown budget, not by the ping.
**Verify:** `pnpm --filter @telemetry/ingest test && pnpm --filter @telemetry/ingest typecheck && pnpm --filter @telemetry/ingest lint`, then twenty runs of the one test: `for i in $(seq 1 20); do pnpm exec vitest run --project unit apps/ingest/src/server.test.ts -t "never pings a closing connection" --reporter=dot > /dev/null 2>&1 || echo "run $i failed"; done` prints nothing.

- [ ] After the `BASE_CONFIG` constant (the block ending with `SHUTDOWN_TIMEOUT_MS: 200,` and `};`) add:

```text
/**
 * Slack for a lower bound measured across a timer: Node makes no guarantee about the exact timing
 * of a timer, and one measured by `performance.now()` can fire a fraction of a millisecond before
 * its delay (299.94 ms for a 300 ms budget on the CI runner, 2026-09-15).
 */
const TIMER_TOLERANCE_MS = 5;
```

- [ ] In the test `never pings a closing connection, so a device that stops answering after the close frame is ended by the budget, not as unresponsive`, replace the line

```text
    expect(performance.now() - started).toBeGreaterThanOrEqual(300);
```

with:

```text
    // The ping would have ended the connection at about 100 ms (two intervals); the budget did.
    expect(performance.now() - started).toBeGreaterThanOrEqual(300 - TIMER_TOLERANCE_MS);
```

- [ ] The verify line, then `pnpm exec prettier --check apps/ingest/src/server.test.ts`.
- [ ] Commit — subject: `Tolerate an early timer in the ingest close-budget test`.

### Task 4: The black-hole handshake test accepts a second attempt [mechanical]

**Files:** Modify `apps/emulator/src/connection.test.ts`
**Invariant:** none touched (a test assertion). The test still proves that a handshake that never completes is abandoned by the timeout and the connection reaches `backoff`.
**Verify:** `pnpm --filter @telemetry/emulator test && pnpm --filter @telemetry/emulator typecheck && pnpm --filter @telemetry/emulator lint`, then twenty runs of the one test: `for i in $(seq 1 20); do pnpm exec vitest run --project unit apps/emulator/src/connection.test.ts -t "abandons a handshake that never completes" --reporter=dot > /dev/null 2>&1 || echo "run $i failed"; done` prints nothing.

- [ ] In the test `abandons a handshake that never completes, instead of stalling forever`, replace:

```text
    const errors = lines().filter((line) => line.msg === 'device socket error');
    expect(errors.map((line) => (line.err as { message: string }).message)).toEqual([
      'Opening handshake has timed out',
    ]);
```

with:

```text
    // `backoff` is re-entered after every failed attempt, and Full Jitter can schedule the next
    // attempt almost at once (`backoffDelay`), so on a slow runner a second handshake can time out
    // before `vi.waitFor` polls (two lines on the CI runner, 2026-09-15). The first attempt is
    // the subject; every attempt must have ended the same way.
    const reasons = lines()
      .filter((line) => line.msg === 'device socket error')
      .map((line) => (line.err as { message: string }).message);
    expect(reasons.length).toBeGreaterThanOrEqual(1);
    expect(new Set(reasons)).toEqual(new Set(['Opening handshake has timed out']));
```

- [ ] The verify line, then `pnpm exec prettier --check apps/emulator/src/connection.test.ts`.
- [ ] Commit — subject: `Accept a second handshake timeout in the black-hole connection test`.

### Task 5: Full pre-flight, the user's push, one green CI run of the pushed commit [integration]

**Files:** none.
**Invariant:** none touched.
**Verify:** `pnpm format:check && pnpm lint && pnpm typecheck && pnpm test` → 952 passed in 49 files, nothing left in Docker; after the push, the CI workflow's push run whose `headSha` is the pushed commit ends with `gh run watch <id> --exit-status` → 0.

- [ ] Full pre-flight in the main checkout (Docker running).
- [ ] Ask the user to push (`git push origin main`); never push from the session.
- [ ] Select the run by the pushed commit, not by recency, and watch it:

```bash
SHA=$(git rev-parse HEAD)
git fetch origin main && [ "$(git rev-parse origin/main)" = "$SHA" ] && echo "origin/main is $SHA"
RUN=
for i in $(seq 1 24); do
  RUN=$(gh run list --workflow ci.yml --event push --branch main --limit 10 --json databaseId,headSha --jq ".[] | select(.headSha == \"$SHA\") | .databaseId" | head -1)
  [ -n "$RUN" ] && break
  node -e "setTimeout(() => {}, 5000)"
done
echo "run $RUN for $SHA"
gh run watch "$RUN" --exit-status
gh run view "$RUN" --json headSha,conclusion --jq '"\(.headSha) \(.conclusion)"'
```

The `echo` names a run id (empty after two minutes means GitHub has not created the run: stop and report), the watch exits 0, and the last line prints the full sha of the pushed commit and `success`. If the run fails on C11b or on either unit test again, stop and diagnose (Debugging rule); do not loosen an assertion further without a measured reason.

### Task 6: Record the green run [mechanical]

**Files:** Modify `TODO.md`, `docs/plans/2026-09-15-ci-followup-plan.md`
**Invariant:** none touched.
**Verify:** `pnpm format:check`; `git show --stat HEAD` lists exactly the two files.

- [ ] `TODO.md`, the step 7 paragraph: after the sentence ending `spouští format:check, lint, typecheck a `pnpm test` včetně integračních testů.` insert `Zelené od běhu <id> na commitu <sha> (2026-09-15, po opravě C11b a dvou nestabilních unit testů; `docs/plans/2026-09-15-ci-followup-plan.md`).` with the run id and the first seven characters of the sha that Task 5's last line printed.
- [ ] This plan: add the `STATUS: SHIPPED` header (commits, the CI run id and its full sha, plan-vs-reality corrections, review corrections) in the form of `docs/plans/2026-09-15-integration-tests-plan.md`.
- [ ] `pnpm exec prettier --write TODO.md docs/plans/2026-09-15-ci-followup-plan.md`, the verify line.
- [ ] Commit — subject: `Mark the CI follow-up plan shipped`. Ask the user to push again.

## Verification Criteria

| #   | Criterion                                                                                       | How to verify                                                                                                                                                                                                                                                                                                                                               |
| --- | ----------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | The CI failure is reproduced before the change                                                  | Task 1's mutant M1 against the current C11b: `acked 166 of 150` in the failure text                                                                                                                                                                                                                                                                         |
| 2   | The new C11b holds on the CI numbers                                                            | Task 1's mutant M1 against the new C11b: passes                                                                                                                                                                                                                                                                                                             |
| 3   | The previous boundary accepts a state with 16 pending redeliveries, and the new one waits on it | The gated run (M1 + M3, edits G1–G3): after `awaitAcked(b, 150)`, `ready 0`, `redelivered 0` and `consumers 2` hold while a's channel holds 16 unsettled deliveries                                                                                                                                                                                         |
| 4   | The boundary finds every one of them once the channel closes                                    | The same gated run: passes G3, `expect(n, detail).toBe(16)`, with every redelivered line `stale` + `duplicate`                                                                                                                                                                                                                                              |
| 5   | The new C11b still fails a stop that does not drain                                             | Task 1's mutant M2: fails at the `sa` assertion with `abandoned: 50`                                                                                                                                                                                                                                                                                        |
| 6   | The new C11b passes on the real consumer                                                        | Three green runs of `pnpm test:integration test/integration/processing-consumer.test.ts -t C11b`; `docker compose -f docker-compose.test.yml ps -aq \| wc -l` → 0 afterwards                                                                                                                                                                                |
| 7   | The main checkout never held a mutant or a variant                                              | `git status --porcelain apps/processing test/harness` empty before every commit; `git worktree list` shows one entry after Task 1; `grep -c "__closeGate" test/integration/processing-consumer.test.ts` → 0                                                                                                                                                 |
| 8   | The two unit tests pass twenty times in a row here                                              | Tasks 3 and 4, the loops print nothing                                                                                                                                                                                                                                                                                                                      |
| 9   | No spec, ledger or code comment still calls the handoff exact or T70 closed                     | `grep -rn "T70 closed\|asserts the exact remainder again\|přesný zbytek 150" docs/specs TODO.md docs/plans/2026-09-15-integration-tests-plan.md apps/processing/src/consumer.ts` prints nothing                                                                                                                                                             |
| 10  | No queue counter is used as a boundary anywhere in the tests                                    | `grep -rn "list_queues\|queueCounts" test` prints nothing, and `grep -rn "messages_unacknowledged" test \| grep -vE ':[[:space:]]*//'` prints nothing (the one mention is a comment)                                                                                                                                                                        |
| 11  | Full pre-flight green                                                                           | `pnpm format:check && pnpm lint && pnpm typecheck && pnpm test` → 952 passed, 49 files                                                                                                                                                                                                                                                                      |
| 12  | CI green on the pushed commit itself                                                            | Task 5: the selected run's `headSha` equals `git rev-parse HEAD` (full sha) and `gh run watch <id> --exit-status` → 0; Task 6 records that id                                                                                                                                                                                                               |
| 13  | The change alters no product behaviour                                                          | `git diff 932e809..HEAD --stat -- apps/*/src packages` lists only `apps/ingest/src/server.test.ts`, `apps/emulator/src/connection.test.ts` and `apps/processing/src/consumer.ts`; for the last one `git diff 932e809..HEAD -- apps/processing/src/consumer.ts \| grep -E '^[+-][^+-]' \| grep -vE '^[+-] *(\*\|/\*\*)'` prints nothing (comment lines only) |

## Test Plan

- Task 1 needs Docker: each run's global setup starts and removes the test stack (`docker-compose.test.yml`); the worktree's runs and the main checkout's runs are one at a time (one stack per machine, T63). No hand-started stack is needed.
- Task 2: the processing package's scoped verify (the comment edits), no Docker.
- Tasks 3 and 4: the per-package scoped verify, no Docker.
- Task 5: the full pre-flight (`pnpm format:check && pnpm lint && pnpm typecheck && pnpm test`), Docker running.
- Static, every task: `pnpm typecheck && pnpm lint && pnpm exec prettier --check <touched files>`.

## Checkpoint Recovery

If interrupted mid-implementation, resume by:

1. Read this plan.
2. `git log --oneline 932e809..HEAD` — the subjects above name the task each commit completes; `git status` shows a task in progress.
3. `git worktree list` — a leftover mutant worktree (Task 1; under the scratchpad of the session that created it) is removed with `git worktree remove --force <path> && git worktree prune`; `docker compose -f docker-compose.test.yml ps -aq` — a leftover stack is removed with `docker compose -f docker-compose.test.yml down -v`.
4. Pick up from the first task without a commit; re-run that task's verify line before writing anything.
