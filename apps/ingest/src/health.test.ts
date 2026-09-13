import { once } from 'node:events';
import net from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';

import { createLogger, type Logger } from '@telemetry/shared';
import { afterEach, describe, expect, it } from 'vitest';

import {
  readinessReport,
  startHealthServer,
  type HealthServer,
  type ReadinessReport,
} from './health.js';
import type { PublisherState } from './publisher-state.js';

const logger: Logger = createLogger({
  service: 'test',
  level: 'silent',
  destination: { write: () => undefined },
});

const started: HealthServer[] = [];

async function start(report: () => ReadinessReport): Promise<HealthServer> {
  const server = await startHealthServer({ port: 0, report, logger });
  started.push(server);
  return server;
}

afterEach(async () => {
  await Promise.all(started.splice(0).map((server) => server.close()));
});

const G = 3;
const STATES: Record<string, PublisherState> = {
  backoff: { name: 'backoff', generation: G, attempt: 1, reason: 'start' },
  connecting: { name: 'connecting', generation: G, attempt: 1, blocked: false, failed: false },
  'connecting-blocked': {
    name: 'connecting',
    generation: G,
    attempt: 1,
    blocked: true,
    failed: false,
  },
  'connecting-failed': {
    name: 'connecting',
    generation: G,
    attempt: 1,
    blocked: false,
    failed: true,
    reason: 'channel_closed',
  },
  recycling: { name: 'recycling', generation: G, attempt: 1, reason: 'nacked' },
  ready: { name: 'ready', generation: G, attempt: 0, blocked: false, readySince: 0 },
  'ready-blocked': { name: 'ready', generation: G, attempt: 0, blocked: true, readySince: 0 },
  stopped: { name: 'stopped', generation: G },
};

describe('readinessReport', () => {
  it.each([
    { key: 'backoff', expected: { ready: false, reason: 'connecting' } },
    { key: 'connecting', expected: { ready: false, reason: 'connecting' } },
    { key: 'connecting-blocked', expected: { ready: false, reason: 'connecting' } },
    { key: 'connecting-failed', expected: { ready: false, reason: 'connecting' } },
    { key: 'recycling', expected: { ready: false, reason: 'connecting' } },
    { key: 'ready', expected: { ready: true } },
    { key: 'ready-blocked', expected: { ready: false, reason: 'blocked' } },
    { key: 'stopped', expected: { ready: false, reason: 'connecting' } },
  ])('reports $expected for $key while running', ({ key, expected }) => {
    const publisherState = STATES[key];
    if (publisherState === undefined) throw new Error(`unknown state ${key}`);

    expect(readinessReport({ publisherState, shuttingDown: false })).toEqual(expected);
  });

  it.each(Object.keys(STATES))('reports shutting_down for %s once shutting down', (key) => {
    const publisherState = STATES[key];
    if (publisherState === undefined) throw new Error(`unknown state ${key}`);

    expect(readinessReport({ publisherState, shuttingDown: true })).toEqual({
      ready: false,
      reason: 'shutting_down',
    });
  });
});

describe('startHealthServer', () => {
  const readyz = (server: HealthServer): string => `http://127.0.0.1:${server.port}/readyz`;

  it('answers GET /readyz with 200 and a JSON body while ready', async () => {
    const health = await start(() => ({ ready: true }));

    const response = await fetch(readyz(health));
    const body: unknown = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/json');
    expect(body).toEqual({ status: 'ready' });
  });

  it.each(['connecting', 'blocked', 'shutting_down'] as const)(
    'answers 503 with the reason %s while not ready',
    async (reason) => {
      const health = await start(() => ({ ready: false, reason }));

      const response = await fetch(readyz(health));
      const body: unknown = await response.json();

      expect(response.status).toBe(503);
      expect(response.headers.get('content-type')).toBe('application/json');
      expect(body).toEqual({ status: 'not_ready', reason });
    },
  );

  it('asks for the report on every request, not once at start', async () => {
    let report: ReadinessReport = { ready: false, reason: 'connecting' };
    const health = await start(() => report);

    const before = await fetch(readyz(health));
    await before.text();
    report = { ready: true };
    const after = await fetch(readyz(health));
    await after.text();

    expect([before.status, after.status]).toEqual([503, 200]);
  });

  it('answers /readyz with a query string, as a probe may add one', async () => {
    const health = await start(() => ({ ready: true }));

    const response = await fetch(`${readyz(health)}?probe=compose`);
    await response.text();

    expect(response.status).toBe(200);
  });

  it('answers 404 with an empty JSON body to another path and to another method', async () => {
    const health = await start(() => ({ ready: true }));

    const otherPath = await fetch(`http://127.0.0.1:${health.port}/healthz`);
    const otherPathBody: unknown = await otherPath.json();
    const otherMethod = await fetch(readyz(health), { method: 'POST' });
    const otherMethodBody: unknown = await otherMethod.json();

    expect([otherPath.status, otherMethod.status]).toEqual([404, 404]);
    expect([otherPathBody, otherMethodBody]).toEqual([{}, {}]);
  });

  it('rejects when the port is already in use, so the entry point can fail fast', async () => {
    const first = await start(() => ({ ready: true }));

    await expect(
      startHealthServer({ port: first.port, report: () => ({ ready: true }), logger }),
    ).rejects.toMatchObject({ code: 'EADDRINUSE' });
  });

  it('closes while a client holds a request that is still in flight', async () => {
    const health = await start(() => ({ ready: true }));
    const client = net.connect(health.port, '127.0.0.1');
    client.on('error', () => undefined);
    await once(client, 'connect');

    // One complete request, then a second one whose headers never end. When the first response
    // arrives, the server has begun parsing the second request, so this connection is active, not
    // idle: `server.close()` alone would wait for it (probe .local/research/2026-09-13-http-close-probe.mjs).
    const firstResponse = once(client, 'data');
    client.write(
      'GET /readyz HTTP/1.1\r\nHost: localhost\r\n\r\nGET /readyz HTTP/1.1\r\nHost: localhost\r\n',
    );
    await firstResponse;
    const clientClosed = once(client, 'close');

    // A bound, not a sleep: the assertion is that close() finishes, and a hang must fail clearly.
    const abort = new AbortController();
    const outcome = await Promise.race([
      health.close().then(() => 'closed'),
      delay(2_000, 'still open', { signal: abort.signal }).catch(() => 'aborted'),
    ]);
    abort.abort();

    expect(outcome).toBe('closed');
    await clientClosed;
  });
});
