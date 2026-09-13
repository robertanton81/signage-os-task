import net from 'node:net';

import type { Logger } from '@telemetry/shared';

import type { IngestConfig } from './config.js';
import { DeviceConnection, type CloseReason } from './connection.js';
import { Window } from './flow.js';
import type { PublishPort } from './publisher.js';

/** TCP keepalive probes start after this long without traffic (decision 1). */
export const TCP_KEEPALIVE_INITIAL_DELAY_MS = 30_000;

export type IngestServerOptions = { config: IngestConfig; publisher: PublishPort; logger: Logger };

/**
 * `received` and `rejected` are running totals over the instance's lifetime: a connection's own
 * counters die with it (decision 21), so the server adds them up when the connection closes.
 */
export type ServerStats = { open: number; reading: number; received: number; rejected: number };

export type DrainResult = { openConnections: number; unconfirmed: number };

type Drain = {
  readonly promise: Promise<DrainResult>;
  readonly resolve: (result: DrainResult) => void;
  readonly timer: NodeJS.Timeout;
  finished: boolean;
};

/**
 * The device-facing socket server (ingest spec, decisions 1–3 and 19). It listens at startup,
 * before the broker is ready, accepts every connection paused, and leaves reading to the one
 * reading rule. Connections are independent: a full connection window pauses that socket only; the
 * instance window and the publisher's readiness pause every socket (invariants 4 and 5).
 */
export class IngestServer {
  readonly #config: IngestConfig;
  readonly #publisher: PublishPort;
  readonly #logger: Logger;
  readonly #server: net.Server;
  readonly #instanceWindow: Window;
  readonly #connections = new Set<DeviceConnection>();
  #nextConnectionId = 1;
  #closedReceived = 0;
  #closedRejected = 0;
  #drain: Drain | undefined;

  constructor({ config, publisher, logger }: IngestServerOptions) {
    this.#config = config;
    this.#publisher = publisher;
    this.#logger = logger;
    this.#instanceWindow = new Window(config.INGEST_MAX_UNCONFIRMED_TOTAL);
    this.#server = net.createServer(
      {
        pauseOnConnect: true,
        keepAlive: true,
        keepAliveInitialDelay: TCP_KEEPALIVE_INITIAL_DELAY_MS,
      },
      (socket) => {
        this.#accept(socket);
      },
    );
    publisher.onReadyChange(() => {
      this.#applyRuleToAll();
    });
  }

  /** Listens on INGEST_HOST:INGEST_PORT and resolves with the bound port. A bind failure rejects. */
  listen(): Promise<{ port: number }> {
    const { INGEST_HOST, INGEST_PORT } = this.#config;
    return new Promise((resolve, reject) => {
      this.#server.once('error', reject);
      this.#server.listen(INGEST_PORT, INGEST_HOST, () => {
        this.#server.off('error', reject);
        // After startup an error is logged, not thrown: a failed accept is recoverable.
        this.#server.on('error', (error) => {
          this.#logger.warn({ err: error }, 'device server error');
        });
        const address = this.#server.address();
        const port = typeof address === 'object' && address !== null ? address.port : INGEST_PORT;
        resolve({ port });
      });
    });
  }

  /** Live connections, for tests and the summary line. */
  connections(): readonly DeviceConnection[] {
    return [...this.#connections];
  }

  stats(): ServerStats {
    let reading = 0;
    let received = this.#closedReceived;
    let rejected = this.#closedRejected;
    for (const connection of this.#connections) {
      if (connection.isReading) {
        reading += 1;
      }
      received += connection.received;
      rejected += connection.rejected;
    }
    return { open: this.#connections.size, reading, received, rejected };
  }

  /**
   * Decision 19, steps 1–4: stop accepting, half-close every connection, wait until no connection is
   * open and nothing waits for a confirm, or until SHUTDOWN_TIMEOUT_MS, then destroy the rest.
   * Idempotent: a second call returns the same promise.
   */
  shutdown(): Promise<DrainResult> {
    if (this.#drain !== undefined) {
      return this.#drain.promise;
    }
    const { promise, resolve } = Promise.withResolvers<DrainResult>();
    this.#drain = {
      promise,
      resolve,
      timer: setTimeout(() => {
        this.#endDrainAtBudget();
      }, this.#config.SHUTDOWN_TIMEOUT_MS),
      finished: false,
    };
    // `close()` stops accepting and keeps the open connections (Node net docs).
    this.#server.close();
    for (const connection of this.#connections) {
      connection.halfClose();
    }
    // Checked once at the start: when the devices were stopped first, nothing is left to wait for.
    this.#checkDrain();
    return promise;
  }

  #accept(socket: net.Socket): void {
    const connection = new DeviceConnection({
      connectionId: this.#nextConnectionId,
      socket,
      publisher: this.#publisher,
      window: new Window(this.#config.INGEST_MAX_UNCONFIRMED),
      instanceWindow: this.#instanceWindow,
      idleMs: this.#config.INGEST_SOCKET_IDLE_MS,
      logger: this.#logger,
      onWindowChange: (changed) => {
        this.#applyRule(changed);
      },
      onInstanceWindowChange: () => {
        this.#applyRuleToAll();
      },
      onMessageConfirmed: () => {
        this.#checkDrain();
      },
      onClose: (closed, reason) => {
        this.#onClose(closed, reason);
      },
    });
    this.#nextConnectionId += 1;
    this.#connections.add(connection);
    this.#logger.info(
      { connectionId: connection.connectionId, remote: connection.remote },
      'connection accepted',
    );
    this.#applyRule(connection);
  }

  #onClose(connection: DeviceConnection, reason: CloseReason): void {
    this.#connections.delete(connection);
    this.#closedReceived += connection.received;
    this.#closedRejected += connection.rejected;
    this.#logger.info(
      {
        connectionId: connection.connectionId,
        remote: connection.remote,
        lastDeviceId: connection.lastDeviceId,
        received: connection.received,
        rejected: connection.rejected,
        pendingBytes: connection.pendingBytes,
        reason,
      },
      'connection closed',
    );
    this.#checkDrain();
  }

  #applyRule(connection: DeviceConnection): void {
    connection.applyReadingRule({
      publisherReady: this.#publisher.isReady,
      instanceWindowOpen: this.#instanceWindow.isOpen,
    });
  }

  #applyRuleToAll(): void {
    for (const connection of this.#connections) {
      this.#applyRule(connection);
    }
  }

  /** Ends the drain early once no connection is open and nothing waits for a confirm. */
  #checkDrain(): void {
    const drain = this.#drain;
    if (drain === undefined || drain.finished) {
      return;
    }
    if (this.#connections.size > 0 || this.#publisher.unconfirmed > 0) {
      return;
    }
    drain.finished = true;
    clearTimeout(drain.timer);
    drain.resolve({ openConnections: 0, unconfirmed: 0 });
  }

  /** The budget ran out: one `warn` line with what is left, then the remaining sockets are destroyed. */
  #endDrainAtBudget(): void {
    const drain = this.#drain;
    if (drain === undefined || drain.finished) {
      return;
    }
    drain.finished = true;
    const result: DrainResult = {
      openConnections: this.#connections.size,
      unconfirmed: this.#publisher.unconfirmed,
    };
    this.#logger.warn(result, 'shutdown drain ended at its budget');
    for (const connection of [...this.#connections]) {
      connection.destroy('shutdown');
    }
    drain.resolve(result);
  }
}
