import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Tests run against the current sources of the shared package; its `exports`
// (dist/) is only for runtime, so no build is needed before `pnpm test`.
const sharedSource = fileURLToPath(new URL('./packages/shared/src/index.ts', import.meta.url));

export default defineConfig({
  resolve: {
    alias: { '@telemetry/shared': sharedSource },
  },
  test: {
    environment: 'node',
    passWithNoTests: true,
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          include: ['{apps,packages}/*/src/**/*.test.ts'],
        },
      },
      {
        // Real RabbitMQ + MongoDB from docker compose; longer timeouts, one file at a time.
        extends: true,
        test: {
          name: 'integration',
          include: ['{apps,packages}/*/test/integration/**/*.test.ts'],
          testTimeout: 30_000,
          hookTimeout: 60_000,
          fileParallelism: false,
        },
      },
    ],
  },
});
