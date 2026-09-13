import { fileURLToPath } from 'node:url';

import {
  FAILURE_EXIT_CODE,
  createLifecycleHandlers,
  createLogger,
  type Logger,
} from '@telemetry/shared';

import { loadIngestConfig } from './config.js';
import { readinessReport, startHealthServer, type HealthServer } from './health.js';
import { AmqpPublisher } from './publisher.js';
import { IngestServer } from './server.js';

export const SERVICE_NAME = 'ingest';

/** How often the summary line is written (decision 22). */
export const SUMMARY_INTERVAL_MS = 10_000;

/**
 * Starts one ingest instance in the spec's startup order (section "Startup"): configuration,
 * logger, lifecycle handlers, health server, publisher, device server, summary line. No step waits
 * for the broker (decision 1): `/readyz` answers 503 until the publisher is ready.
 */
export async function main(): Promise<void> {
  // Not wrapped in try/catch on purpose: an invalid configuration must end the process, not run it
  // in a possibly wrong state. `ConfigError` names every failing variable and never its value.
  const config = loadIngestConfig();
  const logger: Logger = createLogger({ service: SERVICE_NAME, level: config.LOG_LEVEL });
  // The logger replaces RABBITMQ_URL by path redaction (shared-contract spec, decision 3).
  logger.info({ ...config }, 'ingest starting');

  // Constructors only: neither opens a connection or a port before its own step below.
  const publisher = new AmqpPublisher({
    url: config.RABBITMQ_URL,
    heartbeatSeconds: config.AMQP_HEARTBEAT_S,
    logger,
  });
  const server = new IngestServer({ config, publisher, logger });
  let shuttingDown = false;
  let health: HealthServer | undefined;

  const handlers = createLifecycleHandlers({
    logger,
    // Decision 19: readiness drops first, then the device drain, the AMQP close and the health
    // server. The whole stop takes at most SHUTDOWN_TIMEOUT_MS + AMQP_CLOSE_TIMEOUT_MS. The summary
    // interval keeps running through the drain; it is unref'd and the handler exits afterwards.
    shutdown: async () => {
      shuttingDown = true;
      await server.shutdown();
      await publisher.stop();
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
      report: () => readinessReport({ publisherState: publisher.state, shuttingDown }),
      logger,
    });
  } catch (error) {
    logger.fatal({ err: error, port: config.HEALTH_PORT }, 'health server failed to listen');
    process.exit(FAILURE_EXIT_CODE);
  }

  publisher.start();

  try {
    await server.listen();
  } catch (error) {
    logger.fatal({ err: error, port: config.INGEST_PORT }, 'device server failed to listen');
    process.exit(FAILURE_EXIT_CODE);
  }

  const summary = setInterval(() => {
    logger.info({ ...server.stats(), ...publisher.stats() }, 'summary');
  }, SUMMARY_INTERVAL_MS);
  summary.unref();
}

// Only when run directly. The tests import siblings of this module, and a top-level call would
// start a whole instance inside the test process.
if (process.argv[1] !== undefined && process.argv[1] === fileURLToPath(import.meta.url)) {
  void main();
}
