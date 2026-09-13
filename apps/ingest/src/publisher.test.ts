import net from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';

import { createLogger, type Logger } from '@telemetry/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AmqpPublisher } from './publisher.js';

/**
 * `stop()` of the amqplib shell, the part of its lifecycle a test can reach without a broker (spec
 * trade-off T36): a refused port keeps the publisher in backoff, and a TCP server that never
 * answers the AMQP protocol header keeps a connect attempt pending. Neither is a mock of the broker.
 * Every rule the shell follows is the state machine's, tested in `publisher-state.test.ts`.
 */

type LogLine = { msg: string; [field: string]: unknown };

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

function startPublisher(port: number, logger: Logger): AmqpPublisher {
  const publisher = new AmqpPublisher({
    url: `amqp://127.0.0.1:${String(port)}`,
    heartbeatSeconds: 10,
    logger,
  });
  cleanups.push(() => publisher.stop());
  publisher.start();
  return publisher;
}

function count(lines: readonly LogLine[], msg: string): number {
  return lines.filter((line) => line.msg === msg).length;
}

describe('AmqpPublisher.stop without a broker', () => {
  it('stops at once from backoff, and never attempts again', async () => {
    // A draw of 0.5 makes the first retry wait 500 ms (Full Jitter, a ceiling of 1 000 ms at attempt
    // 1), so the publisher is in backoff when it is stopped, and the wait below outlasts that retry.
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const refused = net.createServer();
    const port = await listen(refused);
    await close(refused);
    const { logger, lines } = captureLogger();
    const publisher = startPublisher(port, logger);
    await vi.waitFor(() => {
      expect(count(lines, 'publisher reconnect scheduled')).toBe(1);
    });
    expect(publisher.state.name).toBe('backoff');

    const started = performance.now();
    await publisher.stop();
    expect(performance.now() - started).toBeLessThan(100);
    expect(publisher.state.name).toBe('stopped');
    expect(publisher.isReady).toBe(false);

    // A timed wait on purpose: the assertion is that the scheduled retry never runs.
    await delay(700);
    expect(lines.map((line) => line.msg)).toEqual([
      'publisher reconnect scheduled',
      'publisher stopping',
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
    const publisher = startPublisher(port, logger);
    await vi.waitFor(() => {
      expect(accepted).toHaveLength(1);
    });
    expect(publisher.state.name).toBe('connecting');

    // Bounded by the close budget at most; with no model open yet it resolves on the next turn.
    const started = performance.now();
    await publisher.stop();
    expect(performance.now() - started).toBeLessThan(100);
    expect(publisher.state.name).toBe('stopped');

    // End the attempt: amqplib's connect() rejects once its socket closes during the handshake.
    for (const socket of accepted) socket.destroy();
    await delay(100);
    expect(lines.map((line) => line.msg)).toEqual(['publisher stopping']);
  });
});
