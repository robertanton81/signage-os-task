import http from 'node:http';

import type { Logger } from '@telemetry/shared';

import type { PublisherState } from './publisher-state.js';

export const READINESS_PATH = '/readyz';

/**
 * Inactivity bound for every connection to the endpoint, also one that never sends a request.
 * Node bounds only a request in progress (`headersTimeout` 60 s, `requestTimeout` 300 s) and an
 * idle keep-alive connection (`keepAliveTimeout` 5 s); `server.timeout` defaults to 0, no timeout
 * (Node 24.21.0 http docs). A socket idle for this long is destroyed; a test pins that.
 */
export const HEALTH_IDLE_TIMEOUT_MS = 10_000;

export type ReadinessReport =
  { ready: true } | { ready: false; reason: 'connecting' | 'blocked' | 'shutting_down' };

/**
 * What `/readyz` reports (ingest spec, decision 17). The instance is ready when the publisher is
 * ready — connected, confirm channel open, topology declared, not blocked — and the instance is
 * not shutting down. Shutting down wins over every publisher state; `blocked` applies only to a
 * connection that is otherwise ready; every other state reads as `connecting`.
 */
export function readinessReport({
  publisherState,
  shuttingDown,
}: {
  publisherState: PublisherState;
  shuttingDown: boolean;
}): ReadinessReport {
  if (shuttingDown) {
    return { ready: false, reason: 'shutting_down' };
  }
  if (publisherState.name !== 'ready') {
    return { ready: false, reason: 'connecting' };
  }
  return publisherState.blocked ? { ready: false, reason: 'blocked' } : { ready: true };
}

export type HealthServer = {
  /** The bound port; the one requested, or the one the kernel chose for port 0. */
  port: number;
  close(): Promise<void>;
};

export type HealthServerOptions = {
  port: number;
  /** Called on every `GET /readyz` request, so the answer always reflects the current state. */
  report: () => ReadinessReport;
  logger: Logger;
  /** Defaults to HEALTH_IDLE_TIMEOUT_MS; only the tests shorten it. */
  idleTimeoutMs?: number;
};

/**
 * A `node:http` server on all interfaces that answers `GET /readyz` with 200 or 503 and a JSON
 * body, and everything else with 404 (decision 17). All interfaces, because the Compose healthcheck
 * runs inside the container and a developer may call it through a published port. Requests are not
 * logged. The promise rejects when the port cannot be bound, so the entry point can fail fast.
 */
export function startHealthServer({
  port,
  report,
  logger,
  idleTimeoutMs = HEALTH_IDLE_TIMEOUT_MS,
}: HealthServerOptions): Promise<HealthServer> {
  const server = http.createServer((request, response) => {
    const path = (request.url ?? '').split('?', 1)[0];
    if (request.method !== 'GET' || path !== READINESS_PATH) {
      send(response, { status: 404, body: {} });
      return;
    }
    // `report` reads in-process state the types already guarantee, so a throw here is a programmer
    // error and is left to end the process through the shared lifecycle handler.
    const current = report();
    if (current.ready) {
      send(response, { status: 200, body: { status: 'ready' } });
    } else {
      send(response, { status: 503, body: { status: 'not_ready', reason: current.reason } });
    }
  });

  server.timeout = idleTimeoutMs;

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    // No host: the unspecified IPv6 address `::` when IPv6 is available, otherwise `0.0.0.0` (Node
    // net docs). A bind failure rejects, and the entry point stops the instance.
    server.listen(port, () => {
      server.off('error', reject);
      // After startup an error is logged, not thrown: a failed accept is recoverable, so `warn`.
      server.on('error', (error) => {
        logger.warn({ err: error }, 'health server error');
      });
      const address = server.address();
      const bound = typeof address === 'object' && address !== null ? address.port : port;
      resolve({ port: bound, close: () => closeServer(server) });
    });
  });
}

function send(
  response: http.ServerResponse,
  { status, body }: { status: number; body: object },
): void {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}

/**
 * `close()` stops accepting and ends idle connections, but waits for one whose request is still in
 * flight; `closeAllConnections()` ends those too (Node http docs; probe
 * `.local/research/2026-09-13-http-close-probe.mjs`). Resolves when the server has closed, also if it
 * was already closed.
 */
function closeServer(server: http.Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => {
      resolve();
    });
    server.closeAllConnections();
  });
}
