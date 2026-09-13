import dns from 'node:dns/promises';
import net from 'node:net';

import { assertNever, backoffDelay, settleWithin, type Logger } from '@telemetry/shared';

import type { IngestHost } from './config.js';
import type { Random } from './random.js';

/** How long a socket may be idle before TCP keepalive probes start. */
const KEEP_ALIVE_DELAY_MS = 30_000;

/**
 * How long a connect attempt may sit with no activity before it is abandoned.
 *
 * Without this a black-holed address — packets dropped rather than refused, which is what a
 * firewall rule, a stale NAT entry or an ingest replica mid-restart looks like — leaves the socket
 * in `connecting` for the operating system's own SYN retry budget, commonly 75 seconds and
 * sometimes far longer. Neither `error` nor `close` fires in that window, so the device cannot
 * reach `backoff` and cannot retry: "retry forever" would silently become "stall forever" for
 * exactly the failure this design exists to survive.
 */
const CONNECT_TIMEOUT_MS = 10_000;

/** Hard cap on waiting for a socket to close during shutdown, before it is destroyed outright. */
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
  | { name: 'connecting'; socket: net.Socket }
  | { name: 'connected'; socket: net.Socket; writable: boolean }
  | { name: 'backoff'; attempt: number; timer: NodeJS.Timeout }
  | { name: 'stopped' };

export type DeviceConnectionOptions = {
  deviceId: string;
  hosts: readonly IngestHost[];
  random: Random;
  logger: Logger;
  /** Called when writing may proceed: on connect, and on every drain. */
  onWritable: () => void;
  /** Defaults to CONNECT_TIMEOUT_MS; only the tests shorten or lengthen it. */
  connectTimeoutMs?: number;
  /** Defaults to RESOLVE_TIMEOUT_MS; only the tests shorten it. */
  resolveTimeoutMs?: number;
  /** Defaults to the system resolver; the tests inject a lookup that never answers. */
  lookup?: LookupFn;
};

/**
 * One device's socket to ingest, with DNS resolution and reconnect.
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

  /** Destroys the socket and goes to backoff — what the `disconnect` and `restart` chaos modes do. */
  dropConnection(): void {
    const state = this.#state;
    if (state.name === 'connecting' || state.name === 'connected') {
      state.socket.destroy();
    }
  }

  stop(): Promise<void> {
    const state = this.#state;
    this.#state = { name: 'stopped' };
    switch (state.name) {
      case 'backoff':
        clearTimeout(state.timer);
        return Promise.resolve();
      case 'connecting':
      case 'connected':
        return new Promise<void>((resolve) => {
          // `end()` is polite — it flushes what is buffered and sends FIN — but on a socket that
          // is still connecting to an unresponsive peer it can wait as long as the connect does.
          // The whole drain is supposed to be bounded, so the wait is raced against a hard cap
          // that destroys the socket outright. Without it `Fleet.shutdown()` step 5 has no
          // deadline of its own and could outlive SHUTDOWN_TIMEOUT_MS.
          const socket = state.socket;
          socket.removeAllListeners('close');
          const timer = setTimeout(() => {
            socket.destroy();
          }, CLOSE_TIMEOUT_MS);
          timer.unref();
          socket.once('close', () => {
            clearTimeout(timer);
            resolve();
          });
          socket.end();
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
    const socket = net.connect({ host: target.host, port: target.port });
    socket.setNoDelay(true);
    socket.setKeepAlive(true, KEEP_ALIVE_DELAY_MS);
    // An inactivity timeout, which during the connect phase is a connect timeout. `'timeout'`
    // does NOT sever the connection on its own — the socket must be destroyed explicitly.
    socket.setTimeout(this.#connectTimeoutMs);
    socket.once('timeout', () => {
      this.#logger.warn(
        { deviceId: this.#deviceId, address: target.host, port: target.port },
        'connect attempt timed out',
      );
      // `destroy()` produces `'close'`, which is what routes this into backoff like any other
      // failure — so a black-holed address is retried instead of stalling the device.
      socket.destroy();
    });
    this.#state = { name: 'connecting', socket };
    // A connection that succeeded resets the backoff: the next failure is a fresh problem, not a
    // continuation of the old one. Without this, a device that finally connects on attempt 8 and
    // then loses the link would wait the full ten seconds before trying again.
    let connected = false;

    socket.once('connect', () => {
      if (this.#isStopped()) {
        socket.destroy();
        return;
      }
      connected = true;
      // Established: hand liveness over to TCP keepalive. Leaving the inactivity timeout armed
      // would close a perfectly healthy connection whenever a device had nothing to say for ten
      // seconds, which the default heartbeat of thirty seconds makes routine.
      socket.setTimeout(0);
      this.#state = { name: 'connected', socket, writable: true };
      this.#logger.info(
        { deviceId: this.#deviceId, address: target.host, port: target.port },
        'connected to ingest',
      );
      this.#onWritable();
    });

    socket.on('drain', () => {
      const state = this.#state;
      if (state.name !== 'connected') return;
      this.#state = { ...state, writable: true };
      this.#onWritable();
    });

    socket.on('error', (error) => {
      this.#logger.warn({ deviceId: this.#deviceId, err: error }, 'device socket error');
    });

    socket.once('close', () => {
      if (this.#isStopped()) return;
      const from = connected ? 0 : attempt;
      this.#logger.warn(
        { deviceId: this.#deviceId, attempt: from },
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
