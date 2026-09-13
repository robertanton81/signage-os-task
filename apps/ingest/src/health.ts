import http from 'node:http';

import type { Logger } from '@telemetry/shared';

import type { PublisherState } from './publisher-state.js';

export const READINESS_PATH = '/readyz';

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
  /** Called on every request, so the answer always reflects the current state. */
  report: () => ReadinessReport;
  logger: Logger;
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
}: HealthServerOptions): Promise<HealthServer> {
  const server = http.createServer((request, response) => {
    const path = (request.url ?? '').split('?', 1)[0];
    if (request.method !== 'GET' || path !== READINESS_PATH) {
      send(response, { status: 404, body: {} });
      return;
    }
    const current = report();
    if (current.ready) {
      send(response, { status: 200, body: { status: 'ready' } });
    } else {
      send(response, { status: 503, body: { status: 'not_ready', reason: current.reason } });
    }
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, () => {
      server.off('error', reject);
      // After startup an error is logged, not thrown: a failed accept must not end the process.
      server.on('error', (error) => {
        logger.error({ err: error }, 'health server error');
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
