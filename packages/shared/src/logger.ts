import { hostname } from 'node:os';

import {
  pino,
  stdSerializers,
  type DestinationStream,
  type Logger,
  type LoggerOptions,
} from 'pino';

import type { MessageIdentity, RawIdentity } from './identity.js';

export type { Logger };

export const LOG_LEVELS = ['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

/**
 * Config values that carry credentials (`RABBITMQ_URL` is documented in `.env.example` as
 * `amqp://<user>:<password>@host`). Redaction matches object PATHS, so this covers
 * `logger.info({ RABBITMQ_URL })` and one level of nesting. Everything else that can carry a
 * connection string — an error message, a stack, a string under another key — goes through
 * `redactUserinfo` below.
 */
const REDACTED_PATHS = ['RABBITMQ_URL', 'MONGODB_URL', '*.RABBITMQ_URL', '*.MONGODB_URL'] as const;

/**
 * `scheme://user:password@` inside any text. amqplib and the MongoDB driver embed the connection
 * string in their error messages, so without this the password would reach the log through
 * `err.message`, `err.stack` and the `msg` field pino copies an error message into.
 */
const URL_USERINFO = /([a-z][\w+.-]*:\/\/)[^\s/@]+@/gi;

/** Replaces the userinfo of every URL in `text` with `[redacted]`; the host and path are kept. */
export function redactUserinfo(text: string): string {
  return text.replace(URL_USERINFO, '$1[redacted]@');
}

/**
 * Bounded walk over plain objects and arrays; every string is passed through `redactUserinfo`.
 * The bound is also what ends a cycle. At the bound the walk fails CLOSED: it cannot prove the
 * subtree below carries no connection string, so it drops it rather than print it unwalked.
 * Cost named: a line loses detail below eight levels, which no logged object here reaches.
 */
const MAX_REDACT_DEPTH = 8;
const DROPPED = '[not redacted: depth limit]';
const UNLOGGABLE = '[unloggable value]';

function redactStrings(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') {
    return redactUserinfo(value);
  }
  if (value === null || typeof value !== 'object') {
    return value;
  }
  if (depth >= MAX_REDACT_DEPTH) {
    return DROPPED;
  }
  if (Array.isArray(value)) {
    return value.map((item: unknown) => redactStrings(item, depth + 1));
  }
  // An Error is left for the `err` serializer. A value with its own `toJSON` is serialised the
  // way JSON would serialise it and the result is redacted in turn: a `URL` prints its whole
  // `href`, userinfo included, a `Date` its ISO string, a `Buffer` an object with its bytes. A
  // `toJSON` that throws is ignored and the value is walked like any other object. Anything else
  // — a plain object, or the serialised error the standard serializer returns, which has a custom
  // prototype but no `toJSON` — is rebuilt from the same own enumerable properties that JSON
  // serialisation would read, so the line keeps its shape.
  if (value instanceof Error) {
    return value;
  }
  const { toJSON } = value as { toJSON?: unknown };
  if (typeof toJSON === 'function') {
    try {
      const json: unknown = (toJSON as () => unknown).call(value);
      return typeof json === 'string' ? redactUserinfo(json) : redactStrings(json, depth + 1);
    } catch {
      // Fall through: the object's own properties are still walked below.
    }
  }
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value)) {
    let item: unknown;
    try {
      // Reading a property runs its getter, and a getter can throw. pino wraps neither
      // `formatters` nor `serializers` nor the `logMethod` hook in a try/catch, so without this
      // the exception would leave `logger.error(...)` — normally inside the handler that is
      // reporting another error.
      item = (value as Record<string, unknown>)[key];
    } catch {
      out[key] = UNLOGGABLE;
      continue;
    }
    // JSON serialisation omits function properties; copying a `toJSON` would also re-invoke it.
    if (typeof item !== 'function') {
      out[key] = redactStrings(item, depth + 1);
    }
  }
  return out;
}

/** `redactStrings` for a whole merging object or binding set; never throws (see the getter note). */
function safeRedactObject(value: unknown): Record<string, unknown> {
  try {
    return redactStrings(value) as Record<string, unknown>;
  } catch {
    return { redaction: UNLOGGABLE };
  }
}

/** The error found at `err` on a merging object, if any. */
function errorOf(value: unknown): Error | undefined {
  if (value instanceof Error) {
    return value;
  }
  if (typeof value === 'object' && value !== null && 'err' in value && value.err instanceof Error) {
    return value.err;
  }
  return undefined;
}

const loggerOptions: Pick<LoggerOptions, 'serializers' | 'formatters' | 'hooks'> = {
  serializers: {
    // Runs after `formatters.log`, on the Error instance itself: strips the userinfo out of
    // `message`, `stack` and any nested cause the standard serializer surfaces.
    err: (error: Error) => {
      try {
        return redactStrings(stdSerializers.err(error));
      } catch {
        return { type: 'Error', message: UNLOGGABLE };
      }
    },
  },
  formatters: {
    // Runs on the merging object before serialisation: covers a connection string logged under
    // any key (`{ url }`, `{ target }`), which the path-based redaction cannot know about. Cost:
    // one pass over the merging object per line, negligible next to the JSON serialisation.
    log: (object) => safeRedactObject(object),
    // The root `base` only. A `.child()` call does NOT reach this slot: pino installs its own
    // identity formatter (`resetChildingsFormatter`, `pino/lib/proto.js:84,98-102`) on every
    // child created without an options object, so child bindings cannot be redacted here. They
    // are redacted at the call site instead — see `childWithIdentity`.
    bindings: (bindings) => safeRedactObject(bindings),
  },
  hooks: {
    // Runs before the line is built: strips every string argument (the message and format
    // arguments) and gives a bare error an explicit, stripped message. Without the latter pino
    // copies `err.message` into `msg` before any serializer sees it.
    logMethod(args, method) {
      let redacted: unknown[];
      try {
        redacted = args.map((arg: unknown) =>
          typeof arg === 'string' ? redactUserinfo(arg) : arg,
        );
        const error = errorOf(redacted[0]);
        if (error !== undefined && typeof redacted[1] !== 'string') {
          redacted.splice(1, 0, redactUserinfo(error.message));
        }
      } catch {
        redacted = [{ redaction: UNLOGGABLE }];
      }
      method.apply(this, redacted as Parameters<typeof method>);
    },
  },
};

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
 * Three things a caller must know:
 * - A shutdown handler needs no flush call, and `logger.flush()` would not give it one. The
 *   default destination is `pino.destination(1)`: a SonicBoom with `sync: false` and
 *   `minLength: 0`, so a line is handed to `fs.write` as it is logged and no user-space buffer
 *   holds it. sonic-boom 4.2.1 returns from `flush(cb)` immediately when `minLength <= 0` and
 *   calls the callback while the write is still in flight, so wrapping it in a promise waits for
 *   nothing. What protects the last lines is the exit hook pino registers for an asynchronous
 *   destination (`pino/lib/tools.js` `buildSafeSonicBoom` -> `on-exit-leak-free`). Only `exit` is
 *   registered for this destination (`tools.js:276`); it calls `flushSync`, which writes the
 *   queue with `fs.writeSync` and retries EAGAIN until a slow reader catches up. The
 *   `beforeExit` hook that flushes and ends the stream is registered only for a worker-thread
 *   transport (`transport.js:15`), which this logger does not use, so nothing runs on a natural
 *   drain that does not also run on exit. Accepted race: `flushSync`
 *   skips the one chunk `fs.write` is already writing, so a forced `process.exit()` can in
 *   principle cut it (probes of 2 000 lines and of 500 x 8 KB lines into a slow pipe reader lost
 *   nothing). `sync: true` would remove the race and make every line a blocking write; the
 *   telemetry path is not worth that.
 * - A log reader that goes away silences the service instead of stopping it: on EPIPE pino
 *   replaces `write`, `end`, `flushSync` and `destroy` with no-ops, and the process keeps
 *   running with no output at all. Health of a container cannot be judged by its log stream.
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
      ...loggerOptions,
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

/**
 * Fields are copied one by one: bindings never take an externally supplied object. The copy is
 * redacted here rather than by `formatters.bindings`, which pino does not run for a child (see
 * the note on that formatter). It is not ceremony: `rejectedMessageLogger` is given
 * `extractRawIdentity`'s output, so its `deviceId` is whatever string the device sent — the
 * schema has not validated it at that point.
 *
 * Residual, and the rule for every service: a raw `logger.child({ ... })` is NOT redacted. Never
 * put a connection string, or any value read from configuration, into child bindings; bind
 * identity fields and use `messageLogger` / `rejectedMessageLogger`.
 */
function childWithIdentity(logger: Logger, identity: RawIdentity): Logger {
  return logger.child(
    safeRedactObject({
      deviceId: identity.deviceId,
      sessionId: identity.sessionId,
      seq: identity.seq,
    }),
  );
}
