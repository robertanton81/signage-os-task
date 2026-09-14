import {
  envInt,
  healthEnv,
  loadConfig,
  logLevelEnv,
  mongodbEnv,
  rabbitmqEnv,
  shutdownEnv,
} from '@telemetry/shared';
import { z } from 'zod';

/**
 * The processing environment (processing spec, decision 24). Names and defaults come from the
 * shared-contract spec's configuration table; `.env.example` documents every key.
 *
 * No explicit type annotation on purpose: `ProcessingConfig` is
 * `z.output<typeof processingEnvSchema>`, so annotating the schema with it would make the alias
 * reference itself.
 *
 * `z.object`, never `.strict()`: a service runs with hundreds of unrelated environment variables.
 */
export const processingEnvSchema = z.object({
  ...logLevelEnv,
  ...shutdownEnv,
  ...rabbitmqEnv,
  ...healthEnv,
  ...mongodbEnv,
  // Unacknowledged deliveries per instance, which is also the number of concurrent handlers. The
  // cap is the quorum-queue limit (shared-contract spec, configuration table): an operator who sets
  // more expects more, and a silent server-side cap is the misconfiguration this check exposes.
  PROCESSING_PREFETCH: envInt({ min: 1, max: 2_000, defaultValue: 50 }),
  // Consecutive transient MongoDB failures of one handler before the instance pauses its consumer
  // (processing spec, decision 12).
  PROCESSING_TRANSIENT_ATTEMPTS: envInt({ min: 1, defaultValue: 5 }),
});

export type ProcessingConfig = z.output<typeof processingEnvSchema>;

/**
 * Validates the environment once, at startup. Never wrap the call in a try/catch: an invalid
 * configuration must end the process, not run it in a possibly wrong state.
 */
export function loadProcessingConfig(env: NodeJS.ProcessEnv = process.env): ProcessingConfig {
  return loadConfig(processingEnvSchema, env);
}
