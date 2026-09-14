import net from 'node:net';

import { createLogger, type Logger } from '@telemetry/shared';
import {
  MongoClientClosedError,
  MongoNetworkError,
  MongoNetworkTimeoutError,
  MongoNotConnectedError,
  MongoServerError,
  MongoTopologyClosedError,
} from 'mongodb';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { StoreError } from './failure.js';
import { exampleEvents } from './fixtures.js';
import { MongoStore, describeMongoError } from './store.js';

/**
 * The store shell without a database: `describeMongoError` over the driver's own error classes
 * (their constructors are internal per the driver, so a change to them fails here first), and the
 * real driver against a closed port for the paths a unit test can reach — server selection, the
 * start loop's first attempt and its abort, the watch's abort, and a double close. Nothing here is
 * a mock of MongoDB; the database itself is Task 13's scripted run (trade-off T44).
 */

type LogLine = { msg: string; level: number; [field: string]: unknown };

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
    level: 'debug',
    destination: {
      write: (line: string) => {
        lines.push(JSON.parse(line) as LogLine);
      },
    },
  });
  return { logger, lines };
}

/** A port nothing listens on: bound once on the loopback interface, then released. */
async function closedPort(): Promise<number> {
  const server = net.createServer();
  const port = await new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve(typeof address === 'object' && address !== null ? address.port : 0);
    });
  });
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

async function storeOnClosedPort(logger: Logger): Promise<MongoStore> {
  const port = await closedPort();
  const store = new MongoStore({
    url: `mongodb://127.0.0.1:${String(port)}`,
    dbName: 'telemetry_test',
    writeW: 1,
    timeoutMs: 200,
    logger,
  });
  cleanups.push(() => store.close());
  return store;
}

describe('describeMongoError', () => {
  it.each([
    {
      label: 'a server error with a code and a code name',
      error: new MongoServerError({ code: 50, codeName: 'MaxTimeMSExpired', errmsg: 'x' }),
      expected: {
        kind: 'server',
        code: 50,
        codeName: 'MaxTimeMSExpired',
        labels: [],
        message: 'x',
      },
    },
    {
      label: 'a server error with the retryable-write label',
      error: new MongoServerError({
        code: 11600,
        errmsg: 'y',
        errorLabels: ['RetryableWriteError'],
      }),
      expected: {
        kind: 'server',
        code: 11600,
        codeName: undefined,
        labels: ['RetryableWriteError'],
        message: 'y',
      },
    },
    {
      label: 'a duplicate key error',
      error: new MongoServerError({ code: 11000, errmsg: 'E11000 duplicate key' }),
      expected: {
        kind: 'server',
        code: 11000,
        codeName: undefined,
        labels: [],
        message: 'E11000 duplicate key',
      },
    },
    {
      label: 'a network error',
      error: new MongoNetworkError('connection reset'),
      expected: { kind: 'network', message: 'connection reset' },
    },
    {
      label: 'a network timeout, a subclass of the network error',
      error: new MongoNetworkTimeoutError('socket timed out'),
      expected: { kind: 'network', message: 'socket timed out' },
    },
    {
      label: 'a message that quotes the connection string, with its userinfo removed',
      error: new MongoNetworkError('connect ECONNREFUSED mongodb://probe:PLACEHOLDER@db:27017/x'),
      expected: {
        kind: 'network',
        message: 'connect ECONNREFUSED mongodb://[redacted]@db:27017/x',
      },
    },
    {
      label: 'a closed client',
      error: new MongoClientClosedError(),
      expected: { kind: 'closed', message: expect.any(String) as string },
    },
    {
      label: 'a client that is not connected',
      error: new MongoNotConnectedError('not connected'),
      expected: { kind: 'closed', message: 'not connected' },
    },
    {
      label: 'a closed topology',
      error: new MongoTopologyClosedError(),
      expected: { kind: 'closed', message: expect.any(String) as string },
    },
    {
      label: 'a plain error',
      error: new Error('e'),
      expected: { kind: 'other', name: 'Error', message: 'e' },
    },
    {
      label: 'a value that is not an error',
      error: 'boom',
      expected: { kind: 'other', name: 'non-error', message: 'boom' },
    },
  ])('describes $label', ({ error, expected }) => {
    expect(describeMongoError(error)).toEqual(expected);
  });
});

describe('MongoStore without a database', () => {
  it('rejects a write with a server-selection StoreError when nothing listens on the port', async () => {
    const { logger } = captureLogger();
    const store = await storeOnClosedPort(logger);

    await expect(store.insertEvent(exampleEvents.status)).rejects.toSatisfy(
      (error: unknown) => error instanceof StoreError && error.failure.kind === 'server_selection',
    );
  });

  it('retries the start with a warn line per attempt and stops at once when aborted', async () => {
    // A draw of 0.999 makes the first retry wait almost the full 500 ms, so the abort below lands
    // during the sleep and not during a connect attempt, which nothing can interrupt.
    vi.spyOn(Math, 'random').mockReturnValue(0.999);
    const { logger, lines } = captureLogger();
    const store = await storeOnClosedPort(logger);
    const startup = new AbortController();

    const started = store.start(startup.signal);
    await vi.waitFor(() => {
      expect(lines.some((line) => line.msg === 'store not ready')).toBe(true);
    });
    const firstAttempt = lines.find((line) => line.msg === 'store not ready');
    expect(firstAttempt).toMatchObject({
      attempt: 0,
      failure: { kind: 'server_selection' },
    });

    const abortedAt = performance.now();
    startup.abort();
    await expect(started).resolves.toBe('aborted');
    expect(performance.now() - abortedAt).toBeLessThan(100);
    expect(lines.filter((line) => line.msg === 'store ready')).toHaveLength(0);
  });

  it('resolves the watch as aborted without a ping when its signal is already aborted', async () => {
    const { logger, lines } = captureLogger();
    const store = await storeOnClosedPort(logger);
    const aborted = new AbortController();
    aborted.abort();

    await expect(store.watch(aborted.signal)).resolves.toBe('aborted');
    expect(lines).toHaveLength(0);
  });

  it('closes a client that never connected, and closes it again without an error', async () => {
    const { logger, lines } = captureLogger();
    const store = await storeOnClosedPort(logger);

    await expect(store.close()).resolves.toBeUndefined();
    await expect(store.close()).resolves.toBeUndefined();
    expect(lines.filter((line) => line.level >= 40)).toHaveLength(0);
  });
});
