import { fileURLToPath } from 'node:url';

import { createLogger, type Logger } from '@telemetry/shared';

import { loadEmulatorConfig } from './config.js';
import { Fleet } from './fleet.js';

export const SERVICE_NAME = 'emulator';

/** Exit code for a second signal, by convention 128 + SIGINT. */
export const SIGINT_EXIT_CODE = 130;
/** Exit code for a crash the process could not have prevented. */
export const FAILURE_EXIT_CODE = 1;

export type LifecycleHandlers = {
  onSignal: (signal: NodeJS.Signals) => void;
  onUnhandledRejection: (reason: unknown) => void;
  onUncaughtException: (error: Error) => void;
};

export type LifecycleOptions = {
  logger: Logger;
  shutdown: () => Promise<void>;
  /** Injected so a test can drive the handlers without ending its own process. */
  exit: (code: number) => void;
};

/**
 * Builds the process-lifecycle handlers. A factory rather than a function that reaches for
 * `process` itself, so the logic — drain once, exit immediately on a second signal, never die
 * without a log line — is testable by calling the returned handlers directly, with no global
 * stubbing and no casts.
 *
 * The two crash handlers are not decoration. `DeviceConnection` starts its resolve-and-connect
 * cycle with `void`, and a rejection that ever escaped it would, under Node's default
 * `--unhandled-rejections=throw`, kill the process with a raw stack trace on stderr — bypassing
 * the structured logger, so the one line explaining why a container died would be the one line
 * missing from the log stream.
 */
export function createLifecycleHandlers(options: LifecycleOptions): LifecycleHandlers {
  const { logger, shutdown, exit } = options;
  let shuttingDown = false;

  return {
    onSignal: (signal) => {
      if (shuttingDown) {
        // A second signal is an operator who does not want to wait out the drain budget.
        logger.warn({ signal }, 'second signal, exiting immediately');
        exit(SIGINT_EXIT_CODE);
        return;
      }
      shuttingDown = true;
      logger.info({ signal }, 'shutting down');
      void shutdown().then(
        () => {
          logger.info('emulator stopped');
          exit(0);
        },
        (error: unknown) => {
          logger.error({ err: error }, 'shutdown failed');
          exit(FAILURE_EXIT_CODE);
        },
      );
    },
    onUnhandledRejection: (reason) => {
      logger.error({ err: reason }, 'unhandled rejection');
      exit(FAILURE_EXIT_CODE);
    },
    onUncaughtException: (error) => {
      logger.error({ err: error }, 'uncaught exception');
      exit(FAILURE_EXIT_CODE);
    },
  };
}

export function main(): void {
  // Not wrapped in try/catch on purpose: an invalid configuration must end the process, not run
  // it in a possibly wrong state. `ConfigError` names every failing variable and never its value.
  const config = loadEmulatorConfig();
  const logger: Logger = createLogger({ service: SERVICE_NAME, level: config.LOG_LEVEL });

  logger.info({ ...config }, 'emulator starting');

  const fleet = new Fleet({ config, logger });
  const handlers = createLifecycleHandlers({
    logger,
    shutdown: () => fleet.shutdown(),
    exit: (code) => process.exit(code),
  });
  process.on('SIGTERM', handlers.onSignal);
  process.on('SIGINT', handlers.onSignal);
  process.on('unhandledRejection', handlers.onUnhandledRejection);
  process.on('uncaughtException', handlers.onUncaughtException);

  fleet.start();
}

// Only when run directly. The socket tests import siblings of this module, and a top-level call
// would start a whole fleet inside the test process.
if (process.argv[1] !== undefined && process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
