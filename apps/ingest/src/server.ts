import http from 'node:http';
import type { Duplex } from 'node:stream';

import { MAX_FRAME_BYTES, TELEMETRY_SOCKET_PATH, type Logger } from '@telemetry/shared';
import { WebSocketServer, type WebSocket } from 'ws';

import type { IngestConfig } from './config.js';
import { DeviceConnection, type CloseReason } from './connection.js';
import { Window } from './flow.js';
import type { PublishPort } from './publisher.js';

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

type Upgrade = { request: http.IncomingMessage; socket: Duplex; head: Buffer };

function remoteOf(request: http.IncomingMessage): string {
  return `${request.socket.remoteAddress ?? 'unknown'}:${String(request.socket.remotePort ?? 0)}`;
}

/** The path of the request line; undefined when it does not parse. */
function pathOf(url: string | undefined): string | undefined {
  try {
    return new URL(url ?? '', 'http://ingest').pathname;
  } catch {
    return undefined;
  }
}

/**
 * The device-facing WebSocket server (WebSocket transport spec, decisions 4, 6 and 8; ingest spec,
 * decisions 2 and 3). An `http.Server` accepts the upgrade on `TELEMETRY_SOCKET_PATH` and answers
 * every plain request 404; `ws` completes the handshake. It listens at startup, before the broker
 * is ready, pauses every connection at once, and leaves reading to the one reading rule.
 * Connections are independent: a full connection window pauses that connection only; the instance
 * window and the publisher's readiness pause every connection (invariants 4 and 5).
 */
export class IngestServer {
  readonly #config: IngestConfig;
  readonly #publisher: PublishPort;
  readonly #logger: Logger;
  readonly #server: http.Server;
  readonly #wss: WebSocketServer;
  readonly #instanceWindow: Window;
  readonly #connections = new Set<DeviceConnection>();
  #nextConnectionId = 1;
  #closedReceived = 0;
  #closedRejected = 0;
  #drain: Drain | undefined;
  #pingTimer: NodeJS.Timeout | undefined;

  constructor({ config, publisher, logger }: IngestServerOptions) {
    this.#config = config;
    this.#publisher = publisher;
    this.#logger = logger;
    this.#instanceWindow = new Window(config.INGEST_MAX_UNCONFIRMED_TOTAL);
    this.#server = http.createServer((_request, response) => {
      // The device port serves one thing, the upgrade; a plain request is not an API.
      response.writeHead(404, { 'content-type': 'application/json' });
      response.end('{}');
    });
    // The server keeps its own set of connections, so `ws` tracks none. Compression stays off:
    // the README warns about its memory cost, and a telemetry message is a few hundred bytes.
    this.#wss = new WebSocketServer({
      noServer: true,
      maxPayload: MAX_FRAME_BYTES,
      perMessageDeflate: false,
      clientTracking: false,
    });
    // eslint-disable-next-line max-params -- Node emits 'upgrade' with exactly these three positional arguments
    this.#server.on('upgrade', (request, socket, head) => {
      this.#onUpgrade({ request, socket, head });
    });
    publisher.onReadyChange(() => {
      this.#applyRuleToAll();
    });
  }

  /** Listens on INGEST_HOST:INGEST_PORT and resolves with the bound port. A bind failure rejects. */
  listen(): Promise<{ port: number }> {
    const { INGEST_HOST, INGEST_PORT, INGEST_PING_INTERVAL_MS } = this.#config;
    return new Promise((resolve, reject) => {
      this.#server.once('error', reject);
      this.#server.listen(INGEST_PORT, INGEST_HOST, () => {
        this.#server.off('error', reject);
        // After startup an error is logged, not thrown: a failed accept is recoverable.
        this.#server.on('error', (error) => {
          this.#logger.warn({ err: error }, 'device server error');
        });
        // One interval per instance (transport spec, decision 6); unref'd like the summary line.
        this.#pingTimer = setInterval(() => {
          this.#pingAll();
        }, INGEST_PING_INTERVAL_MS);
        this.#pingTimer.unref();
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
   * Transport spec decision 8, steps 1–4: stop accepting, send close code 1001 to every open
   * connection, wait until no connection is open and nothing waits for a confirm, or until
   * SHUTDOWN_TIMEOUT_MS, then terminate the rest. Idempotent: a second call returns the same
   * promise.
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
    // `close()` stops accepting; it completes only when the last upgraded socket is gone, which
    // the drain guarantees or forces (Node http docs; transport spec, decision 8).
    this.#server.close();
    for (const connection of this.#connections) {
      connection.beginClose();
    }
    // Checked once at the start: when the devices were stopped first, nothing is left to wait for.
    this.#checkDrain();
    return promise;
  }

  /**
   * The authentication point of the design (transport spec, decision 14): a device credential
   * would be checked here, before `handleUpgrade`, and refused with 401. Today only the path is
   * checked.
   */
  #onUpgrade({ request, socket, head }: Upgrade): void {
    socket.on('error', (error) => {
      this.#logger.debug({ err: error, remote: remoteOf(request) }, 'upgrade socket error');
    });
    const path = pathOf(request.url);
    if (path !== TELEMETRY_SOCKET_PATH) {
      this.#logger.debug({ remote: remoteOf(request), path }, 'upgrade rejected');
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      socket.destroy();
      return;
    }
    this.#wss.handleUpgrade(request, socket, head, (ws) => {
      this.#accept(ws, request);
    });
  }

  #accept(ws: WebSocket, request: http.IncomingMessage): void {
    // Before any listener: nothing is read until the reading rule allows it (decision 5).
    ws.pause();
    const connection = new DeviceConnection({
      connectionId: this.#nextConnectionId,
      ws,
      remote: remoteOf(request),
      publisher: this.#publisher,
      window: new Window(this.#config.INGEST_MAX_UNCONFIRMED),
      instanceWindow: this.#instanceWindow,
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
        closeCode: connection.closeCode,
        reason,
      },
      'connection closed',
    );
    this.#checkDrain();
  }

  #pingAll(): void {
    for (const connection of this.#connections) {
      connection.checkLiveness();
    }
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
    this.#finishDrain(drain, { openConnections: 0, unconfirmed: 0 });
  }

  /** The budget ran out: one `warn` line with what is left, then the remaining connections are terminated. */
  #endDrainAtBudget(): void {
    const drain = this.#drain;
    if (drain === undefined || drain.finished) {
      return;
    }
    const result: DrainResult = {
      openConnections: this.#connections.size,
      unconfirmed: this.#publisher.unconfirmed,
    };
    this.#logger.warn(result, 'shutdown drain ended at its budget');
    for (const connection of [...this.#connections]) {
      connection.destroy('shutdown');
    }
    this.#finishDrain(drain, result);
  }

  #finishDrain(drain: Drain, result: DrainResult): void {
    drain.finished = true;
    clearTimeout(drain.timer);
    clearInterval(this.#pingTimer);
    // Detaches from the HTTP server; it closes no connection (ws 8 docs), the drain did that.
    this.#wss.close();
    drain.resolve(result);
  }
}
