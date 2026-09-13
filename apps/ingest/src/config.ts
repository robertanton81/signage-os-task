import {
  TIMER_MAX_MS,
  envInt,
  healthEnv,
  loadConfig,
  logLevelEnv,
  rabbitmqEnv,
  shutdownEnv,
} from '@telemetry/shared';
import { z } from 'zod';

/**
 * The ingest environment (ingest spec, decision 23). Names and defaults come from the shared-contract
 * spec's configuration table; `.env.example` documents every key.
 *
 * No explicit type annotation on purpose: `IngestConfig` is `z.output<typeof ingestEnvSchema>`, so
 * annotating the schema with it would make the alias reference itself.
 *
 * `z.object`, never `.strict()`: a service runs with hundreds of unrelated environment variables.
 */
export const ingestEnvSchema = z
  .object({
    ...logLevelEnv,
    ...shutdownEnv,
    ...rabbitmqEnv,
    ...healthEnv,
    INGEST_HOST: z.string().min(1).default('0.0.0.0'),
    // Written out rather than `envInt`, because the range checks need `abort`, which `envInt` has no
    // reason to offer: nothing else cross-checks a value after its range.
    // `abort` skips the cross-check below once the port is out of range, so two equal
    // out-of-range ports are reported as range errors only, not also as a misleading clash.
    INGEST_PORT: z.coerce
      .number()
      .int()
      .min(1, { abort: true })
      .max(65_535, { abort: true })
      .default(4000),
    INGEST_MAX_UNCONFIRMED: envInt({ min: 1, defaultValue: 256 }),
    INGEST_MAX_UNCONFIRMED_TOTAL: envInt({ min: 1, defaultValue: 20_000 }),
    // A `setInterval` delay: above TIMER_MAX_MS Node fires it after 1 ms.
    INGEST_PING_INTERVAL_MS: envInt({ min: 1, max: TIMER_MAX_MS, defaultValue: 30_000 }),
  })
  .superRefine((value, ctx) => {
    // Equal ports make the second `listen` fail with EADDRINUSE, which names a port, not a
    // variable. `INGEST_MAX_UNCONFIRMED` above the instance cap is deliberately not cross-checked:
    // it only makes the per-connection cap inactive and breaks nothing (decision 23).
    if (value.INGEST_PORT === value.HEALTH_PORT) {
      ctx.addIssue({
        code: 'custom',
        // The explicit path is what makes ConfigError name a variable the operator can act on.
        path: ['INGEST_PORT'],
        message: 'must differ from HEALTH_PORT',
      });
    }
  });

export type IngestConfig = z.output<typeof ingestEnvSchema>;

/**
 * Validates the environment once, at startup. Never wrap the call in a try/catch: an invalid
 * configuration must end the process, not run it in a possibly wrong state.
 */
export function loadIngestConfig(env: NodeJS.ProcessEnv = process.env): IngestConfig {
  return loadConfig(ingestEnvSchema, env);
}
