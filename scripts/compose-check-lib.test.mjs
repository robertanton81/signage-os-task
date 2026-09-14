import { describe, expect, it } from 'vitest';

import {
  countsDetail,
  countsReached,
  parseLastSummaryOpen,
  splitCoversFleet,
  waitFor,
} from './compose-check-lib.mjs';

describe('waitFor', () => {
  it('returns the first defined value without a retry', async () => {
    let calls = 0;
    const result = await waitFor({
      probe: async () => {
        calls += 1;
        return 'ready';
      },
      budgetMs: 1000,
      intervalMs: 1,
    });
    expect(result).toEqual({ ok: true, value: 'ready' });
    expect(calls).toBe(1);
  });

  it('treats a falsy value as an answer: only undefined means not yet', async () => {
    const result = await waitFor({ probe: async () => 0, budgetMs: 1000, intervalMs: 1 });
    expect(result).toEqual({ ok: true, value: 0 });
  });

  it('counts a throwing probe as not yet and keeps polling', async () => {
    let calls = 0;
    const result = await waitFor({
      probe: async () => {
        calls += 1;
        if (calls < 3) throw new Error('not yet');
        return calls;
      },
      budgetMs: 1000,
      intervalMs: 1,
    });
    expect(result).toEqual({ ok: true, value: 3 });
    expect(calls).toBe(3);
  });

  it('reports the last error when the budget runs out', async () => {
    let calls = 0;
    const result = await waitFor({
      probe: async () => {
        calls += 1;
        throw new Error(`boom ${String(calls)}`);
      },
      budgetMs: 20,
      intervalMs: 1,
    });
    expect(result).toEqual({ ok: false, detail: `timed out; last error: boom ${String(calls)}` });
    expect(calls).toBeGreaterThan(1);
  });

  it('reports a plain timeout when the probe never answered and never threw', async () => {
    const result = await waitFor({ probe: async () => undefined, budgetMs: 20, intervalMs: 1 });
    expect(result).toEqual({ ok: false, detail: 'timed out' });
  });
});

describe('countsReached', () => {
  it('passes with one state document per device and at least one event', () => {
    expect(countsReached({ counts: { state: 10, events: 21, alerts: 0 }, devices: 10 })).toBe(true);
  });

  it('fails while a device is missing', () => {
    expect(countsReached({ counts: { state: 9, events: 21, alerts: 0 }, devices: 10 })).toBe(false);
  });

  it('fails on a surplus document', () => {
    expect(countsReached({ counts: { state: 11, events: 21, alerts: 0 }, devices: 10 })).toBe(
      false,
    );
  });

  it('fails without an event', () => {
    expect(countsReached({ counts: { state: 10, events: 0, alerts: 0 }, devices: 10 })).toBe(false);
  });
});

describe('countsDetail', () => {
  const counts = { state: 10, events: 21, alerts: 1 };

  it('renders the counts and the expectation on a pass', () => {
    expect(countsDetail({ counts, devices: 10, failure: undefined })).toBe(
      'device_state=10 events=21 alerts=1 expected_devices=10',
    );
  });

  it('says that nothing was read when no poll answered', () => {
    expect(countsDetail({ counts: undefined, devices: 10, failure: 'timed out' })).toBe(
      'no counts read expected_devices=10; timed out',
    );
  });

  it('appends the failure and, on a surplus, the leftover-data hint', () => {
    expect(
      countsDetail({
        counts: { state: 12, events: 21, alerts: 0 },
        devices: 10,
        failure: 'timed out',
      }),
    ).toBe(
      'device_state=12 events=21 alerts=0 expected_devices=10; timed out; more documents than devices: a previous run is still in the volume, reset with docker compose down -v',
    );
  });

  it('appends the failure without the hint on a shortfall', () => {
    expect(
      countsDetail({
        counts: { state: 7, events: 21, alerts: 0 },
        devices: 10,
        failure: 'timed out',
      }),
    ).toBe('device_state=7 events=21 alerts=0 expected_devices=10; timed out');
  });
});

describe('parseLastSummaryOpen', () => {
  const summary = (open) =>
    JSON.stringify({ level: 30, service: 'ingest', open, reading: open, msg: 'summary' });

  it('reads open from the last summary line, not the first', () => {
    const log = [
      JSON.stringify({ level: 30, msg: 'listening' }),
      summary(3),
      JSON.stringify({ level: 30, msg: 'connection opened' }),
      summary(5),
      '',
    ].join('\n');
    expect(parseLastSummaryOpen(log)).toBe(5);
  });

  it('returns undefined when the replica has written no summary line yet', () => {
    expect(parseLastSummaryOpen(`${JSON.stringify({ level: 30, msg: 'listening' })}\n`)).toBe(
      undefined,
    );
  });
});

describe('splitCoversFleet', () => {
  it('passes when every replica holds devices and the split sums to the fleet', () => {
    expect(splitCoversFleet({ split: [5, 5], devices: 10 })).toBe(true);
  });

  it('fails when one replica holds no device', () => {
    expect(splitCoversFleet({ split: [10, 0], devices: 10 })).toBe(false);
  });

  it('fails while a replica has no summary line yet', () => {
    expect(splitCoversFleet({ split: [10, undefined], devices: 10 })).toBe(false);
  });

  it('fails when the split does not sum to the fleet', () => {
    expect(splitCoversFleet({ split: [4, 5], devices: 10 })).toBe(false);
  });
});
