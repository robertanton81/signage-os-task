import { messageIdentity, type TelemetryMessage } from '@telemetry/shared';
import { describe, expect, it } from 'vitest';

import {
  LOAD_SESSION_ID,
  expectationOf,
  generateLoad,
  loadDeviceId,
  mergeExpected,
} from './load.js';

const OPTIONS = {
  devices: 20,
  messages: 1000,
  hotShare: 0.25,
  duplicatePercent: 5,
  swapPercent: 5,
  seed: 1,
};
const SMALL = { ...OPTIONS, devices: 10, messages: 100, hotShare: 0 };
const TYPES = ['status', 'metrics', 'counters', 'diagnostic'] as const;

/** The distinct messages of one device, in send order. */
function streamOf(sends: readonly TelemetryMessage[], deviceId: string): TelemetryMessage[] {
  const seen = new Set<string>();
  const stream: TelemetryMessage[] = [];
  for (const message of sends) {
    const identity = messageIdentity(message);
    if (message.deviceId === deviceId && !seen.has(identity)) {
      seen.add(identity);
      stream.push(message);
    }
  }
  return stream;
}

describe('generateLoad', () => {
  it('is deterministic for a seed and differs for another', () => {
    expect(generateLoad(OPTIONS).sends).toEqual(generateLoad(OPTIONS).sends);
    expect(generateLoad({ ...OPTIONS, seed: 2 }).sends).not.toEqual(generateLoad(OPTIONS).sends);
  });

  it('sends every message once plus the injected duplicates, each right after its original', () => {
    const { sends, expected } = generateLoad(OPTIONS);
    expect(expected.identities.size).toBe(1000);
    expect(sends).toHaveLength(1000 + expected.duplicates);
    expect(expected.duplicates).toBeGreaterThan(0);
    const seen = new Set<string>();
    let adjacent = 0;
    sends.forEach((message, index) => {
      const identity = messageIdentity(message);
      if (seen.has(identity)) {
        adjacent += 1;
        expect(sends[index - 1]).toEqual(message);
      }
      seen.add(identity);
    });
    expect(adjacent).toBe(expected.duplicates);
  });

  it('gives the hot device its share and spreads the rest evenly', () => {
    const { sends } = generateLoad(OPTIONS);
    expect(streamOf(sends, loadDeviceId('load', 1))).toHaveLength(250);
    const others = Array.from(
      { length: 19 },
      (_, index) => streamOf(sends, loadDeviceId('load', index + 2)).length,
    );
    expect(others.reduce((sum, count) => sum + count, 0)).toBe(750);
    expect(Math.max(...others) - Math.min(...others)).toBeLessThanOrEqual(1);
    const even = generateLoad(SMALL);
    for (let device = 1; device <= 10; device += 1) {
      expect(streamOf(even.sends, loadDeviceId('load', device))).toHaveLength(10);
    }
  });

  it('keeps every stream in order apart from adjacent swaps, and in exact order without swaps', () => {
    const { sends } = generateLoad(OPTIONS);
    let swapped = 0;
    for (let device = 1; device <= 20; device += 1) {
      const seqs = streamOf(sends, loadDeviceId('load', device)).map((message) => message.seq);
      const inOrder = seqs.map((_, index) => index + 1);
      expect([...seqs].sort((a, b) => a - b)).toEqual(inOrder);
      seqs.forEach((seq, index) => {
        expect(Math.abs(seq - (index + 1))).toBeLessThanOrEqual(1);
        if (seq !== index + 1) {
          swapped += 1;
        }
      });
    }
    expect(swapped).toBeGreaterThan(0);
    const ordered = generateLoad({ ...OPTIONS, swapPercent: 0, duplicatePercent: 0 });
    expect(ordered.expected.duplicates).toBe(0);
    expect(ordered.sends).toHaveLength(1000);
    for (let device = 1; device <= 20; device += 1) {
      const seqs = streamOf(ordered.sends, loadDeviceId('load', device)).map((m) => m.seq);
      expect(seqs).toEqual(seqs.map((_, index) => index + 1));
    }
  });

  it('rotates the four types and makes every tenth message an error diagnostic', () => {
    const { sends, expected } = generateLoad({ ...SMALL, swapPercent: 0, duplicatePercent: 0 });
    for (const message of sends) {
      if (message.seq % 10 === 0) {
        expect(message.type).toBe('diagnostic');
        expect(message.type === 'diagnostic' && message.payload.severity).toBe('error');
      } else {
        expect(message.type).toBe(TYPES[(message.seq - 1) % TYPES.length]);
      }
    }
    expect(expected.alerts.size).toBe(10);
    const errors = sends.filter((m) => m.seq % 10 === 0).map((m) => messageIdentity(m));
    expect(expected.alerts).toEqual(new Set(errors));
  });

  it('expects the highest key per section and per device', () => {
    const { sends, expected } = generateLoad(OPTIONS);
    for (let device = 1; device <= 20; device += 1) {
      const deviceId = loadDeviceId('load', device);
      const stream = streamOf(sends, deviceId);
      const sections = expected.sections.get(deviceId);
      expect(sections).toBeDefined();
      for (const type of TYPES) {
        const seqs = stream.filter((m) => m.type === type).map((m) => m.seq);
        expect(seqs.length, `${deviceId} ${type}`).toBeGreaterThan(0);
        const highest = Math.max(...seqs);
        expect(sections?.get(type)).toEqual({ sessionId: LOAD_SESSION_ID, seq: highest });
      }
      expect(expected.lastEvent.get(deviceId)).toEqual({
        sessionId: LOAD_SESSION_ID,
        seq: stream.length,
      });
    }
  });

  it('computes the expectation from the sends alone', () => {
    const { sends, expected } = generateLoad(OPTIONS);
    // A message dropped on the way changes the oracle: a comparison against stored data could not
    // see it. Metrics messages of one device keep their relative order (a swap exchanges two
    // adjacent seqs, which are never both metrics), so the last one holds the section's key.
    const deviceId = loadDeviceId('load', 1);
    const metrics = streamOf(sends, deviceId).filter((m) => m.type === 'metrics');
    const dropped = metrics.at(-1);
    const previous = metrics.at(-2);
    if (dropped === undefined || previous === undefined) {
      throw new Error('fixture too small');
    }
    expect(expected.sections.get(deviceId)?.get('metrics')).toEqual({
      sessionId: LOAD_SESSION_ID,
      seq: dropped.seq,
    });
    const reduced = expectationOf(sends.filter((m) => m !== dropped));
    expect(reduced.identities.size).toBe(expected.identities.size - 1);
    expect(reduced.sections.get(deviceId)?.get('metrics')).toEqual({
      sessionId: LOAD_SESSION_ID,
      seq: previous.seq,
    });
  });

  it('namespaces devices by prefix, not by seed', () => {
    const a = generateLoad({ ...SMALL, seed: 3, deviceIdPrefix: 'c10a' });
    const b = generateLoad({ ...SMALL, seed: 4, deviceIdPrefix: 'c10b' });
    const sameIds = generateLoad({ ...SMALL, seed: 4, deviceIdPrefix: 'c10a' });
    expect([...a.expected.sections.keys()].every((id) => id.startsWith('c10a-'))).toBe(true);
    expect([...a.expected.identities].some((id) => b.expected.identities.has(id))).toBe(false);
    // The same ids; the map's insertion order follows the interleave, which the seed changes.
    expect(new Set(sameIds.expected.sections.keys())).toEqual(new Set(a.expected.sections.keys()));
  });

  it('needs at least one message per device, and accepts exactly one', () => {
    expect(() => generateLoad({ ...SMALL, devices: 10, messages: 9 })).toThrow(
      /needs at least one device and one message per device/,
    );
    const minimal = generateLoad({ ...SMALL, messages: 10, swapPercent: 0, duplicatePercent: 0 });
    expect(minimal.sends).toHaveLength(10);
    for (let device = 1; device <= 10; device += 1) {
      expect(streamOf(minimal.sends, loadDeviceId('load', device))).toHaveLength(1);
    }
  });

  it('merges disjoint expectations and rejects a shared device', () => {
    const a = generateLoad({ ...SMALL, seed: 3, deviceIdPrefix: 'c10a' });
    const b = generateLoad({ ...SMALL, seed: 4, deviceIdPrefix: 'c10b' });
    const merged = mergeExpected({ first: a.expected, second: b.expected });
    expect(merged.identities.size).toBe(200);
    expect(merged.alerts.size).toBe(20);
    expect(merged.sections.size).toBe(20);
    expect(merged.lastEvent.size).toBe(20);
    const fromB = loadDeviceId('c10b', 1);
    expect(merged.sections.get(fromB)).toEqual(b.expected.sections.get(fromB));
    expect(merged.lastEvent.get(fromB)).toEqual(b.expected.lastEvent.get(fromB));
    expect(merged.duplicates).toBe(a.expected.duplicates + b.expected.duplicates);
    expect(() => mergeExpected({ first: a.expected, second: a.expected })).toThrow(
      /^mergeExpected: device c10a-\d{4} is in both expectations$/,
    );
  });
});
