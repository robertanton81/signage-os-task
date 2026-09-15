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
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          include: [
            '{apps,packages}/*/src/**/*.test.ts',
            // The pure helpers of the Compose check script (scripts/compose-check-lib.mjs).
            'scripts/**/*.test.mjs',
            // The integration harness's own pure logic (the seeded load generator).
            'test/harness/**/*.test.ts',
          ],
        },
      },
      {
        // Real RabbitMQ + MongoDB from docker-compose.test.yml, started and removed by the global
        // setup (integration spec, decisions 5, 8 and 15). After the unit project: the
        // heartbeat-timed scenarios must not share the CPU with its workers. Files run one at a
        // time because pause, restart and the memory alarm are broker-wide.
        extends: true,
        test: {
          name: 'integration',
          include: ['test/integration/**/*.test.ts'],
          globalSetup: ['test/harness/global-setup.ts'],
          sequence: { groupOrder: 1 },
          fileParallelism: false,
          testTimeout: 30_000,
          hookTimeout: 60_000,
        },
      },
    ],
  },
});
