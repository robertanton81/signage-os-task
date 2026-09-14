import { describe, expect, it } from 'vitest';

import type { ConsumerState } from './consumer-state.js';
import { readinessReport } from './health.js';

const G = 2;

/** Every consumer state variant, parameterised by the store flag. */
const VARIANTS: { label: string; state: (storeReady: boolean) => ConsumerState }[] = [
  {
    label: 'backoff',
    state: (storeReady) => ({ name: 'backoff', attempt: 1, generation: G, storeReady }),
  },
  {
    label: 'connecting',
    state: (storeReady) => ({ name: 'connecting', attempt: 1, generation: G, storeReady }),
  },
  {
    label: 'open/idle',
    state: (storeReady) => ({
      name: 'open',
      consumer: 'idle',
      attempt: 0,
      openedAt: 0,
      generation: G,
      storeReady,
    }),
  },
  {
    label: 'open/active',
    state: (storeReady) => ({
      name: 'open',
      consumer: 'active',
      attempt: 0,
      openedAt: 0,
      generation: G,
      storeReady,
    }),
  },
  { label: 'draining', state: (storeReady) => ({ name: 'draining', generation: G, storeReady }) },
  { label: 'stopped', state: (storeReady) => ({ name: 'stopped', generation: G, storeReady }) },
];

const WITH_FLAG = VARIANTS.flatMap(({ label, state }) =>
  [false, true].map((storeReady) => ({
    label: `${label} (store ${storeReady ? 'ready' : 'not ready'})`,
    state: state(storeReady),
  })),
);

describe('readinessReport', () => {
  it.each(WITH_FLAG)('reports shutting_down for $label once shutting down', ({ state }) => {
    expect(readinessReport({ consumerState: state, shuttingDown: true })).toEqual({
      ready: false,
      reason: 'shutting_down',
    });
  });

  it.each(VARIANTS)('reports mongodb for $label while the store is not ready', ({ state }) => {
    expect(readinessReport({ consumerState: state(false), shuttingDown: false })).toEqual({
      ready: false,
      reason: 'mongodb',
    });
  });

  it.each(VARIANTS)(
    'reports ready only for a registered consumer, connecting otherwise: $label with the store ready',
    ({ label, state }) => {
      const expected =
        label === 'open/active' ? { ready: true } : { ready: false, reason: 'connecting' };

      expect(readinessReport({ consumerState: state(true), shuttingDown: false })).toEqual(
        expected,
      );
    },
  );
});
