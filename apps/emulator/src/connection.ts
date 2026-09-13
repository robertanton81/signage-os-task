import dns from 'node:dns/promises';

import {
  TELEMETRY_SOCKET_PATH,
  assertNever,
  backoffDelay,
  settleWithin,
  type Logger,
} from '@telemetry/shared';
import { WebSocket } from 'ws';

import type { IngestHost } from './config.js';
import type { Random } from './random.js';

/** How long the TCP connection may be idle before keepalive probes start. */
const KEEP_ALIVE_DELAY_MS = 30_000;

/**
 * How long the opening handshake may take before the attempt is abandoned: `ws`'s
 * `handshakeTimeout`, which is the request socket's inactivity timeout and so covers the TCP
 * connect as well.
 *
 * Without it a black-holed address — packets dropped rather than refused, which is what a
 * firewall rule, a stale NAT entry or an ingest replica mid-restart looks like — leaves the socket
 * in `connecting` for the operating system's own SYN retry budget, commonly 75 seconds and
 * sometimes far longer. Neither `error` nor `close` fires in that window, so the device cannot
 * reach `backoff` and cannot retry: "retry forever" would silently become "stall forever" for
 * exactly the failure this design exists to survive.
 */
const CONNECT_TIMEOUT_MS = 10_000;

/** Hard cap on waiting for the closing handshake during shutdown, before the socket is destroyed outright. */
const CLOSE_TIMEOUT_MS = 1_000;

/**
 * How long one attempt waits for its DNS lookups before it connects with what has resolved.
 *
 * `dns.lookup` is `getaddrinfo(3)` on libuv's threadpool: it has no timeout of its own, cannot be
 * cancelled, and takes however long the operating system's resolver takes (Node dns docs,
 * "Implementation considerations"). Waiting for every hostname in turn would let one slow lookup
 * hold back an address that already resolved, while the outbox fills and drops telemetry. The
 * lookups therefore run together under this deadline, which only stops the waiting: a lookup
 * that answers later finishes on its own and its answer is dropped.
 */
const RESOLVE_TIMEOUT_MS = 5_000;

/**
 * The send gate (WebSocket transport spec, decision 9): once this many bytes are queued in `ws`
 * and the socket, `write()` refuses messages until the send that crossed the mark has been
 * flushed. Node's default `writableHighWaterMark` for a socket, the point at which `socket.write`
 * itself starts returning false.
 */
const SEND_HIGH_WATER_BYTES = 64 * 1024;

/** Normal closure (RFC 6455 §7.4.1): what a stopping device sends. */
const NORMAL_CLOSURE = 1000;

/** Every address of a hostname. An IP literal comes back at once, without the resolver. */
export type LookupFn = (host: string) => Promise<readonly { address: string }[]>;

const systemLookup: LookupFn = (host) => dns.lookup(host, { all: true });

/**
 * Reconnect schedule of one device: Full Jitter in `[0, min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 **
 * attempt))` (emulator spec, decision 17; `backoffDelay` in the shared package explains the choice).
 * `attempt` is 0-based and resets on a successful connect.
 */
const BACKOFF_BASE_MS = 500;
const BACKOFF_MAX_MS = 10_000;

export type ConnectionState =
  | { name: 'idle' }
  | { name: 'resolving' }
  | { name: 'connecting'; socket: WebSocket }
  | { name: 'connected'; socket: WebSocket; writable: boolean }
  | { name: 'backoff'; attempt: number; timer: NodeJS.Timeout }
  | { name: 'stopped' };

export type DeviceConnectionOptions = {
  deviceId: string;
  hosts: readonly IngestHost[];
  random: Random;
  logger: Logger;
  /** Called when writing may proceed: on connect, and whenever the send gate reopens. */
  onWritable: () => void;
  /** Defaults to CONNECT_TIMEOUT_MS; only the tests shorten or lengthen it. */
  connectTimeoutMs?: number;
  /** Defaults to RESOLVE_TIMEOUT_MS; only the tests shorten it. */
  resolveTimeoutMs?: number;
  /** Defaults to the system resolver; the tests inject a lookup that never answers. */
  lookup?: LookupFn;
};

/** The endpoint URL for one pooled address; an IPv6 literal is bracketed (RFC 3986 §3.2.2). */
export function socketUrl(target: IngestHost): string {
  const host = target.host.includes(':') ? `[${target.host}]` : target.host;
  return `ws://${host}:${String(target.port)}${TELEMETRY_SOCKET_PATH}`;
}

/**
 * One device's WebSocket to ingest, with DNS resolution and reconnect.
 *
 * It knows about one socket and nothing about message ordering — the outbox and the pump
 * (`pumpOutbox`) live in `device.ts`. That split is what lets this class be tested on its own against a bare sink.
 */
export class DeviceConnection {
  readonly #deviceId: string;
  readonly #hosts: readonly IngestHost[];
  readonly #random: Random;
  readonly #logger: Logger;
  readonly #onWritable: () => void;
  readonly #connectTimeoutMs: number;
  readonly #resolveTimeoutMs: number;
  readonly #lookup: LookupFn;
  #state: ConnectionState = { name: 'idle' };

  constructor(options: DeviceConnectionOptions) {
    this.#deviceId = options.deviceId;
    this.#hosts = options.hosts;
    this.#random = options.random;
    this.#logger = options.logger;
    this.#onWritable = options.onWritable;
    this.#connectTimeoutMs = options.connectTimeoutMs ?? CONNECT_TIMEOUT_MS;
    this.#resolveTimeoutMs = options.resolveTimeoutMs ?? RESOLVE_TIMEOUT_MS;
    this.#lookup = options.lookup ?? systemLookup;
  }

  get state(): ConnectionState {
    return this.#state;
  }

  get isConnected(): boolean {
    return this.#state.name === 'connected';
  }

  /**
   * A method, not an inline `this.#state.name === 'stopped'` check, on purpose. After an
   * assignment TypeScript narrows the field to that exact variant and then reports a later
   * comparison as impossible — but `stop()` can run while `#resolveAndConnect` is awaiting a DNS
   * lookup, so at runtime the check is load-bearing. Reading it through a call keeps the narrowing
   * out of the way without an assertion.
   */
  #isStopped(): boolean {
    return this.#state.name === 'stopped';
  }

  start(): void {
    if (this.#isStopped()) return;
    void this.#resolveAndConnect(0);
  }

  /**
   * Whether the connection took the message.
   *
   * `true` means the message is queued for the wire and must not be written again — including the
   * message that pushed `bufferedAmount` to the send gate: that one is queued, not refused. That
   * case records `writable: false`, and the next call returns `false` until the callback of that
   * very send reports the bytes flushed; writes are in order, so every earlier send has been
   * flushed by then too (WebSocket transport spec, decision 9).
   *
   * `false` means the message was not taken and stays queued: no connected socket, the gate
   * already closed, or a socket that is no longer `OPEN`. The last case is the gap between
   * `terminate()` — a chaos drop, a reset — and the `'close'` event that moves this connection to
   * backoff; a send there fails only through its callback and its bytes go nowhere.
   */
  write(text: string): boolean {
    const state = this.#state;
    if (state.name !== 'connected' || !state.writable) return false;
    const { socket } = state;
    if (socket.readyState !== WebSocket.OPEN) return false;
    // True only for the send that closes the gate; its callback is the one that reopens it.
    let gated = false;
    socket.send(text, (error) => {
      // A failed send: the 'close' that follows moves the connection to backoff. A successful one
      // arrives as `null`, Node's stream write callback, although `@types/ws` declares `undefined`
      // (probe p17); a strict check against `undefined` would never reopen the gate.
      if (error != null || !gated) return;
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

  /** Destroys the socket and goes to backoff — what the `disconnect` and `restart` chaos modes do. */
  dropConnection(): void {
    const state = this.#state;
    if (state.name === 'connecting' || state.name === 'connected') {
      state.socket.terminate();
    }
  }

  /**
   * Moves to `stopped` first, so `write()` refuses everything from here on and the pump never sends
   * into a closing socket, then ends whatever the previous state held.
   */
  stop(): Promise<void> {
    const state = this.#state;
    this.#state = { name: 'stopped' };
    switch (state.name) {
      case 'backoff':
        clearTimeout(state.timer);
        return Promise.resolve();
      case 'connecting':
        // Aborts the handshake; the 'error' and 'close' this raises are ignored once stopped.
        state.socket.terminate();
        return Promise.resolve();
      case 'connected':
        return new Promise<void>((resolve) => {
          // `close()` is polite — the close frame goes out after the queued messages and the
          // server ends the connection once it has read the reply — but a peer that never answers
          // would hold the wait for ws's own 30 s close timer. The whole drain is supposed to be
          // bounded, so the wait is raced against a hard cap that destroys the socket outright.
          const { socket } = state;
          socket.removeAllListeners('close');
          const timer = setTimeout(() => {
            socket.terminate();
          }, CLOSE_TIMEOUT_MS);
          timer.unref();
          socket.once('close', () => {
            clearTimeout(timer);
            resolve();
          });
          socket.close(NORMAL_CLOSURE, 'device stopping');
        });
      case 'idle':
      case 'stopped':
      case 'resolving':
        return Promise.resolve();
      default:
        return assertNever(state, 'connection state');
    }
  }

  /**
   * Resolves every configured host at once, pools the addresses that answered within the deadline
   * and picks one at random.
   *
   * Re-resolving on every attempt is what spreads devices over ingest replicas and lets a device
   * find a replica that did not exist when it first connected. A host that fails to resolve is
   * skipped rather than fatal: `ENOTFOUND` is documented to cover more than "no such name" — a
   * shortage of file descriptors reports the same code — so treating it as a configuration error
   * would let a transient condition kill the process. A host still resolving at the deadline is
   * skipped for this attempt only; with no address at all the attempt fails into backoff.
   */
  async #resolveAndConnect(attempt: number): Promise<void> {
    if (this.#isStopped()) return;
    this.#state = { name: 'resolving' };

    const addresses: IngestHost[] = [];
    let deadlinePassed = false;
    const lookups = this.#hosts.map(async (entry) => {
      try {
        const resolved = await this.#lookup(entry.host);
        if (deadlinePassed) {
          this.#logger.debug(
            { deviceId: this.#deviceId, host: entry.host },
            'dns lookup answered after the deadline',
          );
          return;
        }
        for (const { address } of resolved) addresses.push({ host: address, port: entry.port });
      } catch (error) {
        const fields = { deviceId: this.#deviceId, host: entry.host, err: error };
        if (deadlinePassed) {
          this.#logger.debug(fields, 'dns lookup failed after the deadline');
        } else {
          this.#logger.warn(fields, 'dns lookup failed');
        }
      }
    });
    // Each lookup handles its own failure, so the only outcomes are resolved and timed out.
    const waited = await settleWithin(Promise.all(lookups), this.#resolveTimeoutMs);
    if (waited.outcome === 'timed_out') {
      deadlinePassed = true;
      this.#logger.warn(
        {
          deviceId: this.#deviceId,
          resolved: addresses.length,
          hosts: this.#hosts.length,
          timeoutMs: this.#resolveTimeoutMs,
        },
        'dns lookup deadline reached',
      );
    }

    // `stopped` can arrive while awaiting the lookups.
    if (this.#isStopped()) return;

    const [first, ...rest] = addresses;
    if (first === undefined) {
      this.#scheduleRetry(attempt);
      return;
    }
    this.#connect(this.#random.pick([first, ...rest]), attempt);
  }

  #connect(target: IngestHost, attempt: number): void {
    // No compression: a telemetry message is a few hundred bytes, and ingest does not offer it.
    const socket = new WebSocket(socketUrl(target), {
      perMessageDeflate: false,
      handshakeTimeout: this.#connectTimeoutMs,
    });
    this.#state = { name: 'connecting', socket };
    // A connection that succeeded resets the backoff: the next failure is a fresh problem, not a
    // continuation of the old one. Without this, a device that finally connects on attempt 8 and
    // then loses the link would wait the full ten seconds before trying again.
    let connected = false;

    socket.on('upgrade', (response) => {
      // The one place the TCP socket is reachable: a silently dead peer is detected by keepalive
      // rather than held open forever. `ws` sets no-delay itself.
      response.socket.setKeepAlive(true, KEEP_ALIVE_DELAY_MS);
    });

    socket.once('open', () => {
      if (this.#isStopped()) {
        socket.terminate();
        return;
      }
      connected = true;
      this.#state = { name: 'connected', socket, writable: true };
      this.#logger.info(
        { deviceId: this.#deviceId, address: target.host, port: target.port },
        'connected to ingest',
      );
      this.#onWritable();
    });

    socket.on('error', (error) => {
      // A refused port, a handshake timeout or a rejected upgrade; 'close' follows and reconnects.
      // Once stopped, the abort of a handshake in flight raises one too, and is only noise.
      if (this.#isStopped()) {
        this.#logger.debug({ deviceId: this.#deviceId, err: error }, 'device socket error');
      } else {
        this.#logger.warn({ deviceId: this.#deviceId, err: error }, 'device socket error');
      }
    });

    socket.once('close', (code) => {
      if (this.#isStopped()) return;
      const from = connected ? 0 : attempt;
      this.#logger.warn(
        { deviceId: this.#deviceId, attempt: from, closeCode: code },
        'device socket closed, reconnecting',
      );
      this.#scheduleRetry(from);
    });
  }

  #scheduleRetry(attempt: number): void {
    if (this.#isStopped()) return;
    const next = attempt + 1;
    const timer = setTimeout(
      () => {
        void this.#resolveAndConnect(next);
      },
      backoffDelay({
        attempt,
        baseMs: BACKOFF_BASE_MS,
        maxMs: BACKOFF_MAX_MS,
        // One draw from the seeded stream, the same number `random.range(0, ceiling)` used to take.
        random: () => this.#random.float(),
      }),
    );
    // The device retries forever; it must never be the reason a process refuses to exit.
    timer.unref();
    this.#state = { name: 'backoff', attempt: next, timer };
  }
}
