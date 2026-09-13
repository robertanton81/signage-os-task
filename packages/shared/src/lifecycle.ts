import type { Logger } from './logger.js';

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
 * Builds the process-lifecycle handlers every service installs for SIGTERM, SIGINT,
 * `unhandledRejection` and `uncaughtException`. A factory rather than a function that reaches for
 * `process` itself, so the logic — drain once, exit immediately on a second signal, never die
 * without a log line — is testable by calling the returned handlers directly, with no global
 * stubbing and no casts.
 *
 * The two crash handlers are not decoration. The services start long-running work with `void` —
 * the emulator's resolve-and-connect cycle, the ingest publisher's connect loop — and a rejection
 * that ever escaped it would, under Node's default `--unhandled-rejections=throw`, kill the process
 * with a raw stack trace on stderr. That bypasses the structured logger, so the one line explaining
 * why a container died would be the one line missing from the log stream.
 *
 * The success line is `stopped`: every line already carries `service`.
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
          logger.info('stopped');
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
