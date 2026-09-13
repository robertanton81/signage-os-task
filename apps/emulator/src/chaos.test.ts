import {
  CONTRACT_VERSION,
  TIMER_MAX_MS,
  messageIdentity,
  type TelemetryMessage,
} from '@telemetry/shared';
import { describe, expect, it } from 'vitest';

import {
  CHAOS_INTERVAL_MAX_MS,
  CHAOS_MODES,
  ChaosPolicy,
  parseChaosModes,
  type ChaosMode,
} from './chaos.js';
import { createRandom, type Random } from './random.js';

function message(seq: number): TelemetryMessage {
  return {
    v: CONTRACT_VERSION,
    deviceId: 'dev-0001',
    sessionId: 1_700_000_000_000,
    seq,
    occurredAt: 1_700_000_000_000,
    type: 'metrics',
    payload: { temperatureC: 40, cpuPercent: 10, ramPercent: 50 },
  };
}

function policy(modes: readonly ChaosMode[], percent = 100) {
  return new ChaosPolicy({ modes, percent, intervalMs: 60_000, random: createRandom(11) });
}

describe('parseChaosModes', () => {
  it('trims entries and drops empties', () => {
    expect(parseChaosModes('duplicate, restart ,')).toEqual({
      ok: true,
      value: ['duplicate', 'restart'],
    });
  });

  it('returns an empty list for an empty value', () => {
    expect(parseChaosModes('')).toEqual({ ok: true, value: [] });
  });

  it('collapses duplicates', () => {
    expect(parseChaosModes('duplicate,duplicate')).toEqual({ ok: true, value: ['duplicate'] });
  });

  it('rejects an unknown name without echoing it', () => {
    const result = parseChaosModes('out_of_order');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    // The message must name the valid modes so an operator can fix the typo...
    for (const mode of CHAOS_MODES) expect(result.message).toContain(mode);
    // ...but must not repeat what was received: a config error is logged, and a value read from
    // the environment never goes into a log line (shared-contract spec, decision 4).
    expect(result.message).not.toContain('out_of_order');
  });
});

describe('ChaosPolicy per-message modes', () => {
  it('emits the identical identity twice for duplicate', () => {
    const chaos = policy(['duplicate']);
    const emitted = chaos.apply(message(1));
    expect(emitted).toHaveLength(2);
    expect(emitted.map((m) => messageIdentity(m))).toEqual([
      'dev-0001:1700000000000:1',
      'dev-0001:1700000000000:1',
    ]);
  });

  it('swaps exactly one adjacent pair for out-of-order', () => {
    const chaos = policy(['out-of-order']);
    expect(chaos.apply(message(1))).toEqual([]);
    expect(chaos.apply(message(2)).map((m) => m.seq)).toEqual([2, 1]);
  });

  it('never holds more than one apply() result', () => {
    const chaos = policy(['out-of-order']);
    for (let seq = 1; seq <= 1_000; seq += 1) chaos.apply(message(seq));
    expect(chaos.flushHeld().length).toBeLessThanOrEqual(2);
  });

  it('preserves the multiset of order keys with every mode on', () => {
    // The load-bearing test of the whole design: chaos may repeat a message or move it, but it
    // may never invent, renumber or lose an order key. If this fails, a duplicate on the wire is
    // no longer "the same event twice" and the storage guards downstream mean nothing.
    const chaos = policy([...CHAOS_MODES]);
    const pushed: string[] = [];
    const emitted: string[] = [];
    for (let seq = 1; seq <= 1_000; seq += 1) {
      const input = message(seq);
      pushed.push(messageIdentity(input));
      for (const out of chaos.apply(input)) emitted.push(messageIdentity(out));
    }
    for (const out of chaos.flushHeld()) emitted.push(messageIdentity(out));

    // Every identity emitted was pushed, and every identity pushed was emitted at least once.
    expect(new Set(emitted)).toEqual(new Set(pushed));
    // Nothing was renumbered: duplication can only ever increase a count.
    const counts = new Map<string, number>();
    for (const identity of emitted) counts.set(identity, (counts.get(identity) ?? 0) + 1);
    for (const identity of pushed) expect(counts.get(identity)).toBeGreaterThanOrEqual(1);
  });

  it('passes messages straight through when no per-message mode is enabled', () => {
    const chaos = policy(['disconnect', 'restart']);
    expect(chaos.apply(message(1)).map((m) => m.seq)).toEqual([1]);
    expect(chaos.apply(message(2)).map((m) => m.seq)).toEqual([2]);
    expect(chaos.flushHeld()).toEqual([]);
  });

  it('drops the hold slot on clearHeld, which is what a power cycle does', () => {
    const chaos = policy(['out-of-order']);
    chaos.apply(message(1));
    chaos.clearHeld();
    expect(chaos.flushHeld()).toEqual([]);
  });
});

describe('ChaosPolicy connection modes', () => {
  it('returns null when no connection-level mode is enabled', () => {
    expect(policy(['duplicate', 'out-of-order']).nextConnectionChaos()).toBeNull();
    expect(policy([]).nextConnectionChaos()).toBeNull();
  });

  it('draws a delay inside [0.5x, 1.5x] of the interval', () => {
    const chaos = policy(['disconnect', 'restart']);
    const modes = new Set<string>();
    for (let i = 0; i < 1_000; i += 1) {
      const next = chaos.nextConnectionChaos();
      expect(next).not.toBeNull();
      if (next === null) return;
      expect(next.delayMs).toBeGreaterThanOrEqual(30_000);
      expect(next.delayMs).toBeLessThanOrEqual(90_000);
      modes.add(next.mode);
    }
    expect(modes).toEqual(new Set(['disconnect', 'restart']));
  });

  it('only ever picks an enabled mode', () => {
    const chaos = policy(['restart']);
    for (let i = 0; i < 100; i += 1) {
      expect(chaos.nextConnectionChaos()?.mode).toBe('restart');
    }
  });
});

describe('connection chaos delay at the largest allowed interval', () => {
  it('never draws a delay above what a Node timer holds', () => {
    const upper: Random = {
      float: () => 1,
      int: (_min, max) => max,
      bool: () => true,
      pick: (values) => values.at(-1) ?? values[0],
      range: (_min, max) => max,
    };
    const chaos = new ChaosPolicy({
      modes: ['disconnect'],
      percent: 5,
      intervalMs: CHAOS_INTERVAL_MAX_MS,
      random: upper,
    });
    const next = chaos.nextConnectionChaos();
    expect(next?.delayMs).toBeLessThanOrEqual(TIMER_MAX_MS);
    expect(next?.delayMs).toBeGreaterThan(TIMER_MAX_MS - 2);
  });
});
