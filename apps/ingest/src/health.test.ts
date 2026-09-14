import { describe, expect, it } from 'vitest';

import { readinessReport } from './health.js';
import type { PublisherState } from './publisher-state.js';

const G = 3;
const STATES: Record<string, PublisherState> = {
  backoff: { name: 'backoff', generation: G, attempt: 1, reason: 'start' },
  connecting: { name: 'connecting', generation: G, attempt: 1, blocked: false, failed: false },
  'connecting-blocked': {
    name: 'connecting',
    generation: G,
    attempt: 1,
    blocked: true,
    failed: false,
  },
  'connecting-failed': {
    name: 'connecting',
    generation: G,
    attempt: 1,
    blocked: false,
    failed: true,
    reason: 'channel_closed',
  },
  recycling: { name: 'recycling', generation: G, attempt: 1, reason: 'nacked' },
  ready: { name: 'ready', generation: G, attempt: 0, blocked: false, readySince: 0 },
  'ready-blocked': { name: 'ready', generation: G, attempt: 0, blocked: true, readySince: 0 },
  stopped: { name: 'stopped', generation: G },
};

describe('readinessReport', () => {
  it.each([
    { key: 'backoff', expected: { ready: false, reason: 'connecting' } },
    { key: 'connecting', expected: { ready: false, reason: 'connecting' } },
    { key: 'connecting-blocked', expected: { ready: false, reason: 'connecting' } },
    { key: 'connecting-failed', expected: { ready: false, reason: 'connecting' } },
    { key: 'recycling', expected: { ready: false, reason: 'connecting' } },
    { key: 'ready', expected: { ready: true } },
    { key: 'ready-blocked', expected: { ready: false, reason: 'blocked' } },
    { key: 'stopped', expected: { ready: false, reason: 'connecting' } },
  ])('reports the expected answer for $key while running', ({ key, expected }) => {
    const publisherState = STATES[key];
    if (publisherState === undefined) throw new Error(`unknown state ${key}`);

    expect(readinessReport({ publisherState, shuttingDown: false })).toEqual(expected);
  });

  it.each(Object.keys(STATES))('reports shutting_down for %s once shutting down', (key) => {
    const publisherState = STATES[key];
    if (publisherState === undefined) throw new Error(`unknown state ${key}`);

    expect(readinessReport({ publisherState, shuttingDown: true })).toEqual({
      ready: false,
      reason: 'shutting_down',
    });
  });
});
