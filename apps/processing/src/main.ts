import { fileURLToPath } from 'node:url';

import {
  FAILURE_EXIT_CODE,
  createLifecycleHandlers,
  createLogger,
  startHealthServer,
  type HealthServer,
  type Logger,
} from '@telemetry/shared';

import { loadProcessingConfig } from './config.js';
import { AmqpConsumer } from './consumer.js';
import { readinessReport } from './health.js';
import { MongoStore } from './store.js';

export const SERVICE_NAME = 'processing';

/** How often the summary line is written (decision 22). */
export const SUMMARY_INTERVAL_MS = 10_000;

/**
 * Starts one processing instance in the spec's startup order (decision 21): configuration, logger,
 * lifecycle handlers, health server, then the store start and the link open together; the consumer
 * registers when both report ready. No step waits for a dependency: `/readyz` answers 503 from the
 * first moment and turns green as soon as the slower dependency is up.
 */
export async function main(): Promise<void> {
  // Not wrapped in try/catch on purpose: an invalid configuration must end the process, not run it
  // in a possibly wrong state. `ConfigError` names every failing variable and never its value.
  const config = loadProcessingConfig();
  const logger: Logger = createLogger({ service: SERVICE_NAME, level: config.LOG_LEVEL });
  // The logger replaces both connection strings by path redaction (shared-contract spec, decision 3).
  logger.info({ ...config }, 'processing starting');

  // Constructors only: neither opens a connection before its own step below.
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
    store,
    logger,
  });
  /** Ends a store start still looping at shutdown, so a database that never came up does not keep the process alive. */
  const startup = new AbortController();
  let shuttingDown = false;
  let health: HealthServer | undefined;

  const handlers = createLifecycleHandlers({
    logger,
    // Decision 20: readiness drops first, then the consumer's cancel-drain-close, the MongoDB client
    // and the health server. The summary interval is unref'd and the handler exits afterwards.
    shutdown: async () => {
      shuttingDown = true;
      startup.abort();
      await consumer.stop();
      await store.close();
      await health?.close();
    },
    exit: (code) => process.exit(code),
  });
  process.on('SIGTERM', handlers.onSignal);
  process.on('SIGINT', handlers.onSignal);
  process.on('unhandledRejection', handlers.onUnhandledRejection);
  process.on('uncaughtException', handlers.onUncaughtException);

  // First, so Compose sees a 503 rather than a refused connection while the rest starts.
  try {
    health = await startHealthServer({
      port: config.HEALTH_PORT,
      report: () => readinessReport({ consumerState: consumer.state, shuttingDown }),
      logger,
    });
  } catch (error) {
    logger.fatal({ err: error, port: config.HEALTH_PORT }, 'health server failed to listen');
    process.exit(FAILURE_EXIT_CODE);
  }

  consumer.start();
  // In parallel with the link: the consumer registers only once both are ready (decision 10). The
  // only rejection is an index conflict, a deployment bug no retry fixes: one fatal line, exit 1.
  // A start aborted by the shutdown resolves 'aborted' whatever ended its attempt, so this exit
  // never competes with the lifecycle handler's.
  void store.start(startup.signal).then(
    (outcome) => {
      if (outcome === 'ready') {
        consumer.storeReady();
      }
    },
    (error: unknown) => {
      logger.fatal({ err: error }, 'index conflict');
      process.exit(FAILURE_EXIT_CODE);
    },
  );

  const summary = setInterval(() => {
    logger.info(consumer.stats(), 'summary');
  }, SUMMARY_INTERVAL_MS);
  summary.unref();
}

// Only when run directly. The tests import siblings of this module, and a top-level call would
// start a whole instance inside the test process.
if (process.argv[1] !== undefined && process.argv[1] === fileURLToPath(import.meta.url)) {
  void main();
}
