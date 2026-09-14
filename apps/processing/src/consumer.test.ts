import net from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';

import { createLogger, type Logger } from '@telemetry/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AmqpConsumer } from './consumer.js';
import type { StoreWatcher } from './store.js';
import { TestStore } from './test-store.js';

/**
 * `stop()` and the store flag of the amqplib shell, the part of its lifecycle a test can reach
 * without a broker (spec trade-off T44): a refused port keeps the consumer in backoff, and a TCP
 * server that never answers the AMQP protocol header keeps a connect attempt pending. Neither is a
 * mock of the broker. Every rule the shell follows is the state machine's, tested in
 * `consumer-state.test.ts`; the database paths are Task 13's scripted run.
 */

type LogLine = { msg: string; [field: string]: unknown };

/** The store port plus a watch that never resolves: no test here reaches a pause. */
class IdleStore extends TestStore implements StoreWatcher {
  watch(): Promise<'ready' | 'aborted'> {
    return new Promise(() => undefined);
  }
}

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
  vi.restoreAllMocks();
});

function captureLogger(): { logger: Logger; lines: LogLine[] } {
  const lines: LogLine[] = [];
  const logger = createLogger({
    service: 'test',
    level: 'info',
    destination: {
      write: (line: string) => {
        lines.push(JSON.parse(line) as LogLine);
      },
    },
  });
  return { logger, lines };
}

function listen(server: net.Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve(typeof address === 'object' && address !== null ? address.port : 0);
    });
  });
}

function close(server: net.Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

function newConsumer(port: number, logger: Logger): AmqpConsumer {
  const consumer = new AmqpConsumer({
    url: `amqp://127.0.0.1:${String(port)}`,
    heartbeatSeconds: 10,
    prefetch: 50,
    transientAttempts: 5,
    shutdownTimeoutMs: 500,
    store: new IdleStore(),
    logger,
  });
  cleanups.push(() => consumer.stop());
  return consumer;
}

function count(lines: readonly LogLine[], msg: string): number {
  return lines.filter((line) => line.msg === msg).length;
}

describe('AmqpConsumer without a broker', () => {
  it('stops at once from backoff, and never attempts again', async () => {
    // A draw of 0.5 makes the first retry wait 500 ms (Full Jitter, a ceiling of 1 000 ms at attempt
    // 1), so the consumer is in backoff when it is stopped, and the wait below outlasts that retry.
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const refused = net.createServer();
    const port = await listen(refused);
    await close(refused);
    const { logger, lines } = captureLogger();
    const consumer = newConsumer(port, logger);
    consumer.start();
    await vi.waitFor(() => {
      expect(count(lines, 'consumer reconnect scheduled')).toBe(1);
    });
    expect(lines.find((line) => line.msg === 'consumer reconnect scheduled')).toMatchObject({
      reason: 'connect_failed',
      attempt: 1,
      delayMs: expect.any(Number) as number,
    });
    expect(consumer.state.name).toBe('backoff');

    const started = performance.now();
    await consumer.stop();
    expect(performance.now() - started).toBeLessThan(100);
    expect(consumer.state.name).toBe('stopped');
    expect(consumer.stats().registered).toBe(false);

    // A timed wait on purpose: the assertion is that the scheduled retry never runs.
    await delay(700);
    expect(lines.map((line) => line.msg)).toEqual([
      'consumer reconnect scheduled',
      'consumer stopping',
    ]);
  });

  it('stops during a connect attempt without waiting for it, and the abandoned attempt reports nothing', async () => {
    const accepted: net.Socket[] = [];
    const silent = net.createServer((socket) => {
      socket.on('error', () => undefined);
      accepted.push(socket);
    });
    const port = await listen(silent);
    cleanups.push(async () => {
      for (const socket of accepted) socket.destroy();
      await close(silent);
    });
    const { logger, lines } = captureLogger();
    const consumer = newConsumer(port, logger);
    consumer.start();
    await vi.waitFor(() => {
      expect(accepted).toHaveLength(1);
    });
    expect(consumer.state.name).toBe('connecting');

    // Bounded by the close budget at most; with no link open yet it resolves on the next turn.
    const started = performance.now();
    await consumer.stop();
    expect(performance.now() - started).toBeLessThan(100);
    expect(consumer.state.name).toBe('stopped');

    // End the attempt: amqplib's connect() rejects once its socket closes during the handshake.
    for (const socket of accepted) socket.destroy();
    await delay(100);
    expect(lines.map((line) => line.msg)).toEqual(['consumer stopping']);
  });

  it('records the store as ready before any link exists, without registering a consumer', async () => {
    const refused = net.createServer();
    const port = await listen(refused);
    await close(refused);
    const { logger } = captureLogger();
    const consumer = newConsumer(port, logger);

    consumer.storeReady();

    expect(consumer.state.storeReady).toBe(true);
    expect(consumer.stats().registered).toBe(false);
    expect(consumer.state.name).toBe('backoff');
  });

  it('reports zero counters, no pause and generation 0 before it starts', async () => {
    const refused = net.createServer();
    const port = await listen(refused);
    await close(refused);
    const { logger } = captureLogger();
    const consumer = newConsumer(port, logger);

    expect(consumer.stats()).toEqual({
      received: 0,
      acked: 0,
      created: 0,
      applied: 0,
      stale: 0,
      duplicate: 0,
      alerts: 0,
      gaps: 0,
      rejected: 0,
      failed: 0,
      retries: 0,
      returned: 0,
      abandoned: 0,
      inFlight: 0,
      paused: false,
      generation: 0,
      registered: false,
    });
  });
});
