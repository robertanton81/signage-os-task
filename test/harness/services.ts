import { spawn } from 'node:child_process';
import net from 'node:net';
import { fileURLToPath } from 'node:url';

import { createLogger, startHealthServer, type Logger } from '@telemetry/shared';

import { loadIngestConfig, type IngestConfig } from '../../apps/ingest/src/config.js';
import { readinessReport as ingestReadiness } from '../../apps/ingest/src/health.js';
import { AmqpPublisher, type PublisherStats } from '../../apps/ingest/src/publisher.js';
import { IngestServer, type ServerStats } from '../../apps/ingest/src/server.js';
import { loadProcessingConfig } from '../../apps/processing/src/config.js';
import { AmqpConsumer, type ConsumerStats } from '../../apps/processing/src/consumer.js';
import { readinessReport as processingReadiness } from '../../apps/processing/src/health.js';
import { MongoStore, type StorePort, type StoreWatcher } from '../../apps/processing/src/store.js';
import type { TestEnvironment } from './environment.js';
import { LogCapture, type LogLine } from './wait.js';

/** What `GET /readyz` answered: the status and the JSON body. */
export type Readiness = { status: number; body: { status: string; reason?: string } };

const READINESS_TIMEOUT_MS = 5_000;

async function readiness(port: number): Promise<Readiness> {
  const response = await fetch(`http://127.0.0.1:${String(port)}/readyz`, {
    signal: AbortSignal.timeout(READINESS_TIMEOUT_MS),
  });
  return { status: response.status, body: (await response.json()) as Readiness['body'] };
}

export type IngestInstance = {
  /** The device WebSocket port the kernel chose. */
  port: number;
  healthPort: number;
  publisher: AmqpPublisher;
  server: IngestServer;
  logs: LogCapture;
  /** The server's and the publisher's counters together, as the summary line spreads them. */
  stats(): ServerStats & PublisherStats;
  readiness(): Promise<Readiness>;
  /** `server.shutdown()` → `publisher.stop()` → health close, once; `dispose()` calls it too. */
  stop(): Promise<void>;
};

/**
 * One ingest instance in this process, composed as `apps/ingest/src/main.ts` composes it, minus the
 * process wiring (integration spec, decision 11). Resolves once the device server listens, not once
 * the publisher is ready: a scenario that needs the broker connection waits for `publisher.isReady`.
 */
export async function startIngest(
  env: TestEnvironment,
  overrides: Record<string, string> = {},
): Promise<IngestInstance> {
  const config: IngestConfig = {
    ...loadIngestConfig({ RABBITMQ_URL: env.amqpUrl, ...overrides }),
    INGEST_HOST: '127.0.0.1',
    // The kernel picks a free port. The schema's minimum of 1 guards the environment, not a test.
    INGEST_PORT: 0,
  };
  const logs = new LogCapture(env.signal);
  const logger: Logger = createLogger({
    service: 'ingest',
    level: 'debug',
    destination: logs.destination(),
  });
  const publisher = new AmqpPublisher({
    url: config.RABBITMQ_URL,
    heartbeatSeconds: config.AMQP_HEARTBEAT_S,
    logger,
  });
  const server = new IngestServer({ config, publisher, logger });
  let shuttingDown = false;
  const health = await startHealthServer({
    port: 0,
    report: () => ingestReadiness({ publisherState: publisher.state, shuttingDown }),
    logger,
  });
  // Registered before anything connects, so a failed `listen` still stops what started.
  const stop = env.undo(async () => {
    shuttingDown = true;
    await server.shutdown();
    await publisher.stop();
    await health.close();
  }, 'ingest stop');
  publisher.start();
  const { port } = await server.listen();
  return {
    port,
    healthPort: health.port,
    publisher,
    server,
    logs,
    stats: () => ({ ...server.stats(), ...publisher.stats() }),
    readiness: () => readiness(health.port),
    stop,
  };
}

export type ProcessingInstance = {
  healthPort: number;
  consumer: AmqpConsumer;
  store: MongoStore;
  logs: LogCapture;
  stats(): ConsumerStats;
  readiness(): Promise<Readiness>;
  /** Abort the startup → `consumer.stop()` → `store.close()` → health close, once; `dispose()` calls it too. */
  stop(): Promise<void>;
};

export type StartProcessingOptions = {
  overrides?: Record<string, string>;
  /** Names the AMQP connection (`processing@<hostname>`); two instances in one test get `a` and `b`. */
  hostname?: string;
  /** Wraps the store the consumer sees; the real `MongoStore` still starts and closes (C11b). */
  wrapStore?: (store: StorePort & StoreWatcher) => StorePort & StoreWatcher;
};

/**
 * One processing instance in this process, mirroring `apps/processing/src/main.ts`: the store and
 * the link start together, the consumer registers once both are ready. Resolves once the health
 * server listens: a scenario that needs the consumer registered waits for its `consumer registered`
 * line. The database name is the test's own, so two tests never share a collection.
 */
export async function startProcessing(
  env: TestEnvironment,
  { overrides = {}, hostname, wrapStore }: StartProcessingOptions = {},
): Promise<ProcessingInstance> {
  const config = loadProcessingConfig({
    RABBITMQ_URL: env.amqpUrl,
    MONGODB_URL: env.mongoUrl,
    MONGODB_DB: env.dbName,
    ...overrides,
  });
  const logs = new LogCapture(env.signal);
  const logger: Logger = createLogger({
    service: 'processing',
    level: 'debug',
    destination: logs.destination(),
  });
  const store = new MongoStore({
    url: config.MONGODB_URL,
    dbName: config.MONGODB_DB,
    writeW: config.MONGODB_WRITE_W,
    timeoutMs: config.MONGODB_TIMEOUT_MS,
    logger,
  });
  const consumer = new AmqpConsumer({
    url: config.RABBITMQ_URL,
    heartbeatSeconds: config.AMQP_HEARTBEAT_S,
    prefetch: config.PROCESSING_PREFETCH,
    transientAttempts: config.PROCESSING_TRANSIENT_ATTEMPTS,
    shutdownTimeoutMs: config.SHUTDOWN_TIMEOUT_MS,
    store: wrapStore === undefined ? store : wrapStore(store),
    logger,
    ...(hostname === undefined ? {} : { hostname }),
  });
  /** Ends a store start still looping at stop, as the entry point does. */
  const startup = new AbortController();
  let shuttingDown = false;
  const health = await startHealthServer({
    port: 0,
    report: () => processingReadiness({ consumerState: consumer.state, shuttingDown }),
    logger,
  });
  const stop = env.undo(
    async () => {
      shuttingDown = true;
      startup.abort();
      await consumer.stop();
      await store.close();
      await health.close();
    },
    `processing ${hostname ?? 'instance'} stop`,
  );
  consumer.start();
  void store.start(startup.signal).then(
    (outcome) => {
      if (outcome === 'ready') {
        consumer.storeReady();
      }
    },
    (error: unknown) => {
      // The entry point exits 1 here; a test reads the line instead.
      logger.fatal({ err: error }, 'index conflict');
    },
  );
  return {
    healthPort: health.port,
    consumer,
    store,
    logs,
    stats: () => consumer.stats(),
    readiness: () => readiness(health.port),
    stop,
  };
}

export type Exit = { code: number | null; signal: NodeJS.Signals | null };

export type ServiceProcess = {
  logs: LogCapture;
  lines(): LogLine[];
  /** Resolves on the line with this `msg`; rejects with the diagnostics if the child ends first. */
  waitForLog(msg: string): Promise<LogLine>;
  /** Resolves on 'close': the process has ended and its stdout has been read to the end. */
  closed: Promise<Exit>;
  /** Everything the child wrote to stderr, and any stdout line that was not JSON. */
  diagnostics(): string;
  /** Sends a process signal; unrelated to the test's `AbortSignal`. */
  kill(posixSignal: NodeJS.Signals): void;
};

/**
 * The real entry point of an application as a child process, from its TypeScript sources (the
 * child-process pattern of `apps/ingest/src/main.test.ts`, shared): `node
 * --experimental-transform-types --import <app>/src/test-source-hooks.ts <app>/src/main.ts`. The
 * child's environment is exactly `variables`. A SIGKILL is registered on `env.undo` and runs only
 * while the child is still alive, so no process outlives its test.
 */
export function spawnService(
  env: TestEnvironment,
  { app, variables }: { app: 'ingest' | 'processing'; variables: Record<string, string> },
): ServiceProcess {
  const main = fileURLToPath(new URL(`../../apps/${app}/src/main.ts`, import.meta.url));
  const hooks = fileURLToPath(
    new URL(`../../apps/${app}/src/test-source-hooks.ts`, import.meta.url),
  );
  const child = spawn(
    process.execPath,
    ['--experimental-transform-types', '--import', hooks, main],
    { env: variables, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  env.undo(() => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
    }
    return Promise.resolve();
  }, `${app} child SIGKILL`);
  const logs = new LogCapture(env.signal);
  let pending = '';
  let diagnostics = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    pending += chunk;
    let index = pending.indexOf('\n');
    while (index !== -1) {
      logs.pushText(pending.slice(0, index));
      pending = pending.slice(index + 1);
      index = pending.indexOf('\n');
    }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    diagnostics += chunk;
  });
  child.once('error', (error) => {
    diagnostics += `[spawn error] ${error.message}\n`;
  });
  // 'close', not 'exit': 'exit' can fire while stdout still holds the last lines.
  const closed = new Promise<Exit>((resolve) => {
    child.once('close', (code, signal) => {
      resolve({ code, signal });
    });
  });
  const allDiagnostics = (): string => `${diagnostics}${logs.diagnostics()}`;
  return {
    logs,
    lines: () => logs.lines(),
    waitForLog: (msg) =>
      Promise.race([
        logs.waitForLine((line) => line.msg === msg),
        closed.then(({ code }) => {
          throw new Error(
            `${app} ended (code ${String(code)}) before logging "${msg}":\n${allDiagnostics()}`,
          );
        }),
      ]),
    closed,
    diagnostics: allDiagnostics,
    kill: (posixSignal) => {
      child.kill(posixSignal);
    },
  };
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
  return new Promise((resolve) => {
    server.close(() => {
      resolve();
    });
  });
}

/** Distinct free ports, taken together and released together, so no two are the same (the unit tests' pattern). */
export async function freePorts(count: number): Promise<number[]> {
  const held = Array.from({ length: count }, () => net.createServer());
  const ports = await Promise.all(held.map((server) => listen(server)));
  await Promise.all(held.map((server) => close(server)));
  return ports;
}
