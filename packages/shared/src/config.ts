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
 */
export function envInt(min: number, defaultValue: number) {
  if (defaultValue < min) {
    // Fails when the module is imported, not when a service happens to read the variable:
    // `.default()` short-circuits parsing, so an out-of-range default is never re-checked.
    throw new Error(`envInt: default ${defaultValue} is below the minimum ${min}`);
  }
  return z.coerce.number().int().min(min).default(defaultValue);
}

/**
 * Validates `env` against `schema` once at startup. A variable that is empty or whitespace-only
 * counts as unset, so a `.env` copied from `.env.example` gets the defaults. Throws ConfigError
 * naming every missing or invalid variable; the service must let that end the process.
 */
export function loadConfig<S extends z.ZodType>(
  schema: S,
  env: NodeJS.ProcessEnv = process.env,
): z.output<S> {
  const present = Object.fromEntries(
    // `trim()`, not just `!== ''`: `Number(' ')` is 0, so a stray space in a compose file or CI
    // template would silently pass `.min(0)` and set a zero timeout instead of the default.
    // The `undefined` check is defensive about NodeJS.ProcessEnv's `string | undefined` type,
    // not load-bearing: an absent key and a key set to undefined read the same through zod.
    Object.entries(env).filter(([, value]) => value !== undefined && value.trim() !== ''),
  );
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
