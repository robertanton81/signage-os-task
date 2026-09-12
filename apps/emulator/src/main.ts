import { fileURLToPath } from 'node:url';

import { createLogger, type Logger } from '@telemetry/shared';

import { loadEmulatorConfig } from './config.js';
import { Fleet } from './fleet.js';

export const SERVICE_NAME = 'emulator';

/** Exit code for a second signal, by convention 128 + SIGINT. */
const SIGINT_EXIT_CODE = 130;

export function main(): void {
  // Not wrapped in try/catch on purpose: an invalid configuration must end the process, not run
  // it in a possibly wrong state. `ConfigError` names every failing variable and never its value.
  const config = loadEmulatorConfig();
  const logger: Logger = createLogger({ service: SERVICE_NAME, level: config.LOG_LEVEL });

  logger.info({ ...config }, 'emulator starting');

  const fleet = new Fleet({ config, logger });
  fleet.start();

  let shuttingDown = false;
  const onSignal = (signal: NodeJS.Signals) => {
    if (shuttingDown) {
      // A second signal is an operator who does not want to wait out the drain budget.
      logger.warn({ signal }, 'second signal, exiting immediately');
      process.exit(SIGINT_EXIT_CODE);
    }
    shuttingDown = true;
    logger.info({ signal }, 'shutting down');
    void fleet.shutdown().then(() => {
      logger.info('emulator stopped');
      process.exit(0);
    });
  };

  process.on('SIGTERM', onSignal);
  process.on('SIGINT', onSignal);
}

// Only when run directly. The socket tests import siblings of this module, and a top-level call
// would start a whole fleet inside the test process.
if (process.argv[1] !== undefined && process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
