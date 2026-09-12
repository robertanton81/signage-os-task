import { CONTRACT_VERSION, type TelemetryMessage } from '@telemetry/shared';
import { describe, expect, it } from 'vitest';

import { Outbox } from './outbox.js';

let seq = 0;

function metrics(): TelemetryMessage {
  seq += 1;
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

function diagnostic(): TelemetryMessage {
  seq += 1;
  return {
    v: CONTRACT_VERSION,
    deviceId: 'dev-0001',
    sessionId: 1_700_000_000_000,
    seq,
    occurredAt: 1_700_000_000_000,
    type: 'diagnostic',
    payload: { severity: 'error', code: 'E_OVERHEAT', message: 'too hot' },
  };
}

describe('Outbox', () => {
  it('is FIFO while under capacity and evicts nothing', () => {
    const outbox = new Outbox(10);
    const pushed = [metrics(), metrics(), metrics()];
    for (const message of pushed) {
      expect(outbox.push(message)).toBeNull();
    }
    expect(outbox.length).toBe(3);
    expect([
      outbox.shift()?.message.seq,
      outbox.shift()?.message.seq,
      outbox.shift()?.message.seq,
    ]).toEqual(pushed.map((m) => m.seq));
    expect(outbox.shift()).toBeNull();
  });

  it('encodes the frame at push time, ending in a newline', () => {
    const outbox = new Outbox(10);
    const message = metrics();
    outbox.push(message);
    const entry = outbox.shift();
    expect(entry).not.toBeNull();
    const frame = entry?.frame.toString('utf8') ?? '';
    expect(frame.endsWith('\n')).toBe(true);
    expect(JSON.parse(frame)).toEqual(message);
  });

  it('evicts the oldest non-diagnostic first and keeps the diagnostics', () => {
    const outbox = new Outbox(3);
    const first = metrics();
    const alert = diagnostic();
    const second = metrics();
    outbox.push(first);
    outbox.push(alert);
    outbox.push(second);

    const evicted = outbox.push(metrics());
    // `first` is the oldest overall AND the oldest non-diagnostic, so it goes.
    expect(evicted?.message.seq).toBe(first.seq);
    expect(outbox.length).toBe(3);

    const evictedAgain = outbox.push(metrics());
    // `alert` is now the oldest overall, but it is a diagnostic: `second` goes instead.
    expect(evictedAgain?.message.seq).toBe(second.seq);
    expect(Array.from({ length: outbox.length }, () => outbox.shift()?.message.type)).toContain(
      'diagnostic',
    );
  });

  it('evicts the head when every entry is a diagnostic', () => {
    const outbox = new Outbox(2);
    const first = diagnostic();
    outbox.push(first);
    outbox.push(diagnostic());
    const evicted = outbox.push(diagnostic());
    expect(evicted?.message.seq).toBe(first.seq);
    expect(outbox.length).toBe(2);
  });

  it('never exceeds its maximum', () => {
    const outbox = new Outbox(5);
    for (let i = 0; i < 100; i += 1) {
      outbox.push(i % 3 === 0 ? diagnostic() : metrics());
      expect(outbox.length).toBeLessThanOrEqual(5);
    }
    expect(outbox.length).toBe(5);
  });

  it('clears', () => {
    const outbox = new Outbox(5);
    outbox.push(metrics());
    outbox.push(metrics());
    outbox.clear();
    expect(outbox.length).toBe(0);
    expect(outbox.shift()).toBeNull();
  });
});
