> **STATUS: SHIPPED 2026-09-13.** Landed as four commits: the plan `8931fc4`, then one commit per task — `7c1c57f` (Task 1), `2d49902` (Task 2) and `02d3c17` (Task 3). The unchecked `- [ ]` boxes below are historical; the work is done. **Do not re-execute this plan.** If you are changing the emulator, work directly in `apps/emulator/src/`.
>
> **Verification (2026-09-13, at `02d3c17`):** `pnpm lint && pnpm typecheck && pnpm test` passed with 25 test files and 489 tests; 104 of them are the emulator's, 4 of those new. Each regression test was red before its fix: `seq` 3604 received twice (Task 1), only `shutting down` logged (Task 2), and `vi.waitFor` timing out with one status received (Task 3). Criteria 6 and 8 against the built code:
>
> - 10 000 queued frames arrived as 10 000, with 0 duplicates.
> - With ingest unreachable, the process exited 1 011 and 1 016 ms after SIGTERM (budget 1 000 ms), after the loss warning, the summary and `stopped`.
> - After an outbox eviction of the start `status`, 20 statuses arrived in 20 heartbeat periods.
> - 2 devices at 200 ms gave 2 ids with 9–10 metrics each; 4 devices at 100 ms gave 4 ids with 18–19 metrics each.
>
> Criterion 9's search finds no stale heartbeat wording.
>
> **Plan-vs-reality corrections discovered during execution:**
>
> **Library/version drift:** none. Node 24.21.0, vitest 4.1.11, ESLint 10.10.0 and TypeScript 6.0.3 behaved as the Research section records.
>
> **Plan code prescriptions that needed adjustment:**
>
> - Task 1: the class comment of `DeviceConnection` said the outbox and the pump live in `DeviceClient`. It now names `pumpOutbox` in `device.ts`.
> - Task 1: the identity test now waits with `target.waitForLines(queued)` before `connection.stop()`. It asserts `written === seqs.length` instead of `written === queued`, and it has its own 20 s timeout (see the review corrections below).
> - Task 2: the harness collects the child's stderr, any stdout line that is not JSON, and a spawn error in one `diagnostics` string. The test also states `EMULATOR_SEED: '1'`.
> - Task 3: both new tests have their own 10 s timeout, because their 4 s waits left little of vitest's default 5 s.
>
> **Corrections applied during review:**
>
> - Plan review, round 1 (REVISE, 2 blocking): the plan gained the section "Concurrent work in this checkout" (edit in place, stop on a change this task did not make, commit named paths only). It also gained the inline `max-params` directive for the three-parameter resolve hook. Round 2 passed.
> - Task 1, test quality (blocking): the identity test relied on `stop()` winning its race against the hard-coded one-second `CLOSE_TIMEOUT_MS` destroy while the sink was still reading. It now waits for the lines first, and it failed again against the old `write()` contract.
> - Task 1, code review (suggestion applied): the failure table's "Connection loss" row now names the second loss path: frames the socket already took are lost when the connection breaks (T39). The row used to claim that only an outbox overflow loses messages.
> - Task 2, code review (2 blocking): the spawned child had no `'error'` listener, and `JSON.parse` in the stdout handler was unguarded. Both cases now write to `diagnostics`. Two wording fixes came with them: the texts now say that step 1 clears the tick, heartbeat and chaos timers, so only the unreferenced reconnect backoffs remain, and the spec's Research bullet names the experimental-flag trade-off.
> - Task 3, code review (suggestion applied): the refresh bound is one tick longer when `out-of-order` chaos holds the heartbeat's own `status`. The `#armHeartbeat()` comment and decision 26 now say so.
>
> **Deferrals worth tracking:**
>
> - The `'drain'` handler in `connection.ts` does not check that the event belongs to the active socket. This is not reachable today, because `write()` checks `socket.writable`. Fix it in a future pass over `connection.ts`.
> - `isWritable` exists in both `connection.test.ts` and `device.test.ts`. Extract it only when a third file needs it.
> - `main.test.ts`: if `shutting down` is never logged, `lines.slice(lines.findIndex(…))` becomes `slice(-1)`. The test still fails, but with a less direct diff. Also, `refusedPort()` leaves a small window in which another process could take the released port.
> - Three older tests in `device.test.ts` still pair a 4 s `vi.waitFor` with vitest's default 5 s test timeout.
> - Outside its three findings, the integration-correctness review noted that a lost `diagnostic` cannot be rebuilt from later messages. Decision 12 of the consistency spec still calls such a loss harmless in general. This plan did not change that sentence.
>
> **Plan history below is preserved as-written for context. Treat the live code as authoritative.**

# Emulator Delivery Fixes Implementation Plan

**Goal:** Fix the three emulator defects that the integration-correctness review reported and this plan reproduced. First, a frame that fills the socket buffer goes out twice. Second, the process can exit in the middle of its shutdown drain without reporting what it lost. Third, a lost `status` is never replaced while a device keeps sending metrics.

**Approach:** Three independent tasks. Each task covers one root cause and has a regression test on a real socket or a real process. Each task also updates the spec text that describes the corrected behaviour, and ends in one commit.

- Task 1 changes what `DeviceConnection.write()` reports, and moves the pump loop into a function that a real-socket test can drive.
- Task 2 keeps the drain's poll timer referenced and proves the fix in a child process.
- Task 3 re-arms the heartbeat only on a `status`. It amends decision 26 of the emulator spec and adds trade-off T40.

**Design spec:** `docs/specs/2026-09-12-emulator-design.md` (decisions 16, 20 and 26, and the `Fleet` drain). The consistency spec `docs/specs/2026-09-11-telemetry-consistency-design.md` stands above it: its decision 12 makes the loss argument, and decision 27 defines liveness. This plan writes no new design spec. The review's fix directions are specific, and each change is recorded as a dated amendment in the spec it touches.
**Review:** `.local/reviews/2026-09-13-integration-correctness.md` (gitignored), findings 1–3.
**TODO items:** no item changes state. Step 3 (`Emulátor zařízení`) stays ticked and gets a dated note. Step 4 is not touched.
**Branch:** `main`, direct, small atomic commits. No `Co-Authored-By`, no AI mention.
**Scope:** `apps/emulator/src/{connection,device,fleet,session}.ts` and their tests; the new files `apps/emulator/src/{main.test,test-source-hooks}.ts`; the emulator spec and the consistency spec; `.env.example`; `TODO.md`. Nothing in `apps/ingest`, `apps/processing` or `packages/shared` changes.

## Concurrent work in this checkout

Another agent is running `docs/plans/2026-09-13-ingest-plan.md` on `main` in this same checkout.

- **What it did while this plan was written:** the range `bed8a4a..0486273` (the commits since this session started) holds six commits, `4f05c2e` to `0486273`. `git diff --stat bed8a4a..0486273` shows that they changed only files in `apps/ingest`.
- **What it did earlier:** it edited the emulator spec and moved `backoff.ts` out of `apps/emulator` (`1080187`).
- **What it still has to do:** its Task 14 will edit `TODO.md` and the consistency spec's trade-off list. This plan edits both files too.

Three rules follow. Every task applies them.

1. **Edit in place.** Every edit is an exact-match replacement against the file as it is on disk at that moment. Never write a whole file back from an earlier read. If an anchor quoted in this plan is missing, re-read that section. If the other agent has changed the text this task replaces, stop and report; do not edit.
2. **Check before committing.** Before every commit, run `git status --short` and `git diff -- <task paths>`; both must show only this task's changes. If a path contains a change this task did not make, do not commit that path: stop and report it. Committing it would publish the other agent's unfinished edit under this task's subject.
3. **Commit named paths only.** Run `git add <new files>`, then `git commit -m "<subject>" -- <task paths>`. With paths given, `git commit` takes only those paths, so nothing another agent staged elsewhere enters the commit.

The two agents' edits to the consistency spec's trade-off list do not overlap. This plan adds T40 after the T38–T39 block. The ingest plan adds T26–T37 before that block. Both edits keep the list in order.

## Verification of the review's claims (2026-09-13, current checkout)

The review inspected the checkout at `2d3a3f3`. No emulator file changed after that commit: the last commits that touch `apps/emulator` are `1080187` and `c52412b`, both older, and every line the review cites still matches.

Each claim was reproduced before this plan was written. The checks ran against the compiled production modules (`pnpm typecheck` builds `dist/`). Each planned fix was then applied to a scratch copy of `dist/`, and the same checks ran again. The scripts are in `.local/research/2026-09-13-delivery-probe-*.mjs`.

| Finding                  | Reproduction                                                                                                                                            | Original build                                                                                                                            | Scratch copy with the planned fix                                                                                              |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| 1. Backpressure resends  | 10 000 queued metrics; a real TCP receiver paused, then resumed; production `DeviceConnection` and `Outbox`; the loop of `DeviceClient.pump()`          | 10 002 frames, 2 duplicates. The duplicated `seq` values are exactly the 2 stop points. First stop after 623 077 bytes on macOS loopback. | 10 000 frames, each exactly once, in order; 2 stops                                                                            |
| 1. Guard for the fix     | `dropConnection()`, then `write()` before `'close'` arrives                                                                                             | Refused (`false`); state still `connected`                                                                                                | Refused (`false`); state still `connected`                                                                                     |
| 2. Exit before the drain | The compiled `main.js` in its own process; 1 device; a refused port; SIGTERM once the device is in backoff; budget 1 000 ms                             | 3 of 3 runs exit 3–4 ms after SIGTERM with exit code 0. Only `shutting down` is logged.                                                   | Exit after 1 007 ms: `shutting down`, the loss warning (`remaining: 2`, `state: backoff`), the summary, `stopped`, exit code 0 |
| 3. No repair of `status` | Ingest down at start, so the outbox (max 5) evicts the session-start `status` (`…:1`); then ingest comes up; tick 20 ms, heartbeat 100 ms, 2 s observed | 122 messages: 99 healthy metrics and **0** statuses in 20 heartbeat periods                                                               | Tick 20 ms, heartbeat 200 ms, 1.5 s: 8 statuses, 200–201 ms apart, 9–10 metrics between each, no transition                    |

Verdict: all three findings are real, and all three are worth fixing.

- Finding 1 puts duplicate identities on the wire with chaos turned off, and `stats.written` no longer matches the traffic on the wire.
- Finding 2 breaks the documented shutdown (emulator spec, decision 20 and step 4 of the drain) in exactly the ingest-outage scenario a demo runs.
- Finding 3 contradicts the consistency spec's own loss argument (decision 12: "the next periodic message restores the truth"), which is part of the answer to the assignment's question about failure modes.

## Decisions made without asking (standing instruction: work autonomously, log every decision)

| #   | Decision                                                                                                                                                                                                                                                                  | Reasoning and rejected options                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| D1  | `DeviceConnection.write()` returns whether the socket **took** the frame. The frame that fills the buffer counts as taken, and backpressure is still recorded as `writable: false`. A socket that is destroyed or ending (`socket.writable === false`) refuses the frame. | Root cause: `socket.write()` returns `false` "after admitting chunk" (Node stream docs), and the pump read that `false` as a refusal. Checking `socket.writable` first keeps a frame written between `destroy()` and `'close'` in the outbox; without that check, the fix would lose that frame silently. This timing was measured, not only read in the docs: `socket.writable` is already `false` in that gap. On the scratch copy with the fix, `write()` right after `dropConnection()` returned `false` while the state was still `connected`, and the patched method can return `false` there only through that check. Rejected: **a three-way result** (`written` / `buffered` / `refused`), because the pump needs only "taken or not" and the state already records the buffered case; **shift before the write, push back on refusal**, because it reorders messages, which is why the pump peeks first. |
| D2  | The pump loop moves out of `DeviceClient.pump()` into `pumpOutbox(outbox, connection)` in `device.ts`. `pump()` keeps the statistics and the debug line.                                                                                                                  | The regression test must drive the production loop with a real `Outbox`, a real `DeviceConnection` and a real socket. Rejected: **testing through `DeviceClient` with generated traffic**, because backpressure needs about 620 KiB on macOS loopback (measured above), several seconds at the fastest tick, and more on Linux; **a copy of the loop inside the test**, because the test would then not cover the production loop.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| D3  | The drain's poll timer is no longer unreferenced. No other timer changes.                                                                                                                                                                                                 | Root cause: a pending promise does not keep Node running, and every other timer of a stopping fleet is unreferenced (the summary interval and each reconnect backoff). The budget already bounds the drain, so a referenced poll cannot keep the process alive for ever. Rejected: **a separate keep-alive timer** until the deadline, because it is a second timer for the same deadline; **referenced reconnect timers during shutdown**, because that puts a fleet concern into the connection.                                                                                                                                                                                                                                                                                                                                                                                                                 |
| D4  | The child-process test runs `node --experimental-transform-types --import ./test-source-hooks.ts ./main.ts`. The hook maps `.js` specifiers to `.ts` and `@telemetry/shared` to its sources, like the alias in `vitest.config.ts`.                                        | Measured: plain type stripping (the Node 24 default) rejects the parameter properties in `packages/shared/src/framing.ts` and `config.ts` with `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`. Rejected: **spawning `dist/main.js`**, because `pnpm test` builds nothing and the scoped verify runs tests before typecheck, so the test could run stale code; **adding `tsx`**, a new dependency for one test; **rewriting those classes in `packages/shared`**, which is outside this plan's scope. Trade-off: `--experimental-transform-types` is experimental in Node 24. If Node changes the flag, the child exits before its first log line and the test fails with the child's stderr; it never passes silently. Upgrade path: drop the parameter properties in `packages/shared`, then plain type stripping is enough.                                                                                                 |
| D5  | The heartbeat timer is re-armed only when a `status` is enqueued: at session start, on a transition, and by the heartbeat itself. The trade-off is recorded as T40.                                                                                                       | A `status` can be lost in three ways: evicted from a full outbox (ingest down, or a paused socket during a broker outage), written into a connection that broke (T39), or held by an ingest instance that crashed (T3). Decision 12's repair works for a section only if the device sends that section periodically. Rejected: **keeping the old rule** (re-arm on every enqueue), because a busy device then never repairs its `status`; **a fixed period independent of what was enqueued**, because it sends a redundant `status` right after every transition; **a `status` every Nth tick**, because it is a second mechanism next to the timer that the idle profile still needs; **a `status` after every reconnect**, because it misses an eviction behind a paused socket, where no reconnect happens.                                                                                                    |
| D6  | The child-process test covers the case where ingest stays down for the whole budget. It does not cover an outage that ends inside the budget.                                                                                                                             | The fixed defect is about what keeps the process alive, and this case shows it directly: before the fix the process lived 3 ms, after the fix it lives for the whole budget. The in-process fleet tests already prove that the drain delivers once a socket is writable. An unreferenced reconnect timer still fires while something else keeps the loop alive (Node timers docs). A second child test would need to listen again on a released port while the child runs, which adds a race for little extra proof.                                                                                                                                                                                                                                                                                                                                                                                               |
| D7  | One commit per task, and each commit carries its code, its tests and its spec text. The plan is committed first, and the `STATUS: SHIPPED` header is committed last together with the `TODO.md` note.                                                                     | This matches the repository's history (`Add the device emulator implementation plan`, then one commit per task, then `Mark … shipped`). Each fix can be read, and reverted, as one change.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |

## Research (source links)

The runtime is Node.js 24.21.0 (the pinned toolchain; `package.json` requires `>=24.10 <25`). The stream, net and timers passages were read on the current documentation. Their `Added in` versions (v0.1.90, v0.9.1, v0.9.4, v8.0.0, v11.4.0) and their History tables show no later change to the quoted behaviour, so v24.21.0 has it. The module and TypeScript pages were read in their v24 edition.

- [`socket.write(data[, encoding][, callback])`](https://nodejs.org/api/net.html#socketwritedata-encoding-callback): "Returns `true` if the entire data was flushed successfully to the kernel buffer. Returns `false` if all or part of the data was queued in user memory." Task 1.
- [`writable.write(chunk[, encoding][, callback])`](https://nodejs.org/api/stream.html#writablewritechunk-encoding-callback): "The return value is `true` if the internal buffer is less than the `highWaterMark` configured when the stream was created after admitting `chunk`." This is the basis of D1: a `false` return comes after the chunk was admitted. Task 1.
- [`writable.writable`](https://nodejs.org/api/stream.html#writablewritable): "Is `true` if it is safe to call `writable.write()`, which means the stream has not been destroyed, errored, or ended." Task 1.
- [`writable.destroy([error])`](https://nodejs.org/api/stream.html#writabledestroyerror): "After this call, the writable stream has ended and subsequent calls to `write()` or `end()` will result in an `ERR_STREAM_DESTROYED` error." `'close'` follows later, which creates the gap that D1's `socket.writable` check covers. Task 1.
- [`duplex.allowHalfOpen`](https://nodejs.org/api/stream.html#duplexallowhalfopen): "If `false` then the stream will automatically end the writable side when the readable side ends." A `net` socket defaults to `false`. So the test sink sends its FIN only after it has read everything, and the client's `'close'` comes after that. Task 1's final assertion depends on this order.
- [`timeout.unref()`](https://nodejs.org/api/timers.html#timeoutunref): "When called, the active `Timeout` object will not require the Node.js event loop to remain active. If there is no other activity keeping the event loop running, the process may exit before the `Timeout` object's callback is invoked." Task 2.
- [`module.registerHooks(options)`, v24](https://nodejs.org/docs/latest-v24.x/api/module.html#moduleregisterhooksoptions): added in v23.5.0 and v22.15.0, stability 1.2 (release candidate). A synchronous `resolve(specifier, context, nextResolve)` returns `{ url, format?, shortCircuit? }`, and `context.parentURL` is "the module importing this one". "Using `--import` or `--require` ensures that the hooks are registered before any application code is loaded, including the entry point of the application." `@types/node` 24.13.3 declares `registerHooks(options: RegisterHooksOptions): ModuleHooks` and `ResolveHookSync`. Task 2.
- [Node.js TypeScript support, v24](https://nodejs.org/docs/latest-v24.x/api/typescript.html): type stripping has been on by default since v23.6.0. Parameter properties, `enum` declarations, `namespace` with runtime code and import aliases need `--experimental-transform-types`. "File extensions are mandatory"; `tsconfig.json` is ignored; files under `node_modules` are refused. Measured this session: plain stripping fails on `packages/shared/src/framing.ts:15`, and `--experimental-transform-types` runs the emulator sources and prints one `ExperimentalWarning` on stderr. Task 2.
- [child process event `'close'`](https://nodejs.org/api/child_process.html#event-close) (added in v0.7.7): "The `'close'` event is emitted after a process has ended _and_ the stdio streams of a child process have been closed. This is distinct from the `'exit'` event". Task 2 waits for `'close'`, so the last log lines are read before the assertions run.
- [`child_process.spawn(command[, args][, options])`](https://nodejs.org/api/child_process.html#child_processspawncommand-args-options) (added in v0.1.90; its History table records no change to `env`): `env` is "Environment key-value pairs. **Default:** `process.env`", and the docs say to "Use `env` to specify environment variables that will be visible to the new process". A passed object replaces the parent's environment; it does not extend it. So the child in Task 2 sees exactly the four variables the test sets. Every other emulator variable has a default (`apps/emulator/src/config.ts`). Task 2.
- [ESLint: disable rules, comment descriptions](https://github.com/eslint/eslint/blob/main/docs/src/use/configure/rules.md#comment-descriptions) (ESLint 10.10.0 is pinned). A description "must come after the configuration and needs to be separated from the configuration by two or more consecutive `-` characters". The same page asks every disable comment to document its reason. It also prefers configuration files to comments "whenever possible". Here, though, a file-wide `max-params` override in `eslint.config.js` would cover more than the one signature Node fixes. Measured this session with ESLint 10.10.0: without the directive, `max-params` reports `Method 'resolve' has too many parameters (3)`; with it, lint passes. Task 2.
- [vitest `vi.waitFor`](https://github.com/vitest-dev/vitest/blob/main/docs/guide/recipes/wait-for.md) (vitest 4.1.11 is pinned): a thrown error queues another attempt, and "the first call that doesn't throw resolves the wait with whatever the callback returned". Task 3 reads the matched messages from the returned value.

## File Changes

| Action | Path                                                    | Purpose                                                                                                                                           |
| ------ | ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Modify | `apps/emulator/src/connection.ts`                       | `write()` reports whether the socket took the frame, and refuses a destroyed or ending socket (Task 1)                                            |
| Modify | `apps/emulator/src/device.ts`                           | `pumpOutbox()` extracted from `DeviceClient.pump()` (Task 1); the heartbeat is re-armed only by a `status` (Task 3)                               |
| Modify | `apps/emulator/src/connection.test.ts`                  | The backpressure contract test is rewritten; a new test for the refusal after `destroy()` (Task 1)                                                |
| Modify | `apps/emulator/src/device.test.ts`                      | Identity test across backpressure (Task 1); the status refresh and lost-`status` tests replace the "no heartbeat" test (Task 3)                   |
| Modify | `apps/emulator/src/fleet.ts`                            | The drain's poll timer stays referenced (Task 2)                                                                                                  |
| Create | `apps/emulator/src/test-source-hooks.ts`                | Resolve hooks, so a child `node` process runs the TypeScript sources (Task 2)                                                                     |
| Create | `apps/emulator/src/main.test.ts`                        | The child-process shutdown test (Task 2)                                                                                                          |
| Modify | `apps/emulator/src/session.ts`                          | The `heartbeat()` doc comment (Task 3)                                                                                                            |
| Modify | `docs/specs/2026-09-12-emulator-design.md`              | Decisions 16 and 26, the pump ownership text, why the drain keeps the process alive, the tests table, research links, T40, Amendments (Tasks 1–3) |
| Modify | `docs/specs/2026-09-11-telemetry-consistency-design.md` | The device cadence bullet, a pointer in decision 12, the T40 row (Task 3)                                                                         |
| Modify | `.env.example`                                          | The `EMULATOR_HEARTBEAT_MS` comment (Task 3)                                                                                                      |
| Modify | `TODO.md`, this plan                                    | A dated note under step 3 and the `STATUS: SHIPPED` header (`/implement` Phase 6)                                                                 |

## Tasks

### Task 1: Take the frame that fills the socket buffer exactly once [integration]

**Root cause:** `DeviceConnection.write()` returns the value of `socket.write()` (`connection.ts:103-112`). A `false` there means the frame was admitted into the socket's user-space buffer. `DeviceClient.pump()` (`device.ts:136-146`) removes an entry only on `true`. So the admitted frame stays at the head of the outbox, and the pump after `'drain'` writes it a second time.
**Files:** Modify `apps/emulator/src/connection.ts`, `apps/emulator/src/device.ts`, `apps/emulator/src/connection.test.ts`, `apps/emulator/src/device.test.ts`, `docs/specs/2026-09-12-emulator-design.md`.
**Invariant:** Invariant 2 (duplicates have no effect) is enforced downstream; this task removes a duplicate source the design never intended. The precondition of invariant 1 — the emulator itself never reorders — is kept, because the pump still peeks before it removes. Proof: `pumpOutbox › writes every queued message exactly once and in order across backpressure`.
**Verify:** `pnpm --filter @telemetry/emulator test && pnpm --filter @telemetry/emulator typecheck && pnpm --filter @telemetry/emulator lint`

- [ ] **Step 1 — extract the loop, no behaviour change.** In `device.ts`, change the outbox import to `import { Outbox, type OutboxEntry } from './outbox.js';`, add this function above the `DeviceClient` class, and replace the body of `pump()`:

```ts
/**
 * Writes the outbox into the connection, oldest entry first, while the connection takes frames.
 * Returns the entries it wrote, in order.
 *
 * Peek, write, and remove only what the connection took. Shifting first and pushing back on a
 * refused write would put the entry behind anything enqueued in between — the emulator would become
 * the source of the reordering the tests attribute to the broker. Removing on `true` is exact
 * because `write()` counts the frame that filled the socket's buffer as taken; the first version
 * counted it as refused, kept it at the head and wrote it a second time after `'drain'`.
 */
export function pumpOutbox(outbox: Outbox, connection: DeviceConnection): OutboxEntry[] {
  const written: OutboxEntry[] = [];
  for (let entry = outbox.peek(); entry !== null; entry = outbox.peek()) {
    if (!connection.write(entry.frame)) break;
    outbox.shift();
    written.push(entry);
  }
  return written;
}
```

```ts
  /** Drains the outbox into the socket as far as backpressure allows. Synchronous. */
  pump(): void {
    for (const entry of pumpOutbox(this.#outbox, this.#connection)) {
      this.#stats.written += 1;
      messageLogger(this.#logger, entry.message).debug('telemetry message written');
    }
  }
```

Run the verify command: every existing test passes, because the loop is the same loop.

- [ ] **Step 2 — the failing identity test.** In `device.test.ts`, import `DeviceConnection` from `./connection.js`, `pumpOutbox` next to `DeviceClient`, and `Outbox` from `./outbox.js`. The `open` object and `afterEach` become:

```ts
const open: { sinks: TestSink[]; clients: DeviceClient[]; connections: DeviceConnection[] } = {
  sinks: [],
  clients: [],
  connections: [],
};
```

```ts
afterEach(async () => {
  await Promise.all(open.clients.map((created) => created.stop()));
  await Promise.all(open.connections.map((created) => created.stop()));
  await Promise.all(open.sinks.map((created) => created.close()));
  open.clients.length = 0;
  open.connections.length = 0;
  open.sinks.length = 0;
});
```

Add the helpers and a new `describe` block at the end of the file:

```ts
/** Messages queued per round while the test fills the socket; the cap only stops a runaway. */
const BATCH = 1_000;
const MAX_QUEUED = 200_000;

function metricsMessage(seq: number): TelemetryMessage {
  return {
    v: 1,
    deviceId: 'dev-0001',
    sessionId: 1_700_000_000_000,
    seq,
    occurredAt: 1_700_000_000_000,
    type: 'metrics',
    payload: { temperatureC: 40, cpuPercent: 10, ramPercent: 50 },
  };
}

function isWritable(connection: DeviceConnection): boolean {
  const state = connection.state;
  return state.name === 'connected' && state.writable;
}

describe('pumpOutbox', () => {
  it('writes every queued message exactly once and in order across backpressure', async () => {
    // A real socket, because backpressure is the scenario. `socket.write()` returns false for a
    // frame it has already queued; the first pump read that as a refusal, kept the frame at the
    // head of the outbox and wrote it again after 'drain' — one duplicate identity on the wire
    // per backpressure stop, with chaos off.
    const target = await sink();
    // A connection accepted while the sink is paused starts paused, so nothing drains yet.
    target.pauseConnections();
    const outbox = new Outbox(MAX_QUEUED + BATCH);
    let written = 0;
    const connection = new DeviceConnection({
      deviceId: 'dev-0001',
      hosts: [{ host: '127.0.0.1', port: target.port }],
      random: createRandom(3),
      logger: silentLogger(),
      onWritable: () => {
        written += pumpOutbox(outbox, connection).length;
      },
    });
    open.connections.push(connection);
    connection.start();
    await vi.waitFor(() => {
      expect(connection.isConnected).toBe(true);
    });

    // Queue and pump until the socket pushes back. How many bytes that takes is up to the kernel
    // — about 620 KiB on macOS loopback — so the loop watches for backpressure, not a count.
    let queued = 0;
    const enqueue = () => {
      for (let i = 0; i < BATCH; i += 1) {
        queued += 1;
        outbox.push(metricsMessage(queued));
      }
    };
    while (isWritable(connection) && queued < MAX_QUEUED) {
      enqueue();
      written += pumpOutbox(outbox, connection).length;
    }
    expect(isWritable(connection)).toBe(false);
    // A backlog behind the stop, so the drain after the resume runs the pump again.
    enqueue();

    target.resumeConnections();
    await vi.waitFor(
      () => {
        expect(outbox.length).toBe(0);
        expect(isWritable(connection)).toBe(true);
      },
      { timeout: 10_000 },
    );
    // `stop()` ends the socket and resolves on 'close', which needs the sink's own FIN — and the
    // sink sends that only after it has read every byte, so every line is in when this returns.
    await connection.stop();

    const seqs = target.lines().map((line) => (JSON.parse(line) as TelemetryMessage).seq);
    expect(seqs).toEqual(Array.from({ length: queued }, (_unused, index) => index + 1));
    expect(written).toBe(queued);
  });
});
```

Run the verify command: this test fails, and the received `seq` list contains repeated values at the stop points.

- [ ] **Step 3 — the failing contract test.** In `connection.test.ts`, add the same `isWritable` helper and replace the test `reports backpressure and resumes writing after the peer reads again` with:

```ts
it('takes the frame that fills the buffer, then refuses frames until the peer reads again', async () => {
  // The one thing worth testing here, and the reason these tests use a real socket at all: a
  // mocked socket would only test the mock's idea of when `write()` returns false.
  const target = await sink();
  let writable = false;
  const connection = connect(target.port, () => {
    writable = true;
  });
  connection.start();
  await vi.waitFor(() => {
    expect(connection.isConnected).toBe(true);
  });

  target.pauseConnections();

  // Write until the kernel and the socket's own buffer are full. 64 KiB at a time so this ends
  // quickly; the cap stops a runaway if backpressure never appears. Every frame up to and
  // including the one that fills the buffer is taken: that frame is queued, and reporting it
  // as refused would make the pump write it again after 'drain'.
  const chunk = Buffer.alloc(64 * 1024, 0x61);
  let taken = 0;
  while (isWritable(connection) && taken < 500) {
    expect(connection.write(chunk)).toBe(true);
    taken += 1;
  }
  expect(isWritable(connection)).toBe(false);
  // The next frame is refused rather than queued behind the backlog.
  expect(connection.write(chunk)).toBe(false);

  writable = false;
  target.resumeConnections();

  // `'drain'` must fire and re-open the pump; without it the device would stay stuck forever.
  await vi.waitFor(
    () => {
      expect(writable).toBe(true);
    },
    { timeout: 5_000 },
  );
  expect(isWritable(connection)).toBe(true);
});
```

Run the verify command: this test fails at the write that fills the buffer, which returns `false`.

- [ ] **Step 4 — the guard test.** Add to `connection.test.ts`:

```ts
it('refuses a frame once its socket is destroyed, before the close event arrives', async () => {
  // `dropConnection()` destroys the socket at once, but the move to backoff waits for 'close',
  // which Node emits later. A frame written in that gap is discarded with ERR_STREAM_DESTROYED,
  // so it must be reported as not taken and stay in the outbox for the next connection.
  const target = await sink();
  const connection = connect(target.port);
  connection.start();
  await vi.waitFor(() => {
    expect(connection.isConnected).toBe(true);
  });

  connection.dropConnection();

  // Still inside the gap; otherwise the refusal below would come from the state check.
  expect(connection.state.name).toBe('connected');
  expect(connection.write(frame(1))).toBe(false);
});
```

It passes on the current code, because today `socket.write()` returns `false` there. It pins the half of the contract that Step 5 must keep: a fix that returned `true` after every `socket.write()` would fail it.

- [ ] **Step 5 — the fix.** Replace `write()` in `connection.ts`:

```ts
  /**
   * Whether the socket took the frame.
   *
   * `true` means the frame is on its way and must not be written again — including the frame that
   * filled the socket's buffer: `socket.write()` returns `false` once the buffer reaches its
   * high-water mark "after admitting chunk" (Node stream docs), so that frame is queued, not
   * refused. That case records `writable: false`, and the next call returns `false` until `'drain'`.
   *
   * `false` means the frame was not taken and stays queued: no connected socket, backpressure
   * already recorded, or a socket that is destroyed or ending. The last case is the gap between
   * `destroy()` — a chaos drop, a reset — and the `'close'` event that moves this connection to
   * backoff; a write there raises `ERR_STREAM_DESTROYED` and its bytes go nowhere.
   */
  write(frame: Buffer): boolean {
    const state = this.#state;
    if (state.name !== 'connected' || !state.writable || !state.socket.writable) return false;
    if (!state.socket.write(frame)) {
      // Queued in user memory; `'drain'` will call onWritable when the buffer is free again.
      this.#state = { ...state, writable: false };
    }
    return true;
  }
```

Run the verify command: every test passes.

- [ ] **Step 6 — the spec.** In `docs/specs/2026-09-12-emulator-design.md`:
  - Decision 16, decision cell: replace ``A single `flush()` pump drains it while `socket.write()` returns `true`; on `false` it stops and resumes on `'drain'`.`` with ``A single pump writes the oldest entry while the connection takes frames, removes each frame it took exactly once, and stops at the first frame it does not take; `'drain'` resumes it. The frame that fills the socket buffer counts as taken: `socket.write()` returns `false` only after admitting it.``
  - Decision 16, reasoning cell: after `…the source of reordering the tests attribute to the broker.` add `` Amended 2026-09-13 (integration-correctness review): the first pump treated that `false` as a refusal, kept the frame at the head of the outbox and wrote it again after `'drain'` — one duplicate identity per backpressure stop.``
  - Research: after the paragraph that starts `These three links point at`, add the line `Added on 2026-09-13 for the delivery fixes (docs/plans/2026-09-13-emulator-delivery-fixes-plan.md records where each passage was read):` and under it the `writable.write`, `writable.writable` and `writable.destroy` bullets from this plan's Research section. That paragraph speaks of exactly three links, so the new bullets must not go into its list.
  - State table: the row event ``​`write()` returned `false`​`` becomes ``​`socket.write()` returned `false`​``.
  - "Ownership of the pump": replace the two sentences from ``​`DeviceConnection` therefore exposes`` to ``wait for `onWritable`.`` with: ``​`DeviceConnection` therefore exposes only `write(frame): boolean` and an `onWritable` callback it invokes on `'connect'` and on `'drain'`. `write` reports whether the socket took the frame: `true` also for the frame that fills the buffer, which records `writable: false`; `false` when there is no connected socket, backpressure is already recorded, or the socket is destroyed or ending (the gap between `destroy()` and `'close'`). The pump is `pumpOutbox(outbox, connection)` in `device.ts`: peek the oldest entry, write it, remove it when it was taken, and stop at the first frame that was not; `DeviceClient.pump()` calls it and counts what it wrote.``
  - Module table: the `connection.ts` responsibility ends with `backoff, and write(), which reports whether the socket took a frame` instead of `backoff, the write pump`; the `device.ts` row adds `; pumpOutbox(), the write loop`.
  - Tests table: the `connection.test.ts` row adds ``; the frame that fills the socket buffer is reported as taken and the next frame is refused until `'drain'`; a frame written after `destroy()` and before `'close'` is refused``; the `device.test.ts` row adds ``; `pumpOutbox` writes every queued message exactly once and in order across a real backpressure stop``.
  - A new last section `## Amendments` with the line `2026-09-13, after the integration-correctness review (docs/plans/2026-09-13-emulator-delivery-fixes-plan.md):` and the bullet ``- **Decision 16 and the pump.** `DeviceConnection.write()` counts the frame that fills the socket buffer as taken, and refuses a destroyed or ending socket; the loop moved into `pumpOutbox()`. Before, that frame was written twice.``
  - Run `pnpm exec prettier --write docs/specs/2026-09-12-emulator-design.md`.

- [ ] **Step 7 — review and commit.** Scoped verify, then Stage 1 and Stage 2 reviews. Commit the five files: `Take the frame that fills the socket buffer exactly once`.

### Task 2: Keep the emulator alive until its shutdown drain settles [integration]

**Root cause:** `Fleet.#drain()` polls with `setTimeout(check, DRAIN_POLL_MS).unref()` (`fleet.ts:127`), and `DeviceConnection` unreferences every reconnect timer (`connection.ts:273`). By then `stopGenerating()` has cleared the referenced tick, heartbeat and chaos timers. With every device in backoff and no socket open, no referenced handle is left. A pending promise does not keep Node running, so the event loop empties and the process exits with code 0 before step 4 of the drain logs anything. Inside vitest the runner's own handles keep the worker alive. That is why `fleet.test.ts › gives up inside the budget and warns when a device cannot deliver` passes.
**Files:** Modify `apps/emulator/src/fleet.ts`, `docs/specs/2026-09-12-emulator-design.md`; create `apps/emulator/src/test-source-hooks.ts`, `apps/emulator/src/main.test.ts`. `eslint.config.js` does not change. The hook's three parameters break `max-params: 2`, but Node fixes that signature. So the one exception is an inline directive that states its reason.
**Invariant:** None of the six is touched. The documented shutdown is: emulator spec, decision 20, and step 4 of the drain. Proof: `emulator process › reports what it could not deliver before it exits, when ingest stays unreachable`.
**Verify:** `pnpm --filter @telemetry/emulator test && pnpm --filter @telemetry/emulator typecheck && pnpm --filter @telemetry/emulator lint`

- [ ] **Step 1 — the hooks module.** Create `apps/emulator/src/test-source-hooks.ts`:

```ts
import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';

/**
 * Lets a child `node` process run the emulator from its TypeScript sources, the way vitest runs
 * them, for the tests that need a process of their own (`main.test.ts`). Loaded with `--import`.
 *
 * Node runs `.ts` files itself but resolves specifiers literally: it does not map the `.js` in
 * `import './config.js'` to `config.ts`, and `@telemetry/shared` would resolve to the package's
 * built `dist/`, which may be stale or missing. The two rules below close that gap; the second is
 * the alias in `vitest.config.ts`. The child also needs `--experimental-transform-types`: the
 * shared package declares parameter properties (`FrameTooLongError`, `ConfigError`), which plain
 * type stripping rejects.
 *
 * Not named `*.test.ts`: the unit project collects those, and a module with no `test()` call would
 * be reported as an empty suite.
 */
const SHARED_SOURCE = new URL('../../../packages/shared/src/index.ts', import.meta.url).href;

registerHooks({
  // eslint-disable-next-line max-params -- Node calls a resolve hook with exactly these three positional arguments
  resolve(specifier, context, nextResolve) {
    if (specifier === '@telemetry/shared') {
      return nextResolve(SHARED_SOURCE, context);
    }
    const parent = context.parentURL;
    if (
      parent?.endsWith('.ts') === true &&
      specifier.startsWith('.') &&
      specifier.endsWith('.js')
    ) {
      const source = new URL(`${specifier.slice(0, -'.js'.length)}.ts`, parent);
      if (existsSync(fileURLToPath(source))) {
        return nextResolve(source.href, context);
      }
    }
    return nextResolve(specifier, context);
  },
});
```

- [ ] **Step 2 — the failing process test.** Create `apps/emulator/src/main.test.ts`:

```ts
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { startTestSink } from './test-sink.js';

const MAIN = fileURLToPath(new URL('./main.ts', import.meta.url));
const SOURCE_HOOKS = fileURLToPath(new URL('./test-source-hooks.ts', import.meta.url));

/** Short, so the test is quick, and still far above the 3 ms the unfixed process lived. */
const SHUTDOWN_BUDGET_MS = 500;
const LOSS_WARNING = 'shutdown timed out with messages still queued';
/** A shutdown that could not deliver: drain step 4, the final summary, the lifecycle's last line. */
const SHUTDOWN_LINES = ['shutting down', LOSS_WARNING, 'emulator fleet summary', 'stopped'];

type LogLine = { msg: string; [field: string]: unknown };
type Exit = { code: number | null; signal: NodeJS.Signals | null };

type EmulatorProcess = {
  /** Every JSON line the child wrote to stdout, in order. */
  lines: () => LogLine[];
  /** Resolves once a line with this `msg` arrives; rejects with the child's stderr if it ends first. */
  waitForLog: (msg: string) => Promise<void>;
  /** Resolves on 'close': the process has ended and its stdout has been read to the end. */
  closed: Promise<Exit>;
  kill: (signal: NodeJS.Signals) => void;
};

const children: ChildProcess[] = [];

function startEmulator(env: Record<string, string>): EmulatorProcess {
  // The real entry point, from its sources (see `test-source-hooks.ts` for the flag). A passed
  // `env` replaces the parent's environment (Node child_process docs), so the child sees only the
  // variables set here, nothing from the test runner; every other one has a default.
  const child = spawn(
    process.execPath,
    ['--experimental-transform-types', '--import', SOURCE_HOOKS, MAIN],
    { env, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  children.push(child);

  const lines: LogLine[] = [];
  const listeners = new Set<() => void>();
  let pending = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    pending += chunk;
    let index = pending.indexOf('\n');
    while (index !== -1) {
      lines.push(JSON.parse(pending.slice(0, index)) as LogLine);
      pending = pending.slice(index + 1);
      index = pending.indexOf('\n');
    }
    for (const listener of [...listeners]) listener();
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk;
  });
  // 'close', not 'exit': 'exit' can fire while stdout still holds the last lines.
  const closed = new Promise<Exit>((resolve) => {
    child.once('close', (code, signal) => resolve({ code, signal }));
  });

  return {
    lines: () => [...lines],
    waitForLog: (msg) =>
      new Promise<void>((resolve, reject) => {
        const check = () => {
          if (lines.some((line) => line.msg === msg)) {
            listeners.delete(check);
            resolve();
          }
        };
        listeners.add(check);
        check();
        void closed.then(({ code }) => {
          if (listeners.delete(check)) {
            reject(
              new Error(
                `the emulator ended (code ${String(code)}) before logging "${msg}":\n${stderr}`,
              ),
            );
          }
        });
      }),
    closed,
    kill: (signal) => {
      child.kill(signal);
    },
  };
}

/** A port that refuses connections: bound by a sink, then released. */
async function refusedPort(): Promise<number> {
  const temporary = await startTestSink();
  await temporary.close();
  return temporary.port;
}

afterEach(() => {
  // A test that fails before its child ends must not leave an emulator running.
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
  children.length = 0;
});

describe('emulator process', () => {
  it('reports what it could not deliver before it exits, when ingest stays unreachable', async () => {
    // A separate process on purpose. The defect was about what keeps Node running, and inside
    // vitest the runner's own handles keep a worker alive, so the in-process fleet test passed
    // while a real emulator exited 3 ms after SIGTERM: no loss warning, no summary, exit code 0.
    const port = await refusedPort();
    const emulator = startEmulator({
      INGEST_HOSTS: `127.0.0.1:${String(port)}`,
      EMULATOR_DEVICE_COUNT: '1',
      SHUTDOWN_TIMEOUT_MS: String(SHUTDOWN_BUDGET_MS),
      LOG_LEVEL: 'info',
    });
    // Every connect is refused, so from here the device waits in backoff: no socket is open, and
    // its only timer is the unreferenced reconnect timer.
    await emulator.waitForLog('device socket closed, reconnecting');

    const signalledAt = performance.now();
    emulator.kill('SIGTERM');
    const exit = await emulator.closed;
    const lifetimeMs = performance.now() - signalledAt;

    const lines = emulator.lines();
    const afterSignal = lines.slice(lines.findIndex((line) => line.msg === 'shutting down'));
    expect(
      afterSignal.map((line) => line.msg).filter((msg) => SHUTDOWN_LINES.includes(msg)),
    ).toEqual(SHUTDOWN_LINES);
    // The warning names the device and what it still held: at least the session-start status and
    // the farewell.
    const warning = lines.find((line) => line.msg === LOSS_WARNING);
    expect(warning).toMatchObject({ deviceId: 'dev-0001' });
    expect(warning?.remaining).toBeGreaterThanOrEqual(2);
    expect(lifetimeMs).toBeGreaterThanOrEqual(SHUTDOWN_BUDGET_MS);
    expect(exit).toEqual({ code: 0, signal: null });
  }, 15_000);
});
```

Run the verify command: this test fails. The shutdown lines are only `['shutting down']`, and the process lives a few milliseconds. If the child cannot start at all, `waitForLog` rejects with its stderr. That is a harness failure, not the red state, and it must be fixed before Step 3.

- [ ] **Step 3 — the fix.** In `fleet.ts`, in `#drain()`, replace `setTimeout(check, DRAIN_POLL_MS).unref();` with `setTimeout(check, DRAIN_POLL_MS);`, and append this paragraph to the method's doc comment:

```ts
   *
   * The poll timer is the one timer here that stays referenced, on purpose. A pending promise does
   * not keep Node running, and every other timer of a stopping fleet is unreferenced: the summary
   * interval and each device's reconnect backoff. With every device in backoff and no socket open,
   * an unreferenced poll let the process exit in the middle of the drain — no loss warning, no
   * summary, exit code 0. The budget bounds how long this timer keeps the process up.
```

Run the verify command: every test passes.

- [ ] **Step 4 — the spec.** In `docs/specs/2026-09-12-emulator-design.md`:
  - After the paragraph that starts `Step 4 exists because the drain is **best-effort, not guaranteed**`, add: `**What keeps the process alive during the drain.** The drain is a promise, and a pending promise does not keep Node running. Every other timer of a stopping fleet is unreferenced — the summary interval and each device's reconnect backoff — so with every device in backoff and no socket open, the process would exit in the middle of step 3 with none of step 4's warnings. Measured before this rule: exit 3 ms after SIGTERM, exit code 0. The drain's poll timer is therefore the one referenced timer, and the budget bounds how long it keeps the process up (amended 2026-09-13).`
  - Failure table, row `Emulator stopped while a device is disconnected`: `Best-effort: the drain waits` becomes `Best-effort: the process stays up while the drain waits`.
  - Tests table: after the `fleet.test.ts` row add ``| `main.test.ts` | A real child process of the emulator from its sources (`node --experimental-transform-types --import ./test-source-hooks.ts`), because inside vitest the runner's handles keep a worker alive: with every connect refused, SIGTERM leads to the step-4 warning with the device id, the summary and `stopped`, no earlier than `SHUTDOWN_TIMEOUT_MS` after the signal, and exit code 0 |``.
  - Research: add the `timeout.unref()`, `module.registerHooks`, Node TypeScript, `child_process.spawn` `options.env` and child-process `'close'` bullets from this plan's Research section to the bullets Task 1 added under `Added on 2026-09-13 for the delivery fixes`.
  - `## Amendments`: add `- **The drain keeps the process alive.** Its poll timer is referenced; before, a fleet whose devices were all in backoff exited in the middle of the drain without logging what it lost.`
  - Run `pnpm exec prettier --write docs/specs/2026-09-12-emulator-design.md`.

- [ ] **Step 5 — review and commit.** Scoped verify, then Stage 1 and Stage 2 reviews. Commit the four files: `Keep the emulator alive until its shutdown drain settles`.

### Task 3: Refresh the device status even while metrics keep flowing [integration]

**Root cause:** `DeviceClient.#push()` calls `#armHeartbeat()` after every non-empty push (`device.ts:180`), and `#armHeartbeat()` clears the timer and starts it again (`device.ts:188-196`). With a tick shorter than `EMULATOR_HEARTBEAT_MS` (the default is 1 s against 30 s), every tick restarts the timer, so it never fires. A `status` then goes out only at session start, on a transition and as the farewell, and a lost one is never replaced while the device stays healthy. This contradicts decision 12 of the consistency spec ("the next periodic message restores the truth"). The first rule was deliberate (emulator spec, decision 26), so this task changes the design, not only the code.
**Files:** Modify `apps/emulator/src/device.ts`, `apps/emulator/src/session.ts`, `apps/emulator/src/device.test.ts`, `docs/specs/2026-09-12-emulator-design.md`, `docs/specs/2026-09-11-telemetry-consistency-design.md`, `.env.example`.
**Invariant:** Invariant 1. The replacement `status` carries the current state under a new, greater order key, so it never overwrites newer state, and the stored `status` converges after a loss. Proof: `DeviceClient › replaces a lost status during continuous metrics traffic, without a state transition`.
**Verify:** `pnpm --filter @telemetry/emulator test && pnpm --filter @telemetry/emulator typecheck && pnpm --filter @telemetry/emulator lint`

- [ ] **Step 1 — the failing tests.** In `device.test.ts`, replace the test `sends no heartbeat while ticks keep re-arming the timer` with these two:

```ts
it('replaces a lost status during continuous metrics traffic, without a state transition', async () => {
  // Device-to-ingest loss is accepted by design (consistency spec, decision 12), and the device
  // cannot see it: there is no acknowledgement. So a status dropped at the receiver is, from the
  // device's side, the same event as an outbox eviction or a frame written into a broken
  // connection. The replacement must still come while the device keeps sending healthy metrics
  // on every tick — the profile in which the first heartbeat rule never fired.
  const target = await sink();
  const device = client(
    configFor(target.port, { EMULATOR_EVENT_INTERVAL_MS: '20', EMULATOR_HEARTBEAT_MS: '200' }),
    5,
  );
  device.start();

  const { lost, replacement, between } = await vi.waitFor(
    () => {
      const messages = parse(target.lines());
      const [first, second] = messages.filter((m) => m.type === 'status');
      if (first === undefined || second === undefined) throw new Error('no replacement yet');
      return {
        lost: first,
        replacement: second,
        between: messages.filter((m) => m.seq > first.seq && m.seq < second.seq),
      };
    },
    { timeout: 4_000 },
  );

  // The session-start status is the one treated as lost.
  expect(lost).toMatchObject({ seq: 1, payload: { state: 'online' } });
  // The replacement carries the same state: a refresh, not a transition.
  expect(replacement.payload).toEqual({ state: 'online' });
  // It arrived while metrics kept flowing, and none of them crossed a degraded threshold.
  const readings = between.filter((m) => m.type === 'metrics');
  expect(readings.length).toBeGreaterThanOrEqual(5);
  expect(readings.every((m) => m.payload.cpuPercent <= 90 && m.payload.temperatureC <= 75)).toBe(
    true,
  );
});

it('sends one status per heartbeat interval while ticks keep flowing, never more', async () => {
  // Other traffic must not suppress the refresh, and nothing may multiply it: a timer armed
  // again without clearing the previous one would put several statuses into one interval.
  const target = await sink();
  const device = client(
    configFor(target.port, { EMULATOR_EVENT_INTERVAL_MS: '20', EMULATOR_HEARTBEAT_MS: '100' }),
    5,
  );
  device.start();

  const statuses = await vi.waitFor(
    () => {
      const found = parse(target.lines()).filter((m) => m.type === 'status');
      if (found.length < 5) throw new Error(`only ${String(found.length)} statuses so far`);
      return found;
    },
    { timeout: 4_000 },
  );

  // No transition happened, so every gap below is the refresh timer's own.
  expect(statuses.every((status) => status.payload.state === 'online')).toBe(true);
  const times = statuses.map((status) => status.occurredAt);
  // `?? time` turns a missing neighbour into a zero gap, which fails the check instead of hiding.
  const gaps = times.slice(1).map((time, index) => time - (times[index] ?? time));
  // A timer never fires early by more than the event loop's clock granularity, so a gap far
  // under the interval can only come from a second timer.
  expect(Math.min(...gaps)).toBeGreaterThanOrEqual(80);
});
```

In the test `queues nothing after the farewell, however long the drain takes`, the comment sentence ``​`prepareShutdown` enqueues, and every enqueue re-arms the heartbeat timer`` becomes ``​`prepareShutdown` enqueues the farewell, which is a status, and every status re-arms the heartbeat timer``. Run the verify command: both new tests fail, because `vi.waitFor` times out with only the session-start `status` received.

- [ ] **Step 2 — the fix.** In `device.ts`, the last line of `#push()` becomes:

```ts
if (messages.some((message) => message.type === 'status')) this.#armHeartbeat();
```

and the doc comment of `#armHeartbeat()` becomes:

```ts
/**
 * The status refresh (design spec, decision 26): re-armed whenever a `status` is enqueued — the
 * session start, a transition, the heartbeat itself — and by nothing else. A device therefore
 * sends a `status` at least once per EMULATOR_HEARTBEAT_MS however busy it is, which is what
 * replaces a `status` lost between device and ingest; metrics and counters replace themselves on
 * the next tick. The `#stopped` guard keeps `prepareShutdown`'s farewell, itself a `status`, from
 * resurrecting a timer the drain has already cleared — which would put a `status` on the wire
 * after the farewell.
 */
```

In `session.ts`, the doc comment of `heartbeat()` becomes:

```ts
/**
 * One `status` carrying the current state, regardless of whether anything changed. Called only by
 * the client's status refresh timer, which fires when no `status` was enqueued for
 * EMULATOR_HEARTBEAT_MS: it replaces a lost `status` and keeps an idle connection carrying traffic
 * (design spec, decision 26).
 */
```

Run the verify command: every test passes.

- [ ] **Step 3 — the specs and `.env.example`.**
  - Emulator spec, decision 26, decision cell, becomes: ``**A status refresh, through one mechanism.** `DeviceClient` holds a heartbeat timer re-armed whenever a **`status`** is enqueued — the session start, a transition, the heartbeat itself — and by nothing else; when it fires, it calls `DeviceSession.heartbeat()`. `tick()` never produces a heartbeat. Under the default config (1 s tick, 30 s heartbeat) a device without transitions sends one `status` every 30 s next to its metrics. Amended 2026-09-13; the first rule re-armed the timer on every enqueue.``
  - Emulator spec, decision 26, reasoning cell, becomes: ``A `status` can be lost between device and ingest: evicted from a full outbox (ingest down, or a socket paused during a broker outage), written into a connection that broke (T39), or held by an ingest instance that crashed (T3). The consistency spec's answer to such a loss is that "the next periodic message restores the truth" (decision 12 there), which holds for a section only if the device sends that section periodically. Metrics and counters are periodic. Under the first rule `status` was not: every metrics tick re-armed the timer, so a lost `status` stayed lost for as long as the device stayed healthy and busy (measured 2026-09-13: after the outbox evicted the session-start `status`, 99 healthy metrics and no `status` in 20 heartbeat periods). Re-arming only on a `status` bounds that staleness to one interval after delivery resumes, sends nothing redundant right after a transition, and costs one extra `status` per interval on a device without transitions (T40). This rule does not change liveness (consistency spec, decision 27). Liveness reads `lastEvent`, which any event refreshes, and a device sends at least one message per `EMULATOR_HEARTBEAT_MS` under both rules. What changes is how fresh the `status` section itself stays. Rejected: **re-arm on every enqueue** (the first rule), for the reason above; **a fixed period independent of what was enqueued** — a redundant `status` right after every transition; **a `status` every Nth tick inside `tick()`** — a second mechanism next to the timer the idle profile still needs; **a `status` after every reconnect** — it misses an eviction behind a paused socket, where no reconnect happens.``
  - Emulator spec, the `DeviceSession` paragraph: `called only by the client's idle timer (decision 26)` becomes `called only by the client's status refresh timer (decision 26)`.
  - Emulator spec, the `DeviceClient` paragraph: `the heartbeat timer (re-armed on every enqueue)` becomes ``the heartbeat timer (re-armed whenever a `status` is enqueued)``.
  - Emulator spec, configuration table: `idle-only, re-armed on every enqueue (decision 26)` becomes ``status refresh, re-armed by every `status` (decision 26)``.
  - Emulator spec, the note on `EMULATOR_HEARTBEAT_MS`: `with the idle-only semantics of decision 26 the timer is re-armed on every enqueue, so a short heartbeat simply fires in the gaps and a long one never fires at all` becomes ``the timer is re-armed only by a `status` (decision 26), so a short heartbeat sends a `status` more often than the tick and a long one sends one per interval``.
  - Emulator spec, tests table, the `heartbeat` row becomes: ``Against a real sink with `EMULATOR_HEARTBEAT_MS` **below** `EMULATOR_EVENT_INTERVAL_MS` (the idle-device profile): statuses outnumber metrics. With the tick shorter (the default profile): one `status` per interval while metrics flow, never two inside one interval, and **a lost `status` is replaced without a state transition** — the session-start `status` counts as lost at the receiver, and the next `status` carries the same state after at least five healthy metrics. Dropping at the receiver is, from the device's side, the same event as any other loss: there is no acknowledgement.``
  - Emulator spec, trade-off table: after T25 add ``| T40 | A lost `status` is replaced by the next refresh, not at once | The stored `status` can be stale or missing for up to `EMULATOR_HEARTBEAT_MS` (30 s by default) after delivery resumes, and a device without transitions sends one redundant `status` per interval | Whenever a `status` is lost: an outbox eviction, a frame written into a broken connection (T39), an ingest crash (T3) | A shorter `EMULATOR_HEARTBEAT_MS`, or device-side acknowledgements with resend (T3's upgrade path) | 26 |``, and after the table's intro sentence add `T40 was added on 2026-09-13 (decision 26); the numbers T26–T39 belong to the ingest and shared-contract specs.`
  - Emulator spec, `## Amendments`: add ``- **Decision 26, the heartbeat.** Only a `status` re-arms it, so it refreshes the device status during traffic too; T40 names the cost. Before, every enqueue re-armed it, and a lost `status` was never replaced while the device stayed busy.``
  - Consistency spec, section `Device behaviour (apps/emulator)`: ``A `status` heartbeat is sent when nothing else was sent for `EMULATOR_HEARTBEAT_MS` (default 30 000), so an idle connection still carries traffic.`` becomes ``A `status` heartbeat is sent whenever no `status` was sent for `EMULATOR_HEARTBEAT_MS` (default 30 000), whatever else the device sent: a lost `status` is replaced within one interval (decision 12), and an idle connection still carries traffic.``
  - Consistency spec, decision 12, reasoning: `the next periodic message restores the truth.` becomes ``the next periodic message restores the truth (for `status`, the heartbeat that goes out whenever no `status` was sent for `EMULATOR_HEARTBEAT_MS`; emulator spec, decision 26).``
  - Consistency spec, trade-off list: after the T38–T39 table add the sentence `Row T40 comes from the emulator design spec (decision 26, amended 2026-09-13 after the integration-correctness review).` and a table with the same header holding the T40 row, its decision cell written `emulator spec, 26`.
  - `.env.example`: `# A status heartbeat is sent after this long without another event, milliseconds (default 30000)` becomes `# A status heartbeat is sent after this long without another status, milliseconds (default 30000)`.
  - Run `pnpm exec prettier --write docs/specs/2026-09-12-emulator-design.md docs/specs/2026-09-11-telemetry-consistency-design.md`.

- [ ] **Step 4 — review and commit.** Scoped verify, then Stage 1 and Stage 2 reviews. Commit the six files: `Refresh the device status even while metrics keep flowing`.

## Verification Criteria

| #   | Criterion                                                                                                                                                                          | How to verify                                                                                                                                                                                                                                                           |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Every queued message crosses a real backpressure stop exactly once and in order                                                                                                    | `pumpOutbox › writes every queued message exactly once and in order across backpressure`: red after Task 1 Step 2, green after Step 5                                                                                                                                   |
| 2   | The frame that fills the buffer is reported as taken; a frame written after `destroy()` and before `'close'` is refused                                                            | The two `connection.test.ts` tests of Task 1                                                                                                                                                                                                                            |
| 3   | A real emulator process with ingest unreachable stays up for `SHUTDOWN_TIMEOUT_MS` after SIGTERM, logs the loss warning with the device id, the summary and `stopped`, and exits 0 | `main.test.ts`: red after Task 2 Step 2, green after Step 3                                                                                                                                                                                                             |
| 4   | A lost `status` is replaced during continuous metrics traffic, without a state transition                                                                                          | `DeviceClient › replaces a lost status during continuous metrics traffic, without a state transition`: red after Task 3 Step 1, green after Step 2                                                                                                                      |
| 5   | The refresh sends one `status` per interval, never two inside one                                                                                                                  | `DeviceClient › sends one status per heartbeat interval while ticks keep flowing, never more`                                                                                                                                                                           |
| 6   | The review's reproductions pass against the built code                                                                                                                             | `pnpm build`, then the `.local/research/2026-09-13-delivery-probe-*.mjs` scripts against `apps/emulator/dist`: 0 duplicate frames; a lifetime of at least the budget, with the warning and `stopped`; statuses keep arriving                                            |
| 7   | No regressions                                                                                                                                                                     | `pnpm lint && pnpm typecheck && pnpm test`. The emulator suite goes from 100 to 104 tests (Task 1 adds 2, Task 2 adds 1, Task 3 replaces 1 test with 2); shared (225) and ingest keep passing (109 at `18bcd73`; the ingest count grows with the other agent's commits) |
| 8   | Standing emulator criterion: device count and event rate stay configurable through the environment                                                                                 | Run the built emulator against a local sink for 2 s twice — 2 devices at 200 ms, then 4 devices at 100 ms — and compare the distinct device ids and the lines per device                                                                                                |
| 9   | The specs and `.env.example` describe the shipped behaviour                                                                                                                        | `grep -rn "re-armed on every enqueue\|idle-only\|without another event" docs/specs .env.example` finds nothing                                                                                                                                                          |

## Test Plan

- The same scoped command after every task: `pnpm --filter @telemetry/emulator test && pnpm --filter @telemetry/emulator typecheck && pnpm --filter @telemetry/emulator lint`.
- No Docker. Every test uses loopback sockets, and Task 2 also uses a child process.
- The full pre-flight at the end: `pnpm lint && pnpm typecheck && pnpm test`.
- The ingest agent edits `apps/ingest` at the same time. If an ingest test fails or hangs, first check `git status` and `git log` for that work; do not assume this plan caused it. Run the emulator suite on its own (`pnpm exec vitest run apps/emulator`) to tell the two apart. On 2026-09-13 the first baseline run hung, with one worker at 100% CPU, while that work was being written. The per-package rerun passed: shared 225, ingest 109, emulator 100.

## Checkpoint Recovery

If interrupted during implementation:

1. Read this plan.
2. Run `git log --oneline -- apps/emulator` and look for the three task commit subjects.
3. Continue at the first task whose commit is missing. Apply the three rules of "Concurrent work in this checkout" before every edit and every commit.
