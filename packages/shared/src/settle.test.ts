import { afterEach, describe, expect, it, vi } from 'vitest';

import { settleWithin } from './settle.js';

describe('settleWithin', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('reports a value that arrives before the deadline and clears its timer', async () => {
    vi.useFakeTimers();
    await expect(settleWithin(Promise.resolve(42), 1_000)).resolves.toEqual({
      outcome: 'resolved',
      value: 42,
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('reports a rejection before the deadline instead of throwing', async () => {
    vi.useFakeTimers();
    const error = new Error('boom');
    await expect(settleWithin(Promise.reject(error), 1_000)).resolves.toEqual({
      outcome: 'rejected',
      error,
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('reports a timeout once the deadline passes', async () => {
    vi.useFakeTimers();
    const result = settleWithin(new Promise<number>(() => undefined), 1_000);
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(result).resolves.toEqual({ outcome: 'timed_out' });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not time out one millisecond early', async () => {
    vi.useFakeTimers();
    let settled = false;
    void settleWithin(new Promise<void>(() => undefined), 1_000).then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toBe(true);
  });
});
