import { once } from 'node:events';
import net from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';

import { afterEach, describe, expect, it } from 'vitest';

import { startHealthServer, type HealthServer, type ReadinessReport } from './health.js';
import { createLogger, type Logger } from './logger.js';

/** Sample reasons: the server passes any reason through, these are ingest's three. */
type SampleReason = 'connecting' | 'blocked' | 'shutting_down';

const logger: Logger = createLogger({
  service: 'test',
  level: 'silent',
  destination: { write: () => undefined },
});

const started: HealthServer[] = [];

async function start(report: () => ReadinessReport<SampleReason>): Promise<HealthServer> {
  const server = await startHealthServer({ port: 0, report, logger });
  started.push(server);
  return server;
}

afterEach(async () => {
  await Promise.all(started.splice(0).map((server) => server.close()));
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
    let report: ReadinessReport<SampleReason> = { ready: false, reason: 'connecting' };
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

  it.each([
    { method: 'GET', path: '/healthz' },
    { method: 'POST', path: '/readyz' },
    { method: 'PUT', path: '/readyz' },
  ])('answers $method $path with 404 and an empty JSON body', async ({ method, path }) => {
    const health = await start(() => ({ ready: true }));

    const response = await fetch(`http://127.0.0.1:${health.port}${path}`, { method });
    const body: unknown = await response.json();

    expect(response.status).toBe(404);
    expect(response.headers.get('content-type')).toBe('application/json');
    expect(body).toEqual({});
  });

  it('answers HEAD /readyz with 404, because the probe is a GET', async () => {
    const health = await start(() => ({ ready: true }));

    const response = await fetch(readyz(health), { method: 'HEAD' });
    await response.text();

    expect(response.status).toBe(404);
    expect(response.headers.get('content-type')).toBe('application/json');
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

    // One complete request, then a second one whose headers never end, in one small write. On
    // loopback that write arrives as one chunk (true in practice, not guaranteed by TCP), so when the
    // first response arrives the server has begun parsing the second request: the connection is
    // active, not idle, and `server.close()` alone would wait for it (probe in .local/research).
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
    // The 2 s race above plus slack for a loaded machine; the default 5 s would be tight under load.
  }, 10_000);

  it('frees the port once close() has resolved', async () => {
    const health = await start(() => ({ ready: true }));
    const { port } = health;

    await health.close();

    const reopened = await startHealthServer({ port, report: () => ({ ready: true }), logger });
    started.push(reopened);
    expect(reopened.port).toBe(port);
  });

  it('closes a connection that sends nothing once the idle timeout runs out', async () => {
    const health = await startHealthServer({
      port: 0,
      report: () => ({ ready: true }),
      logger,
      idleTimeoutMs: 50,
    });
    started.push(health);
    const client = net.connect(health.port, '127.0.0.1');
    client.on('error', () => undefined);
    await once(client, 'connect');

    // A bound, not a sleep: the assertion is that the server closes the socket.
    const abort = new AbortController();
    const outcome = await Promise.race([
      once(client, 'close').then(() => 'closed by the server'),
      delay(2_000, 'still open', { signal: abort.signal }).catch(() => 'aborted'),
    ]);
    abort.abort();

    expect(outcome).toBe('closed by the server');
  });
});
