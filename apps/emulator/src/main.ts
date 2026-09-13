import { fileURLToPath } from 'node:url';

import { createLifecycleHandlers, createLogger, type Logger } from '@telemetry/shared';

import { loadEmulatorConfig } from './config.js';
import { Fleet } from './fleet.js';

export const SERVICE_NAME = 'emulator';

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
