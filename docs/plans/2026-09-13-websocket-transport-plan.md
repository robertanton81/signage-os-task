> **STATUS: SHIPPED 2026-09-14.** Landed as 10 commits on the worktree branch `worktree-websocket-transport`, `f9174c4..4a8e794`: the spec and plan commit, one commit per task, and two commits with the tests the reviews asked for. Not merged into `main` — the user merges. The full pre-flight passed right before the last commit: `pnpm format:check && pnpm lint && pnpm typecheck && pnpm test`, 567 tests in 29 files (223 in `apps/ingest`, 118 in `apps/emulator`, 226 in `packages/shared`). The unchecked `- [ ]` boxes below are historical; the work is done. **Do not re-execute this plan.** If you are changing the transport, work directly in `apps/ingest/src/{server,connection}.ts` and `apps/emulator/src/connection.ts`.
>
> **Library and version drift:** none. ws 8.21.3 and @types/ws 8.18.1 are as pinned; `ws` ships no types, so `@types/ws` is a devDependency of both apps. Two facts from the library shaped the code and the plan did not describe them:
>
> - ws 8.21.3 calls a successful `send()` callback with `null` (Node's stream write callback), although `@types/ws` 8.18.1 declares `(err?: Error)`. The emulator's gate reopening checked `error !== undefined` first and never reopened; `write()` now checks `error != null` (probe p17, `.local/research/websocket/2026-09-13-ws-probe-send-callback.mjs`).
> - ws emits `upgrade` and then `open` in the same tick on the client, so a test double that awaits them one after the other never resolves; `test-device.ts` records the socket in an `upgrade` listener attached before `open` is awaited.
>
> **Plan prescriptions that needed adjustment:**
>
> - Task 5, scenario 12: a device TCP reset shows on the server as `close` 1006 with no `error` event (ws's `socketOnError` swallows socket errors; probe p15), so the scenario asserts reason `end`, `closeCode` 1006 and no warn line; the `'error'` listener's non-protocol branch has no test of its own, as the plan already stated.
> - Task 5, scenario 22: `device.pings()` cannot discriminate there, because the device's socket is paused; the test asserts the drain result, the elapsed time and the close reason `shutdown` instead.
> - Task 5, scenario 25 (added in `2bfbbd0` after the code review): a valid message that arrives in the same read as a binary one is dropped once the connection has decided to close; produced deterministically by sending both while the connection is paused.
> - Task 6: the "goes to backoff when the server rejects the upgrade" scenario asserts the first error and close lines rather than exact arrays, because the seeded backoff can schedule a second, identical attempt inside the wait.
> - Task 6: the `--experimental-transform-types` comment in both `test-source-hooks.ts` now names `ConfigError` alone as the parameter property that needs the flag (`FrameTooLongError` is gone).
>
> **Corrections applied during review:**
>
> - Task 5, code review (1 blocking): the guard that ignores messages after the connection decided to close had no test; fixed in `2bfbbd0`. Spec compliance and test quality passed with suggestions (an untested double `destroy()`, the upgrade socket's error listener, the post-listen accept error — all narrow logging branches, left as they are).
> - Task 6, test quality (3 blocking) and code review (1 blocking, the same gap): a stop during a DNS lookup, the one-second close cap against a peer that never reads the close frame, and the send callback of a terminated socket were untested; fixed in `4a8e794`, which also pins the debug level of the post-stop socket error.
> - Task 7, code review: passed; the grammar of the transform-types comment fixed in `4a8e794`.
> - Design spec: four review rounds (`.local/` transcripts are not kept; the findings are folded into the spec): the liveness ping had to skip every connection whose `readyState` is not `OPEN`, whichever side began the close; `beginClose()` gates on `readyState`; ws's `close()`, `ping()` and `pong()` semantics in every ready state are cited from the source.
>
> **Deferrals worth tracking:**
>
> - A pre-upgrade idle bound on the device port: an HTTP client that connects and sends nothing is bounded only by Node's `headersTimeout` (60 s); T27 (no connection cap) covers the same class.
> - The stale-socket identity check in the emulator's send callback (`current.socket === socket`) cannot be reached: a successful callback fires while its socket is alive, and a new socket opens only after the old one's `close`, a backoff, a lookup and a handshake. Kept as a one-line guard with a comment.
> - README (step 8): a `websocat` one-liner for field debugging (T50) and the production edge (TLS at the balancer, authentication at the upgrade, an L7 balancer; spec decision 14).
> - Emulator: no client-side ping (T54); a device detects a silently dead ingest through TCP keepalive on the upgrade response's socket.
>
> **Scripted run against RabbitMQ 4.3 (Task 8), 2026-09-14.** `node .local/research/2026-09-13-ingest-scripted-run-ws.mjs` ran the built entry point of `3fdf12a` with `ws` devices against a throwaway `rabbitmq:4.3-management` container (RabbitMQ 4.3.5, Erlang 27.3.4.17); the output is in `.local/research/2026-09-13-ingest-scripted-run-ws-output.txt`. All seven scenarios passed: (1) 20 messages, 20 confirms, 20 distinct ids, the peeked properties as before; (2) 83 messages across `docker restart`, 503 `connecting` during it, recycle as `channel_closed`, none missing; (3) the deleted queue: `message returned` at error, recycle `returned`, the queue declared again and the message in it; (4) the resource alarm: 503 `blocked`, a device's `bufferedAmount` reached the 64 KiB gate at 5001 messages, no recycle during the alarm, all 5001 in the queue after it; (5) SIGTERM: exit 0 after 16 ms, both devices received close code 1001 with reason `ingest shutting down`, no budget warning; (6) invalid messages: two `message rejected` lines (`invalid_schema`, `invalid_json`), the connection still open, only the valid message in the queue; (7) the frozen broker: 200 messages published, none confirmed, heartbeat timeout after 4655 ms, all 200 published again after `docker unpause`, 282 in the queue with 200 distinct.
>
> **Two-instance probe, 2026-09-14.** `node .local/research/2026-09-13-ingest-two-instance-probe-ws.mjs` (output in `2026-09-13-ingest-two-instance-probe-ws-output.txt`): two ingest instances on one broker, the built emulator spread over both. All nine checks passed: both ready; a hand-driven WebSocket with two messages two seconds apart, then two malformed messages rejected and the connection kept; 10 and 20 devices as configured; the event rate follows the interval; devices published via both instances with no sequence gap; SIGTERM on one instance with 8 connections drained and exited 0 in 12 ms; all 8 of its devices continued on the other instance; 856 messages, 10 devices, no gaps across the failover; readiness followed the broker and a stop without a broker exited 0.
>
> **Plan history below is preserved as-written for context. Treat the live code as authoritative.**

# WebSocket Device Transport Implementation Plan

**Goal:** Devices talk to ingest over WebSocket instead of raw TCP with newline-delimited JSON, with the consistency mechanism, the publisher and the processing design untouched.
**Approach:** Add `ws` 8.21.3 to the catalog, put the socket path and the message encoder into `packages/shared`, rewrite the ingest device server and connection around a `ws` server on an `http.Server` (pause and resume for the reading rule, a ping for liveness, close code 1001 for the drain), rewrite the emulator connection around the `ws` client (send callback for backpressure, handshake timeout for the connect deadline), rewrite the two socket test doubles, then remove the line decoder from shared. Every commit keeps lint, typecheck and the tests green, so the old framing is deleted last.
**Design spec:** `docs/specs/2026-09-13-websocket-transport-design.md` (binding), with the amendments it applied to `docs/specs/2026-09-11-shared-contract-design.md`, `docs/specs/2026-09-13-ingest-design.md`, `docs/specs/2026-09-12-emulator-design.md` and `docs/specs/2026-09-11-telemetry-consistency-design.md`.
**TODO items:** 3. Emulátor zařízení and 4. Socket ingest služba — the transport under the ticked items; no box changes (the dated notes are in `TODO.md`).
**Branch:** `worktree-websocket-transport` (a git worktree, because another session works on `main`); the user merges it into `main`. Small atomic commits, no assistant attribution.
**Scope:** `packages/shared` (`framing.ts`, its test, `index.ts` unchanged), `apps/ingest` (`config.ts`, `connection.ts`, `server.ts`, `test-device.ts`, `main.test.ts`, their tests), `apps/emulator` (`connection.ts`, `outbox.ts`, `device.ts`, `test-sink.ts`, their tests), `pnpm-workspace.yaml`, `apps/*/package.json`, `pnpm-lock.yaml`, `.env.example`. Not touched: `apps/processing`, `packages/shared/src/decode.ts`, `apps/ingest/src/publisher*.ts`, `apps/ingest/src/health.ts`, `apps/ingest/src/flow.ts`.

## Assumptions decided without asking (standing instruction: work autonomously, log every decision)

1. **Work lands on the worktree branch, not on `main`.** The user asked for a worktree because the "Processing design spec" session works on `main`. Commits go to `worktree-websocket-transport`; merging is the user's action.
2. **Green at every commit.** The shared package keeps `FrameDecoder` and `encodeFrame` until the last consumer is gone (Task 7), so `pnpm typecheck` passes after each task. The alternative — one commit for everything — would hide the steps the history is graded on.
3. **The ingest server and connection change in one commit** (Task 5). They cannot be split: the connection needs the `ws` object the server accepts, and the tests need both. The commit is large but atomic.
4. **`ws` is a runtime dependency of both apps, `@types/ws` a dev dependency of both.** Each app declares what it imports (`CLAUDE.md`, `apps/*` depend on `packages/*`, never on each other's manifests).
5. **`pnpm install` without `--frozen-lockfile` runs once, in Task 2,** to add the two packages to `pnpm-lock.yaml`; every later verify uses the frozen lockfile.
6. **Test doubles connect with the `ws` client** (`test-device.ts`) and serve with the `ws` server (`test-sink.ts`); Node's built-in `WebSocket` is not used anywhere (spec, decision 1 and Alternatives).
7. **The unresponsive-device test uses the `ws` client option `autoPong: false`** (spec Research: `doc/ws.md` client options), a client that never answers pings — the spec's Tests section prescribes the same; the "paused connections are not pinged" test counts the client's `'ping'` events.
8. **The scripted run against RabbitMQ (Task 8) is a copy of the existing `.local` script with WebSocket devices;** its output is recorded in this plan's header at ship time, as the ingest plan did. Docker is available on this machine (checked 2026-09-13, server 29.4.0).
9. **`onClose` keeps two arguments** `(connection, reason)`; the close code is read from `connection.closeCode`, so the callback stays under the two-parameter rule without a named object.

## Research (source links)

All library facts come from the spec's Research section, which cites `doc/ws.md` at tag 8.21.3, the `ws` README, the `ws` release notes, RFC 6455, the Node v24 `http`, `net` and `globals` docs, and the local probes in `.local/research/websocket/`. The plan adds nothing from memory; the items below are the ones the tasks lean on, with the section of the spec that sources them:

- `WebSocketServer({ noServer, maxPayload, perMessageDeflate, clientTracking })`, `handleUpgrade(request, socket, head, callback)`, `wss.close()` not closing connections — spec decision 4 and 8; Research, `doc/ws.md`.
- `ws.pause()` / `ws.resume()` / `ws.isPaused` pausing the underlying socket — spec decision 5; probes p1, p2.
- `ws.ping()`, `'pong'`, the README `isAlive` pattern, automatic pongs on both clients — spec decision 6; probe p5.
- `'message'` `(data: RawData, isBinary)` with `RawData = Buffer | ArrayBuffer | Buffer[]`; `ws.close(code, reason)` with 1001 and 1003 allowed; `'error'` with `WS_ERR_*` codes; `'close'` `(code, reason: Buffer)`; `ws.terminate()` — spec decisions 3, 7, 8; probes p3, p4, p6, p10.
- Client: `new WebSocket(url, { perMessageDeflate, handshakeTimeout, autoPong })`, `'upgrade'` `(response: http.IncomingMessage)`, `send(data, callback)` "invoked when `data` is written out", `bufferedAmount`, `'unexpected-response'` default (error when no listener), `close()` and `terminate()` while `CONNECTING` — spec decisions 9, 10; probes p2, p8, p9, p14.
- `http.Server.close()` waits for upgraded sockets; `closeAllConnections()` does not destroy them — spec decision 8; Research node-client B2; probe p7.
- `IncomingMessage.socket` for the remote address and for `setKeepAlive` — spec decisions 4, 9; Node `http` docs.
- ESM import forms under `nodenext` + `verbatimModuleSyntax`: `import { WebSocketServer, WebSocket } from 'ws'`, `import type { RawData } from 'ws'` — spec Research, `@types/ws` 8.18.1.
- Dependency vetting numbers — spec decision 12.

## File Changes

| Action | Path                                                                                  | Purpose                                                                                                                                                                                 |
| ------ | ------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Modify | `pnpm-workspace.yaml`                                                                 | Catalog entries `ws: 8.21.3`, `'@types/ws': 8.18.1`                                                                                                                                     |
| Modify | `apps/ingest/package.json`                                                            | `dependencies.ws: catalog:`, `devDependencies.@types/ws: catalog:`                                                                                                                      |
| Modify | `apps/emulator/package.json`                                                          | Same two entries                                                                                                                                                                        |
| Modify | `pnpm-lock.yaml`                                                                      | The two packages (Task 2, `pnpm install`)                                                                                                                                               |
| Modify | `packages/shared/src/framing.ts`                                                      | Task 3: add `TELEMETRY_SOCKET_PATH` and `encodeMessage`; Task 7: remove `FrameDecoder`, `FrameTooLongError`, `FrameRejection`, `FrameDecodeResult`, `encodeFrame`, `INITIAL_TAIL_BYTES` |
| Modify | `packages/shared/src/framing.test.ts`                                                 | Task 3: tests for the two new exports; Task 7: delete the decoder and `encodeFrame` tests                                                                                               |
| Modify | `apps/ingest/src/config.ts`                                                           | Task 4: `INGEST_PING_INTERVAL_MS`; Task 5: remove `INGEST_SOCKET_IDLE_MS`                                                                                                               |
| Modify | `apps/ingest/src/config.test.ts`                                                      | Same two steps                                                                                                                                                                          |
| Modify | `.env.example`                                                                        | Task 4: the new key; Task 5: remove the old key; Task 6: the `INGEST_HOSTS` comment                                                                                                     |
| Modify | `apps/ingest/src/connection.ts`                                                       | Task 5: `DeviceConnection` over a `ws` `WebSocket`                                                                                                                                      |
| Modify | `apps/ingest/src/server.ts`                                                           | Task 5: `http.Server` + `WebSocketServer`, upgrade handling, ping interval, shutdown with close code 1001                                                                               |
| Modify | `apps/ingest/src/test-device.ts`                                                      | Task 5: a `ws` client wrapper                                                                                                                                                           |
| Modify | `apps/ingest/src/server.test.ts`                                                      | Task 5: every scenario over WebSocket                                                                                                                                                   |
| Modify | `apps/ingest/src/main.test.ts`                                                        | Task 5: the device connects with `ws`                                                                                                                                                   |
| Modify | `apps/emulator/src/connection.ts`                                                     | Task 6: `DeviceConnection` over the `ws` client                                                                                                                                         |
| Modify | `apps/emulator/src/outbox.ts`                                                         | Task 6: `OutboxEntry.text`, `encodeMessage`                                                                                                                                             |
| Modify | `apps/emulator/src/device.ts`                                                         | Task 6: `pumpOutbox` writes `entry.text`                                                                                                                                                |
| Modify | `apps/emulator/src/test-sink.ts`                                                      | Task 6: a `ws` server sink                                                                                                                                                              |
| Modify | `apps/emulator/src/connection.test.ts`                                                | Task 6: every scenario over WebSocket                                                                                                                                                   |
| Modify | `apps/emulator/src/outbox.test.ts`, `device.test.ts`, `fleet.test.ts`, `main.test.ts` | Task 6: sink API names and the `text` field                                                                                                                                             |
| Modify | `docs/plans/2026-09-13-websocket-transport-plan.md`                                   | Task 8: scripted-run evidence; ship time: `STATUS: SHIPPED` header                                                                                                                      |

## Tasks

### Task 1: Commit the design spec and its amendments [mechanical]

**Files:** `docs/specs/2026-09-13-websocket-transport-design.md` (new), the four amended specs, `TODO.md`, this plan.
**Invariant:** none touched.
**Verify:** `pnpm format:check`

- [ ] `git add` exactly these files (never `-A`).
- [ ] Commit: `Add the WebSocket transport design spec and amend the earlier specs`.

### Task 2: Add ws to the catalog and to both apps [mechanical]

**Files:** `pnpm-workspace.yaml`, `apps/ingest/package.json`, `apps/emulator/package.json`, `pnpm-lock.yaml`.
**Invariant:** none touched.
**Verify:** `pnpm install --frozen-lockfile && pnpm lint && pnpm typecheck`

- [ ] Catalog: `ws: 8.21.3` and `'@types/ws': 8.18.1`, in alphabetical order with the existing entries.
- [ ] `apps/ingest/package.json`: `"ws": "catalog:"` under `dependencies` (alphabetical: after `amqplib`... `@telemetry/shared`, `amqplib`, `ws`, `zod` — `ws` before `zod`), `"@types/ws": "catalog:"` under `devDependencies` before `vitest`.
- [ ] `apps/emulator/package.json`: the same two entries.
- [ ] `pnpm install` (updates the lockfile), then `pnpm install --frozen-lockfile` to prove it is complete.
- [ ] A one-line probe that the types resolve: `import { WebSocketServer } from 'ws'` compiles in a scratch `.ts` under `apps/ingest/src/` — removed before the commit (or simply rely on Task 5's typecheck; either way nothing extra is committed).
- [ ] Commit: `Add ws 8.21.3 and its types to the catalog and both apps`.

### Task 3: Shared wire contract — the socket path and the message encoder [mechanical]

**Files:** `packages/shared/src/framing.ts`, `packages/shared/src/framing.test.ts`.
**Invariant:** none touched (the contract's fields are unchanged; only the encoding of one message on the wire).
**Verify:** `pnpm --filter @telemetry/shared test && pnpm --filter @telemetry/shared typecheck && pnpm --filter @telemetry/shared lint`

- [ ] Add to `framing.ts`, above the existing code, with doc comments:
  ```ts
  /** The request path of the device WebSocket endpoint on ingest (WebSocket transport spec, decision 1). */
  export const TELEMETRY_SOCKET_PATH = '/telemetry';
  /** One compact JSON message per WebSocket text message (WebSocket transport spec, decision 2). No `space` argument: the text is one line and matches the AMQP body byte for byte. */
  export function encodeMessage(message: TelemetryMessage): string {
    return JSON.stringify(message);
  }
  ```
  Reword the `MAX_FRAME_BYTES` comment to "Upper bound of one message on the wire: the server's `maxPayload`, and the AMQP body bound in processing."
- [ ] Tests (`framing.test.ts`, new `describe('encodeMessage')`): a `diagnostic` message with a multi-line `message` field (`'line one\nline two'`) encodes to text with no raw `\n` (the newline is escaped as `\\n`) and no whitespace between tokens; `decodeTelemetryMessage(encodeMessage(m))` returns `{ ok: true, message: m }` for each of the four fixture messages; `TELEMETRY_SOCKET_PATH === '/telemetry'` and starts with `/`; `Buffer.byteLength(encodeMessage(largestFixture))` is far below `MAX_FRAME_BYTES` (asserts the bound is generous, `< 1024`).
- [ ] Commit: `Add the socket path and the message encoder to the shared contract`.

### Task 4: Ingest configuration — the ping interval [mechanical]

**Files:** `apps/ingest/src/config.ts`, `apps/ingest/src/config.test.ts`, `.env.example`.
**Invariant:** none touched.
**Verify:** `pnpm --filter @telemetry/ingest test && pnpm --filter @telemetry/ingest typecheck && pnpm --filter @telemetry/ingest lint`

- [ ] `config.ts`: add `INGEST_PING_INTERVAL_MS: envInt({ min: 1, max: TIMER_MAX_MS, defaultValue: 30_000 })` after `INGEST_MAX_UNCONFIRMED_TOTAL`, with the comment "A `setInterval` delay: above TIMER_MAX_MS Node fires it after 1 ms." `INGEST_SOCKET_IDLE_MS` stays until Task 5 removes it with its last use.
- [ ] `config.test.ts`: default 30 000 when unset and when empty; `'50'` → 50; `'0'` rejected naming `INGEST_PING_INTERVAL_MS`; `String(TIMER_MAX_MS + 1)` rejected; `'abc'` rejected. Follow the file's existing table style for the other integer keys.
- [ ] `.env.example`: under `# --- ingest ---`, after `INGEST_MAX_UNCONFIRMED_TOTAL=`, add `# A WebSocket ping goes to every reading device connection this often, milliseconds; a connection that has not answered the previous ping is closed (default 30000, at most 2147483647)` and `INGEST_PING_INTERVAL_MS=`.
- [ ] Commit: `Add the ingest ping interval to the configuration`.

### Task 5: Serve devices over WebSocket in ingest [integration]

**Files:** `apps/ingest/src/connection.ts`, `apps/ingest/src/server.ts`, `apps/ingest/src/test-device.ts`, `apps/ingest/src/server.test.ts`, `apps/ingest/src/main.test.ts`, `apps/ingest/src/config.ts`, `apps/ingest/src/config.test.ts`, `.env.example`.
**Invariant:** 4 (connections stay independent; the ping touches each once per tick), 5 (pause only for a full window or a not-ready publisher; pings only to reading connections), 6 (nothing keyed by device; any instance accepts any upgrade). Proved by the server tests listed below, in particular "pauses a connection when its own window fills" (5), "pauses every connection when the instance window fills" (5), "never pings a paused connection" (5, the outage case), and "logs the accept and the close" (6: the connection holds `connectionId`, `remote`, counters and `lastDeviceId` only).
**Verify:** `pnpm --filter @telemetry/ingest test && pnpm --filter @telemetry/ingest typecheck && pnpm --filter @telemetry/ingest lint`

Order inside the task: the test double first, then the connection, the server, the tests, then the config removal, then the entry-point test.

- [ ] **`test-device.ts`** — a `ws` client wrapper (the doc comment explains why a real client: pausing, the close handshake, the pong and the send callback are protocol and kernel behaviour):
  ```ts
  export type TestDevice = {
    ws: WebSocket;
    /** The device's own TCP socket, from the 'upgrade' response: tests pause it or reset it. */
    socket: net.Socket;
    send(text: string): void;
    sendBinary(bytes: Buffer): void;
    sendMessage(message: TelemetryMessage): void;
    /** Pings received from the server so far. */
    pings(): number;
    /** Resolves when the connection has closed, with the code and reason the peer sent (1006 when none). */
    closed: Promise<{ code: number; reason: string }>;
    close(code?: number, reason?: string): void;
    terminate(): void;
  };
  export function connectTestDevice({
    port,
    path = TELEMETRY_SOCKET_PATH,
    autoPong = true,
  }: {
    port: number;
    path?: string;
    autoPong?: boolean;
  }): Promise<TestDevice>;
  ```
  `new WebSocket(`ws://127.0.0.1:${port}${path}`, { perMessageDeflate: false, autoPong })`; the `'upgrade'` listener stores `response.socket`; the promise resolves on `'open'` and rejects on `'error'` before open; a no-op `'error'` listener after open (resets are part of several scenarios); `sendMessage` is `send(encodeMessage(message))`; `sendBinary` is `ws.send(bytes, { binary: true })`.
- [ ] **`connection.ts`** — as the spec's "Ingest connection" section:
  - `import type { RawData, WebSocket } from 'ws'`.
  - `CloseReason = 'end' | 'error' | 'protocol' | 'binary' | 'unresponsive' | 'shutdown'`.
  - Options: `connectionId`, `ws` (paused by the server before the constructor runs), `remote`, `publisher`, `window`, `instanceWindow`, `logger`, the four callbacks unchanged. No `idleMs`.
  - Fields: `#reading`, `#open`, `#closeReason`, `#closeCode`, `#awaitingPong`, `#lastDeviceId`, `#received`, `#rejected`. Getters: `isReading`, `lastDeviceId`, `received`, `rejected`, `closeCode` (undefined while open).
  - Listeners in the constructor: `'message'` → `#onMessage(data, isBinary)`; `'pong'` → `#awaitingPong = false`; `'error'` → if the error has a string `code` starting with `WS_ERR_`: `#closeReason ??= 'protocol'` and `warn` `protocol violation` with `{ err, code, connectionId, remote, lastDeviceId }`; otherwise `#closeReason ??= 'error'` and `warn` `connection error` with `{ err, connectionId, remote, lastDeviceId }`; `'close'` `(code)` → `#open = false; #reading = false; #closeCode = code; onClose(this, #closeReason ?? 'end')`.
  - `#onMessage`: return at once when `#closeReason` is set (a connection that is being closed for a violation processes nothing more, the same way `ws` stops reading after a protocol error); binary → `#rejected += 1`, `#closeReason = 'binary'`, `warn` `binary message rejected` `{ connectionId, remote, lastDeviceId, bytes }`, `ws.close(1003, 'text messages only')`; text → `toBuffer(data).toString('utf8')` where `toBuffer` handles the three `RawData` shapes (`Buffer.isBuffer`, `Array.isArray` → `Buffer.concat`, else `Buffer.from(arrayBuffer)`), then `decodeTelemetryMessage`, then exactly the existing accept or reject steps (`message rejected` for the reject line) and the two window callbacks.
  - `applyReadingRule(...)`: unchanged predicate; on → `ws.resume(); #awaitingPong = false`; off → `ws.pause()`.
  - `checkLiveness()`: `if (!#reading || ws.readyState !== WebSocket.OPEN) return; if (#awaitingPong) { destroy('unresponsive'); return; } #awaitingPong = true; ws.ping();` — a connection that is closing, whichever side began it, is never pinged: after a close frame the device need not answer (RFC 6455 §5.5.2; spec decisions 6 and 8). `WebSocket` is imported as a value for the constant (`import { WebSocket, type RawData } from 'ws'`).
  - `beginClose()`: `if (ws.readyState === WebSocket.OPEN) ws.close(1001, 'ingest shutting down')` — a connection already closing on its own keeps its recorded reason; `ws.close` on a `CLOSING` socket would be a no-op anyway (spec Research: ws sources, `close`).
  - `destroy(reason)`: `if (!#open) return; #closeReason ??= reason; ws.terminate();`
  - `#confirmation()` unchanged.
- [ ] **`server.ts`** — as the spec's "Ingest server" section:
  - `import http from 'node:http'`, `import type { Duplex } from 'node:stream'`, `import { WebSocketServer, type WebSocket } from 'ws'`, `MAX_FRAME_BYTES`, `TELEMETRY_SOCKET_PATH` from shared.
  - Constructor: `this.#server = http.createServer((request, response) => { response.writeHead(404, { 'content-type': 'application/json' }); response.end('{}'); })`; `this.#wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES, perMessageDeflate: false, clientTracking: false })`; `this.#server.on('upgrade', (request, socket, head) => { this.#onUpgrade({ request, socket, head }); })` with `// eslint-disable-next-line max-params -- Node emits 'upgrade' with exactly these three positional arguments` on the arrow function; `publisher.onReadyChange` unchanged.
  - `#onUpgrade({ request, socket, head })`: `socket.on('error', (error) => logger.debug({ err: error }, 'upgrade socket error'))`; `const path = new URL(request.url ?? '', 'http://ingest').pathname` inside a try (a malformed URL counts as a wrong path); wrong path → `logger.debug({ remote, path }, 'upgrade rejected')`, `socket.write('HTTP/1.1 404 Not Found\r\n\r\n')`, `socket.destroy()`; right path → `this.#wss.handleUpgrade(request, socket, head, (ws) => { this.#accept(ws, request); })`. The doc comment names this listener as the authentication point (spec, decision 14).
  - `#accept(ws, request)`: `ws.pause()` first; `remote` from `request.socket.remoteAddress ?? 'unknown'` and `remotePort ?? 0`; then the `DeviceConnection`, the registry, the `connection accepted` line and `#applyRule`, as today.
  - `listen()`: unchanged shape; after the bind succeeds start `this.#pingTimer = setInterval(() => { this.#pingAll(); }, INGEST_PING_INTERVAL_MS)` and `unref()` it. `#pingAll()` calls `checkLiveness()` on every connection (the connection itself skips unless it is reading and `OPEN`).
  - `#onClose(connection, reason)`: the `connection closed` line loses `pendingBytes` and gains `closeCode: connection.closeCode`.
  - `shutdown()`: `this.#server.close()` (no callback awaited: it completes when the last upgraded socket is gone); `connection.beginClose()` for each; the drain as today. `#checkDrain` and `#endDrainAtBudget` call a new `#finishDrain(result)` that clears the ping timer, calls `this.#wss.close()`, and resolves. `#endDrainAtBudget` still destroys the leftovers with reason `shutdown` before finishing.
  - Remove `TCP_KEEPALIVE_INITIAL_DELAY_MS` and the `net` import.
- [ ] **`config.ts` / `config.test.ts` / `.env.example`**: remove `INGEST_SOCKET_IDLE_MS` and its tests and lines.
- [ ] **`server.test.ts`** — keep the harness shape (`startServer`, `linesWith`, `connectionsOf`, `onlyConnection`); `BASE_CONFIG` gets `INGEST_PING_INTERVAL_MS: 30_000` implicitly from the loader. Scenarios, each with the observable outcome:
  1. `publishes valid messages in arrival order, each with the time it was received` — two `sendMessage`, the publisher's two requests in order with `receivedAt` bounded by the test's clock.
  2. `logs an invalid message with its reason, drops it and keeps the connection open` — `send('not json')`, `send('{"v":1,"deviceId":"dev-0009","type":"bogus"}')`, a valid `counters`; one request; two `message rejected` lines at WARN with reasons `invalid_json`, `invalid_schema`; the second carries `deviceId: 'dev-0009'`; `[received, rejected]` is `[1, 2]`; the device's `ws.readyState` is still OPEN.
  3. `closes a connection that sends a binary message with code 1003, after counting it` — `sendBinary(Buffer.from([1, 2, 3]))`; `device.closed` resolves with `{ code: 1003, reason: 'text messages only' }`; one `binary message rejected` WARN line with `bytes: 3`; `connection closed` has `reason: 'binary'`; `server.stats().rejected` is 1.
  4. `closes a connection whose message exceeds the limit, after publishing the one before it` — `sendMessage(status)`, then `send('a'.repeat(MAX_FRAME_BYTES + 1))`; the publisher has the status; `device.closed` code is 1009; one `protocol violation` WARN line with `code: 'WS_ERR_UNSUPPORTED_MESSAGE_LENGTH'`, `connectionId`, `remote`; `connection closed` has `reason: 'protocol'` and `closeCode: 1006` (the server ends the socket right after its close frame; probe p3).
  5. `reads no connection while the publisher is not ready, and every connection while it is` — two devices; `isReading` false and `ws.isPaused` true for both; a message sent while not ready is not published; after `setReady(true)` both read, the message arrives; after `setReady(false)` both are paused again.
  6. `pauses a connection when its own window fills and resumes it at half the cap` — as today with `ws.isPaused` in place of `readableFlowing`.
  7. `publishes every message of one read that fills its window, and pauses only after it` — three messages sent while not ready; after `setReady(true)` all three requests arrive in order and the connection is paused (`INGEST_MAX_UNCONFIRMED: 1`).
  8. `pauses every connection when the instance window fills, and resumes every connection when it reopens` — as today.
  9. `closes a reading connection that does not answer pings, within two intervals` — `INGEST_PING_INTERVAL_MS: 50`, `connect({ autoPong: false })`; `device.closed` resolves (code 1006: `terminate()` sends no close frame); `connection closed` has `reason: 'unresponsive'`; elapsed time below 500 ms.
  10. `keeps a connection that answers pings` — interval 50 ms, default client; after `device.pings()` reaches 3 (event-driven wait on the client's `'ping'` events through `vi.waitFor`), the connection is still open and `server.connections()` still lists it.
  11. `never pings a paused connection` — interval 50 ms, `ready: false`; one of the file's two bounded absence checks (the other is scenario 23): after 250 ms (five intervals) `device.pings()` is 0 and the connection is open; then `setReady(true)` and `vi.waitFor` until `pings()` is 1 — pings start with reading.
  12. `closes a connection with reason end and code 1006 when the device resets it, naming the device` — `sendMessage(status)`, wait for the request, `device.socket.resetAndDestroy()`; `connection closed` has `reason: 'end'`, `closeCode: 1006`, `lastDeviceId: 'dev-0001'`; no WARN line (`ws` swallows the socket error and reports a close with 1006 — spec Research, probe p15). The `'error'` listener's non-protocol branch therefore has no test of its own; it exists because an emitter without an `error` listener throws, and it is covered by lint and typecheck only.
  13. `closes with reason end and the device's code when the device closes normally` — `device.close(1000, 'device stopping')`; `connection closed` has `reason: 'end'`, `closeCode: 1000`; no WARN line.
  14. `frees the instance window when a message of a closed connection is confirmed` — as today with `terminate()`.
  15. `sends close code 1001 to every device on shutdown and finishes once they have closed` — two devices; `shutdown()` resolves `{ 0, 0 }` under 1 s; both `device.closed` resolve with `{ code: 1001, reason: 'ingest shutting down' }`; no WARN lines.
  16. `publishes what a paused connection holds when the publisher becomes ready during the drain, then closes it` — `ready: false`; `sendMessage(status)`; `shutdown()`; the publisher has no request; `setReady(true)`; the request arrives; `confirm(0)`; the drain resolves `{ 0, 0 }`; `device.closed` code 1001.
  17. `destroys the connections still open when the drain budget runs out, with one warn line` — `SHUTDOWN_TIMEOUT_MS: 100`; `device.socket.pause()` right after connecting (a device that never reads the close frame); `shutdown()` resolves `{ openConnections: 1, unconfirmed: 0 }`; one WARN line with those counts; `connection closed` has `reason: 'shutdown'`.
  18. `finishes a shutdown at once when no device is connected and nothing waits for a confirm` — as today.
  19. `finishes the drain on the confirm that empties the ledger, though no window reopens` — as today with `device.close()`.
  20. `answers 404 to an upgrade on another path and to a plain HTTP request` — `connectTestDevice({ port, path: '/other' })` rejects (the wrapper's `'error'` before open: "Unexpected server response: 404"); one `upgrade rejected` DEBUG line with `path: '/other'`; `fetch(`http://127.0.0.1:${port}/telemetry`)` returns 404 with body `{}`; `server.connections()` is empty.
  21. `logs the accept and the close of a connection, and counts it while open and after it closed` — as today without `pendingBytes`, with `closeCode: 1000` after `device.close(1000)`.
  22. `never pings a closing connection, so a device that stops answering after the close frame is ended by the budget, not as unresponsive` — `INGEST_PING_INTERVAL_MS: 50`, `SHUTDOWN_TIMEOUT_MS: 300`, `ready: false`; connect; `device.socket.pause()` (the device reads neither pings nor the close frame); `shutdown()`; `setReady(true)` (reading starts, pings would start); the drain resolves `{ openConnections: 1, unconfirmed: 0 }` after at least 300 ms; `device.pings()` is 0; `connection closed` has `reason: 'shutdown'`, never `unresponsive`.
  23. `never pings a connection it is closing itself, so a device that stops answering after a 1003 closes with reason binary` — `INGEST_PING_INTERVAL_MS: 50`; connect; `device.socket.pause()`; `sendBinary(Buffer.from([1]))`; the `binary message rejected` line appears; a 250 ms wait (five intervals; the assertion is that nothing happens): `server.connections()` still lists the connection, no `connection closed` line, `device.pings()` is 0; `device.socket.resume()`; `device.closed` resolves with code 1003; `connection closed` has `reason: 'binary'`, `closeCode: 1003`.
  24. `ends a connection that was already closing on its own at the budget, with its own reason` — `SHUTDOWN_TIMEOUT_MS: 200`; connect; `device.socket.pause()`; `sendBinary(Buffer.from([1]))`; after the `binary message rejected` line, `shutdown()`; it resolves `{ openConnections: 1, unconfirmed: 0 }`; `connection closed` has `reason: 'binary'` (not `shutdown`), `closeCode: 1006`; the device, once resumed, sees exactly one close frame: its `closed` resolves with code 1003.
- [ ] **`main.test.ts`**: the device is `connectTestDevice` from `test-device.ts` (import it; the file already spawns the real entry point); the `sockets: net.Socket[]` array and its `afterEach` loop (`socket.destroy()`) become `devices: TestDevice[]` with `device.terminate()`; the `net` import stays for `freePorts`, `listen` and `close`; keep every assertion, the `/readyz` ones included (503 `connecting` during the outage, 503 `shutting_down` during the drain); the drain still ends at its budget with `openConnections: 1` because the paused server never reads the device's close reply.
- [ ] Run the scoped verify; then `pnpm test` for the whole tree (the emulator still uses TCP at this point and must still pass).
- [ ] Commit: `Serve devices over WebSocket in ingest`.

### Task 6: Connect emulated devices over WebSocket [integration]

**Files:** `apps/emulator/src/connection.ts`, `apps/emulator/src/outbox.ts`, `apps/emulator/src/device.ts`, `apps/emulator/src/test-sink.ts`, `apps/emulator/src/connection.test.ts`, `apps/emulator/src/outbox.test.ts`, `apps/emulator/src/device.test.ts`, `apps/emulator/src/fleet.test.ts`, `apps/emulator/src/main.test.ts`, `.env.example`.
**Invariant:** 1 at the source (the outbox and pump keep every message exactly once and in order across backpressure; proved by `pumpOutbox` "writes every queued message exactly once and in order across backpressure" and by the connection test "takes the message that reaches the high-water mark, refuses the next, and becomes writable again through the send callback").
**Verify:** `pnpm --filter @telemetry/emulator test && pnpm --filter @telemetry/emulator typecheck && pnpm --filter @telemetry/emulator lint`

- [ ] **`test-sink.ts`** — `startTestSink()` returns `{ port, messages(): string[], waitForMessages(count), connectionCount(), dropConnections(), pauseConnections(), resumeConnections(), close() }`: an `http.Server` on `127.0.0.1:0` with a `WebSocketServer({ noServer: true, perMessageDeflate: false })`, an `'upgrade'` listener that answers 404 to any path but `TELEMETRY_SOCKET_PATH` (so a wrong-path test is possible) and otherwise `handleUpgrade`; each accepted `ws` is paused at once when the sink is paused; `'message'` pushes `data.toString()` and wakes the waiters; `dropConnections` terminates each; `pause`/`resume` call `ws.pause()`/`ws.resume()`; `close` terminates all, then `server.close()`; a per-socket `'error'` no-op (a client terminating is the scenario).
- [ ] **`outbox.ts`**: `OutboxEntry = { message: TelemetryMessage; text: string }`, `push` encodes with `encodeMessage`. **`device.ts`**: `pumpOutbox` writes `entry.text`. Doc comments follow.
- [ ] **`connection.ts`** — as the spec's "Emulator connection" section:
  - `import { WebSocket } from 'ws'`; `ConnectionState` with `socket: WebSocket`; constants `KEEP_ALIVE_DELAY_MS`, `CONNECT_TIMEOUT_MS` (now the handshake timeout), `CLOSE_TIMEOUT_MS`, `RESOLVE_TIMEOUT_MS`, `SEND_HIGH_WATER_BYTES = 64 * 1024` (comment: Node's default `writableHighWaterMark`; measured in the probe), backoff constants.
  - `socketUrl(target)`: `ws://${host}:${port}${TELEMETRY_SOCKET_PATH}` with the host in brackets when it contains `:`.
  - `#connect(target, attempt)`: `new WebSocket(socketUrl(target), { perMessageDeflate: false, handshakeTimeout: this.#connectTimeoutMs })`; `'upgrade'` → `response.socket.setKeepAlive(true, KEEP_ALIVE_DELAY_MS)`; `'open'` → the `connected` state, the `connected to ingest` INFO line, `onWritable()`; `'error'` → `warn` `device socket error` (`debug` once stopped); `'close'` `(code)` → unless stopped: `warn` `device socket closed, reconnecting` with `attempt` and `closeCode`, then `#scheduleRetry`.
  - `write(text)`, the whole rule in one sketch:
    ```ts
    write(text: string): boolean {
      const state = this.#state;
      if (state.name !== 'connected' || !state.writable || state.socket.readyState !== WebSocket.OPEN) return false;
      const { socket } = state;
      let gated = false; // true only for the send that closes the gate
      socket.send(text, (error) => {
        if (error !== undefined || !gated) return; // a failed send: 'close' follows and reconnects
        const current = this.#state;
        if (current.name === 'connected' && current.socket === socket) {
          this.#state = { ...current, writable: true };
          this.#onWritable();
        }
      });
      if (socket.bufferedAmount >= SEND_HIGH_WATER_BYTES) {
        gated = true;
        this.#state = { ...state, writable: false };
      }
      return true;
    }
    ```
    The callback runs after the send that set `gated`, never before (the callback is asynchronous: `socket.write` calls back on flush, and `sendAfterClose` on the next tick — spec Research).
  - `dropConnection()`: `terminate()` in `connecting` or `connected`. `stop()`: first `#state = { name: 'stopped' }` (as today, so `write()` refuses everything from here on and the pump never sends into a closing socket), then per the previous state: `backoff` → clear the timer; `connecting` → `terminate()`, resolve; `connected` → `close(1000, 'device stopping')`, resolve on `'close'` or after `CLOSE_TIMEOUT_MS` with `terminate()` (the timer unref'd, as today); the rest resolve at once.
- [ ] **`connection.test.ts`** — the same scenarios against the `ws` sink; `frame(seq)` becomes `text(seq)` returning `encodeMessage(...)`; renamed and adjusted: "connects and sends complete messages in the order written"; "reconnects after the peer drops the connection and keeps sending"; "refuses to write while not connected"; "reports a stopped state and writes nothing after stop()"; the four DNS tests unchanged; "takes the message that reaches the high-water mark, refuses the next, and becomes writable again through the send callback after the peer reads again" — sink paused, write 16 KiB strings while `write()` returns `true` (cap 4 000), assert the last accepted one flipped `writable` to false and the next returns `false`, resume the sink, `vi.waitFor` writable; "refuses a message once its socket is terminated, before the close event arrives" — `dropConnection()` then `write()` is `false` while `state.name` is still `connected`; "abandons a handshake that never completes" — 198.51.100.1:9 with `connectTimeoutMs: 150` reaches `backoff`; "closes within its own deadline even when the peer never responds" — `stop()` while `connecting` resolves under 3 s; "goes to backoff when the target refuses the connection"; "goes to backoff when the server rejects the upgrade" — a sink and `hosts` pointing at it but with the device configured... the path is a constant, so instead start a plain `http.Server` that answers every upgrade with 404 and assert `backoff` and a `device socket error` WARN line containing `Unexpected server response: 404`; "retries on the emulator schedule, one seeded draw per retry" — unchanged, with the filter on `resolveTimeoutMs`; `ws` applies `handshakeTimeout` through `req.setTimeout` (the socket's own timer, `lib/websocket.js` `opts.timeout = opts.handshakeTimeout`), not through `globalThis.setTimeout`, so the spy records the same calls as today and the six delays stay `[5, 10, 20, 40, 80, 100]`.
- [ ] **`outbox.test.ts`**, **`device.test.ts`**, **`fleet.test.ts`**, **`main.test.ts`**: `lines()` → `messages()`, `waitForLines` → `waitForMessages`, `entry.frame` → `entry.text`; assertions otherwise unchanged.
- [ ] `.env.example`: the `INGEST_HOSTS` comment becomes `# Ingest endpoints, comma-separated host:port; every resolved address is pooled; the WebSocket path is /telemetry (default ingest:4000)`.
- [ ] Run the scoped verify, then `pnpm test`.
- [ ] Commit: `Connect emulated devices over WebSocket`.

### Task 7: Remove the newline framing from the shared package [mechanical]

**Files:** `packages/shared/src/framing.ts`, `packages/shared/src/framing.test.ts`.
**Invariant:** none touched.
**Verify:** `pnpm lint && pnpm typecheck && pnpm test` (whole tree: nothing may import the removed symbols)

- [ ] `grep -rn "FrameDecoder\|encodeFrame\|FrameTooLongError\|FrameRejection\|FrameDecodeResult" apps packages` returns only `framing.ts` and its test.
- [ ] Delete `FrameDecoder`, `FrameTooLongError`, `FrameRejection`, `FrameDecodeResult`, `encodeFrame`, `NEWLINE`, `INITIAL_TAIL_BYTES`, `NO_REJECTIONS` and their doc comments; keep `MAX_FRAME_BYTES`, `TELEMETRY_SOCKET_PATH`, `encodeMessage`, `Utf8DecodeResult`, `decodeUtf8Strict`, `STRICT_UTF8`; reword the `decodeUtf8Strict` comment ("Both places" → "The AMQP body in processing goes through this; on the device socket `ws` validates UTF-8 itself").
- [ ] Delete the decoder and `encodeFrame` tests; keep the `decodeUtf8Strict` and the Task 3 tests.
- [ ] Commit: `Remove the newline framing from the shared package`.

### Task 8: Scripted run against RabbitMQ 4.3 with WebSocket devices [integration]

**Files:** `.local/research/2026-09-13-ingest-scripted-run-ws.mjs` (not committed), this plan's header (the evidence).
**Invariant:** 2 at the ingest boundary (a broker restart or freeze republishes the ledger; duplicates are absorbed downstream) — the same scenarios as the ingest plan's Task 13, now over WebSocket.
**Verify:** the script's seven scenarios print PASS; the run's output is saved next to the script.

- [ ] Copy `.local/research/2026-09-13-ingest-scripted-run.mjs` from the main checkout's `.local/` into the worktree's `.local/research/` and replace its `net`-based device with a `ws` client that sends `encodeMessage(message)` and, for scenario 6, the two invalid texts; scenario 4 (resource alarm) reads `bufferedAmount` growth in place of `write()` returning `false`; scenario 5 (SIGTERM) asserts the devices' close code 1001.
- [ ] Build the tree (`pnpm build`) and run the script against a throwaway `rabbitmq:4.3-management` container with generated credentials passed through the environment file the script writes (never on the command line).
- [ ] Record the seven outcomes in this plan's header under **Scripted run** at ship time.

## Verification Criteria

| #   | Criterion                                                                                                                                              | How to verify                                                                                        |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| 1   | A device connects with a WebSocket upgrade on `/telemetry` and its messages reach the publisher in order                                               | `server.test.ts` 1; scripted run scenario 1 (20 messages, 20 confirms, 20 distinct ids in the queue) |
| 2   | Invalid JSON and schema violations are logged and dropped; the connection survives                                                                     | `server.test.ts` 2; scripted run scenario 6                                                          |
| 3   | A binary message closes with 1003; an oversized message closes with 1009 and a `protocol violation` line                                               | `server.test.ts` 3 and 4                                                                             |
| 4   | Nothing is read while the publisher is not ready; a full window pauses one connection, the instance window all                                         | `server.test.ts` 5, 6, 7, 8                                                                          |
| 5   | A device that stops answering pings is closed within two intervals; a paused or closing connection is never pinged                                     | `server.test.ts` 9, 10, 11, 22, 23, 24                                                               |
| 6   | SIGTERM sends close 1001, keeps reading what devices already sent, and ends leftovers at the budget                                                    | `server.test.ts` 15, 16, 17; `main.test.ts`; scripted run scenario 5                                 |
| 7   | Broker restart, deleted queue, resource alarm and frozen broker behave as in the ingest plan, over WebSocket                                           | Scripted run scenarios 2, 3, 4, 7                                                                    |
| 8   | The emulator connects, reconnects with backoff, honours backpressure through the send callback, drains on stop                                         | `connection.test.ts` (all), `device.test.ts`, `fleet.test.ts`, `main.test.ts`                        |
| 9   | Wrong path and plain HTTP requests get 404; a wrong-path device goes to backoff                                                                        | `server.test.ts` 20; `connection.test.ts` "goes to backoff when the server rejects the upgrade"      |
| 10  | The shared package no longer exports the line decoder; nothing imports it                                                                              | Task 7's grep; `pnpm typecheck`                                                                      |
| 11  | Full pre-flight green at every commit                                                                                                                  | `pnpm format:check && pnpm lint && pnpm typecheck && pnpm test` before each commit                   |
| 12  | `/readyz` still answers 503 with reason `connecting` while the broker is unreachable and `shutting_down` during the drain, unaffected by the transport | `main.test.ts`, the existing readiness assertions, kept unchanged                                    |

## Test Plan

- Per task: the scoped verify command of the task.
- Whole tree after Tasks 5, 6 and 7: `pnpm lint && pnpm typecheck && pnpm test`.
- No Compose service is needed for the automated tests (they run real sockets on port 0). The scripted run of Task 8 needs Docker for the RabbitMQ container; it is started and removed by the script.
- Full pre-flight at the end: `pnpm format:check && pnpm lint && pnpm typecheck && pnpm test`.

## Checkpoint Recovery

If interrupted mid-implementation, resume by:

1. Read this plan and the spec.
2. `git log --oneline` on `worktree-websocket-transport` for the completed commits (the commit subjects above are unique).
3. Pick up from the first task without a commit; if a task is half-done in the working tree, `git diff` shows it — finish it, do not restart it.
