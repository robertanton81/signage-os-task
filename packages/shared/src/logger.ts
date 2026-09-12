import { hostname } from 'node:os';

import { pino, type DestinationStream, type Logger } from 'pino';

import type { MessageIdentity, RawIdentity } from './identity.js';

export type { Logger };

export const LOG_LEVELS = ['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

/**
 * Config values that carry credentials (`RABBITMQ_URL` is documented in `.env.example` as
 * `amqp://<user>:<password>@host`). Redaction matches object PATHS, so this covers
 * `logger.info({ RABBITMQ_URL })` and one level of nesting — it cannot reach a connection string
 * embedded inside a client's error message. Strip the userinfo before logging such an error.
 */
const REDACTED_PATHS = ['RABBITMQ_URL', 'MONGODB_URL', '*.RABBITMQ_URL', '*.MONGODB_URL'] as const;

export type CreateLoggerOptions = {
  service: string;
  level: LogLevel;
  /** Where lines go; defaults to stdout. Tests pass an object with `write(msg)`. */
  destination?: DestinationStream;
};

/**
 * JSON lines. Every line carries `service` and `hostname` (one per Compose replica) and an
 * ISO-8601 `time`; `pid` is left out because it is meaningless inside a container.
 *
 * Two things a caller must know:
 * - Writes to stdout are buffered, so a process that is about to exit (a fatal error, SIGTERM)
 *   must `await logger.flush()` first or lose its last lines.
 * - Annotate an exported binding as `Logger` imported from this package, not from `pino`:
 *   `export const logger: Logger = createLogger(...)`. Without the annotation an app that does
 *   not itself depend on pino fails to build with TS2883 (the inferred type cannot be named).
 */
export function createLogger({ service, level, destination }: CreateLoggerOptions): Logger {
  return pino(
    {
      level,
      base: { service, hostname: hostname() },
      timestamp: pino.stdTimeFunctions.isoTime,
      redact: { paths: [...REDACTED_PATHS], censor: '[redacted]' },
    },
    destination,
  );
}

/**
 * A child logger whose every line carries the message identity as separate fields
 * (consistency spec, decision 21). Takes a COMPLETE identity, so the convention "every log line
 * about a message carries the device id and the message identity" cannot be broken by accident on
 * the valid-message path. Use `rejectedMessageLogger` for input that failed to decode.
 */
export function messageLogger(logger: Logger, identity: MessageIdentity): Logger {
  return childWithIdentity(logger, identity);
}

/**
 * The same, for input that never became a valid message: `decodeTelemetryMessage` returns whatever
 * identity fields it could read, which may be none. pino omits a binding whose value is undefined,
 * so a line carries exactly the fields that were actually present.
 */
export function rejectedMessageLogger(logger: Logger, identity: RawIdentity): Logger {
  return childWithIdentity(logger, identity);
}

/** Fields are copied one by one: bindings never take an externally supplied object. */
function childWithIdentity(logger: Logger, identity: RawIdentity): Logger {
  return logger.child({
    deviceId: identity.deviceId,
    sessionId: identity.sessionId,
    seq: identity.seq,
  });
}
