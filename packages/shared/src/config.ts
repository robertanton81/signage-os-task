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
 * Integer variable with a lower bound and a default. The default short-circuits parsing in zod 4,
 * so it is a number (the output type), not a string.
 *
 * Coercion is `Number()`, so `0x10` reads as 16 and `1e3` as 1000. Both are accepted on purpose:
 * they are what the operator wrote. `Infinity` and `1_000` are rejected as not a finite number.
 */
export function envInt(min: number, defaultValue: number) {
  if (Number.isNaN(min) || Number.isNaN(defaultValue) || defaultValue < min) {
    // Fails when the module is imported, not when a service happens to read the variable:
    // `.default()` short-circuits parsing, so an out-of-range default is never re-checked.
    throw new Error(`envInt: default ${defaultValue} is below the minimum ${min}`);
    // NaN is checked separately: every comparison against it is false, so the swap this guard
    // exists to catch would pass in both directions.
  }
  return z.coerce.number().int().min(min).default(defaultValue);
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
  SHUTDOWN_TIMEOUT_MS: envInt(0, 10_000),
};

export const rabbitmqEnv = {
  RABBITMQ_URL: z.string().min(1),
  AMQP_HEARTBEAT_S: envInt(1, 10),
};

export const mongodbEnv = {
  MONGODB_URL: z.string().min(1),
  MONGODB_DB: z.string().min(1).default('telemetry'),
  /** `1` on the standalone development database; `majority` on a replica set (decision 20). */
  MONGODB_WRITE_W: z.union([z.literal('majority'), z.coerce.number().int().min(1)]).default(1),
  MONGODB_TIMEOUT_MS: envInt(1, 5_000),
};
