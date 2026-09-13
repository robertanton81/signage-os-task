import { z } from 'zod';

import { LOG_LEVELS } from './logger.js';

/** Thrown by loadConfig; `problems` holds one `NAME: problem` entry per failing variable. */
export class ConfigError extends Error {
  override readonly name = 'ConfigError';

  constructor(readonly problems: readonly string[]) {
    super(`Invalid configuration: ${problems.join('; ')}`);
  }
}

/**
 * The largest delay a Node timer holds. Above it `setTimeout` and `setInterval` fire after 1 ms
 * ("When delay is larger than 2147483647 or less than 1 or NaN, the delay will be set to 1",
 * timers docs) and a socket timeout is truncated to it, both with a `TimeoutOverflowWarning` on
 * stderr that no log reader sees. Every variable that becomes a timer delay is bounded by it, so a
 * shutdown budget of 2 147 483 648 ms is refused at startup instead of ending a drain at once.
 */
export const TIMER_MAX_MS = 2_147_483_647;

/**
 * The heartbeat interval travels in `connection.tune-ok` as a 16-bit field (AMQP 0-9-1 `short`;
 * amqplib 2.0.1 `lib/defs.js` writes it with `writeUInt16BE`, which throws above this), and the
 * timers derived from it in ingest — three intervals in milliseconds — stay far below TIMER_MAX_MS.
 */
export const AMQP_HEARTBEAT_MAX_S = 65_535;

export type EnvIntOptions = {
  min: number;
  /** Omitted: unbounded. Every variable that feeds a timer passes TIMER_MAX_MS or a bound derived from it. */
  max?: number;
  defaultValue: number;
};

/**
 * Integer variable with bounds and a default. The default short-circuits parsing in zod 4, so it
 * is a number (the output type), not a string. A named object, because three numbers in a row
 * would be indistinguishable at the call site (shared-contract spec, decision 14).
 *
 * Coercion is `Number()`, so `0x10` reads as 16 and `1e3` as 1000. Both are accepted on purpose:
 * they are what the operator wrote. `Infinity` and `1_000` are rejected as not a finite number.
 */
export function envInt({ min, max, defaultValue }: EnvIntOptions) {
  // Fails when the module is imported, not when a service happens to read the variable:
  // `.default()` short-circuits parsing, so an out-of-range default is never re-checked. NaN is
  // checked first: every comparison against it is false, so the swaps these guards exist to catch
  // would pass in both directions.
  if (Number.isNaN(min) || Number.isNaN(defaultValue) || (max !== undefined && Number.isNaN(max))) {
    throw new Error('envInt: a bound or the default is NaN');
  }
  if (defaultValue < min) {
    throw new Error(`envInt: default ${defaultValue} is below the minimum ${min}`);
  }
  if (max !== undefined && max < min) {
    throw new Error(`envInt: maximum ${max} is below the minimum ${min}`);
  }
  if (max !== undefined && defaultValue > max) {
    throw new Error(`envInt: default ${defaultValue} is above the maximum ${max}`);
  }
  const bounded = z.coerce.number().int().min(min);
  return (max === undefined ? bounded : bounded.max(max)).default(defaultValue);
}

/**
 * Validates `env` against `schema` once at startup. A variable that is empty or whitespace-only
 * counts as unset, so a `.env` copied from `.env.example` gets the defaults. Throws ConfigError
 * naming every missing or invalid variable.
 *
 * Call it once, at the top of the entrypoint, before anything else starts, and do not wrap it in
 * a try/catch: an invalid configuration must end the process, not run it in a possibly wrong
 * state. Compose the schema with `z.object`, never `.strict()` — a service runs with hundreds of
 * unrelated environment variables set, and a strict schema would reject every one of them.
 *
 * ConfigError names the variable and the rule, never the value: no message built here reads
 * `issue.input`, and zod's `invalid_value` text quotes the schema's ALLOWED values, not the
 * received one. That last part is why a secret must never be validated with `z.literal()` or
 * `z.enum()` — the allowed value is the secret, and it would be printed on every mismatch.
 */
export function loadConfig<S extends z.ZodType>(
  schema: S,
  env: NodeJS.ProcessEnv = process.env,
): z.output<S> {
  // Trimmed values are what gets parsed, not only what gets tested: `Number(' ')` is 0, so a stray
  // space would silently pass `.min(0)`, and a trailing newline from a mounted secret file would
  // reach the driver inside the connection string and fail far from its cause. The `undefined`
  // check is defensive about NodeJS.ProcessEnv's `string | undefined` type, not load-bearing.
  const present: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    const trimmed = value?.trim();
    if (trimmed !== undefined && trimmed !== '') {
      present[key] = trimmed;
    }
  }
  const result = schema.safeParse(present);
  if (result.success) {
    return result.data;
  }
  throw new ConfigError(
    result.error.issues.map(
      (issue) =>
        `${issue.path.length === 0 ? '(root)' : issue.path.map(String).join('.')}: ${issue.message}`,
    ),
  );
}

// Fragments shared by more than one service. Each app composes its own schema from these plus
// its own keys (shared-contract spec, decision 5); every name is documented in .env.example.

export const logLevelEnv = {
  LOG_LEVEL: z.enum(LOG_LEVELS).default('info'),
};

export const shutdownEnv = {
  SHUTDOWN_TIMEOUT_MS: envInt({ min: 0, max: TIMER_MAX_MS, defaultValue: 10_000 }),
};

/**
 * True when `value` parses with the WHATWG URL parser and names an AMQP protocol. amqplib parses
 * a string URL with `new URL()` since 1.0.2 (change log: "Replace url-parse with WHATWG URL API")
 * and rejects every other protocol (`lib/connect.js`), so this check uses the same parser and
 * cannot disagree with the client (ingest spec, decision 18). A typo then fails at startup, naming
 * the variable, instead of in an endless reconnect loop. `MONGODB_URL` is not checked this way: a
 * MongoDB connection string may list several hosts, which the URL parser rejects (shared-contract
 * spec, decision 6).
 */
function isAmqpUrl(value: string): boolean {
  try {
    const { protocol } = new URL(value);
    return protocol === 'amqp:' || protocol === 'amqps:';
  } catch {
    return false;
  }
}

export const rabbitmqEnv = {
  // Fixed message text: the value can carry a password, and a ConfigError is logged on a bad deploy.
  RABBITMQ_URL: z.string().min(1).refine(isAmqpUrl, 'must be an amqp:// or amqps:// URL'),
  AMQP_HEARTBEAT_S: envInt({ min: 1, max: AMQP_HEARTBEAT_MAX_S, defaultValue: 10 }),
};

/** Port of the HTTP readiness endpoint (ingest spec, decision 17); processing reuses it in step 5. */
export const healthEnv = {
  HEALTH_PORT: envInt({ min: 1, max: 65_535, defaultValue: 8080 }),
};

export const mongodbEnv = {
  MONGODB_URL: z.string().min(1),
  MONGODB_DB: z.string().min(1).default('telemetry'),
  /** `1` on the standalone development database; `majority` on a replica set (decision 20). */
  MONGODB_WRITE_W: z.union([z.literal('majority'), z.coerce.number().int().min(1)]).default(1),
  /** Becomes socket and server-side timeouts of the driver, so it is bounded like a timer. */
  MONGODB_TIMEOUT_MS: envInt({ min: 1, max: TIMER_MAX_MS, defaultValue: 5_000 }),
};
