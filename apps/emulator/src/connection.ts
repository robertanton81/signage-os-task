import dns from 'node:dns/promises';
import net from 'node:net';

import { assertNever, type Logger } from '@telemetry/shared';

import { backoffDelay } from './backoff.js';
import type { IngestHost } from './config.js';
import type { Random } from './random.js';

/** How long a socket may be idle before TCP keepalive probes start. */
const KEEP_ALIVE_DELAY_MS = 30_000;

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
};

/**
 * One device's socket to ingest, with DNS resolution and reconnect.
 *
 * It knows about one socket and nothing about message ordering — the outbox and the pump live in
 * `DeviceClient`. That split is what lets this class be tested on its own against a bare sink.
 */
export class DeviceConnection {
  readonly #deviceId: string;
  readonly #hosts: readonly IngestHost[];
  readonly #random: Random;
  readonly #logger: Logger;
  readonly #onWritable: () => void;
  #state: ConnectionState = { name: 'idle' };

  constructor(options: DeviceConnectionOptions) {
    this.#deviceId = options.deviceId;
    this.#hosts = options.hosts;
    this.#random = options.random;
    this.#logger = options.logger;
    this.#onWritable = options.onWritable;
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

  /** The socket's own return value, so the caller's pump can stop on backpressure. */
  write(frame: Buffer): boolean {
    const state = this.#state;
    if (state.name !== 'connected' || !state.writable) return false;
    const flushed = state.socket.write(frame);
    if (!flushed) {
      // Queued in user memory; `'drain'` will call onWritable when the buffer is free again.
      this.#state = { ...state, writable: false };
    }
    return flushed;
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
          state.socket.removeAllListeners('close');
          state.socket.once('close', () => resolve());
          state.socket.end(() => state.socket.destroy());
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
   * Resolves every configured host, pools the addresses and picks one at random.
   *
   * Re-resolving on every attempt is what spreads devices over ingest replicas and lets a device
   * find a replica that did not exist when it first connected. A host that fails to resolve is
   * skipped rather than fatal: `ENOTFOUND` is documented to cover more than "no such name" — a
   * shortage of file descriptors reports the same code — so treating it as a configuration error
   * would let a transient condition kill the process.
   */
  async #resolveAndConnect(attempt: number): Promise<void> {
    if (this.#isStopped()) return;
    this.#state = { name: 'resolving' };

    const addresses: IngestHost[] = [];
    for (const entry of this.#hosts) {
      try {
        const resolved = await dns.lookup(entry.host, { all: true });
        for (const { address } of resolved) addresses.push({ host: address, port: entry.port });
      } catch (error) {
        this.#logger.warn(
          { deviceId: this.#deviceId, host: entry.host, err: error },
          'dns lookup failed',
        );
      }
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
      backoffDelay(attempt, this.#random),
    );
    // The device retries forever; it must never be the reason a process refuses to exit.
    timer.unref();
    this.#state = { name: 'backoff', attempt: next, timer };
  }
}
