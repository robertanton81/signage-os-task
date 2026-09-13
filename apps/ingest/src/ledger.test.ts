import { describe, expect, it } from 'vitest';

import type { PublishArgs } from './amqp-message.js';
import { Ledger, StallClock } from './ledger.js';

/** The ledger treats publish arguments as opaque, so one shared value is enough. */
const args: PublishArgs = {
  exchange: 'telemetry',
  routingKey: 'event',
  content: Buffer.from('{}'),
  options: {},
};
const noop = (): void => undefined;

const idsOf = (entries: readonly { id: number }[]): number[] => entries.map((entry) => entry.id);

describe('Ledger', () => {
  it('keeps insertion order in pending(), also for entries that come back through lose()', () => {
    const ledger = new Ledger();
    const a = ledger.add({ args, onConfirmed: noop });
    const b = ledger.add({ args, onConfirmed: noop });
    const c = ledger.add({ args, onConfirmed: noop });

    ledger.markSent(b, 1);
    expect(idsOf(ledger.pending())).toEqual([a.id, c.id]);

    // Re-published messages go out in their original order, not after the ones that never left.
    ledger.lose();
    expect(idsOf(ledger.pending())).toEqual([a.id, b.id, c.id]);
  });

  it('calls onConfirmed exactly once and removes the entry, however often it is confirmed', () => {
    const ledger = new Ledger();
    let calls = 0;
    const entry = ledger.add({
      args,
      onConfirmed: () => {
        calls += 1;
      },
    });
    ledger.markSent(entry, 1);

    ledger.confirm(entry);
    ledger.confirm(entry);

    expect(calls).toBe(1);
    expect(ledger.size).toBe(0);
    expect(ledger.sentCount).toBe(0);
  });

  it('turns every sent entry back into pending on lose() and leaves pending entries alone', () => {
    const ledger = new Ledger();
    const waiting = ledger.add({ args, onConfirmed: noop });
    const sent = ledger.add({ args, onConfirmed: noop });
    ledger.markSent(sent, 7);

    ledger.lose();

    expect(waiting.state).toEqual({ name: 'pending' });
    expect(sent.state).toEqual({ name: 'pending' });
    expect(ledger.sentCount).toBe(0);
  });

  it('keeps size and sentCount right through every transition', () => {
    const ledger = new Ledger();
    const counts = (): [size: number, sent: number] => [ledger.size, ledger.sentCount];

    const a = ledger.add({ args, onConfirmed: noop });
    const b = ledger.add({ args, onConfirmed: noop });
    const c = ledger.add({ args, onConfirmed: noop });
    expect(counts()).toEqual([3, 0]);

    ledger.markSent(a, 1);
    ledger.markSent(b, 1);
    expect(counts()).toEqual([3, 2]);

    // Marking an entry that is already sent must not count it twice.
    ledger.markSent(b, 1);
    expect(counts()).toEqual([3, 2]);

    ledger.confirm(a);
    expect(counts()).toEqual([2, 1]);

    ledger.lose();
    expect(counts()).toEqual([2, 0]);

    // Confirming an entry that is pending removes it without making sentCount negative.
    ledger.confirm(c);
    expect(counts()).toEqual([1, 0]);

    ledger.markSent(b, 2);
    ledger.confirm(b);
    expect(counts()).toEqual([0, 0]);
  });

  it('records that an entry was sent, and keeps that record through lose()', () => {
    const ledger = new Ledger();
    const entry = ledger.add({ args, onConfirmed: noop });
    expect(entry.wasSent).toBe(false);

    ledger.markSent(entry, 1);
    expect(entry.wasSent).toBe(true);
    expect(entry.state).toEqual({ name: 'sent', generation: 1 });

    ledger.lose();
    expect(entry.wasSent).toBe(true);
  });

  it('gives every entry its own id', () => {
    const ledger = new Ledger();
    const ids = Array.from({ length: 5 }, () => ledger.add({ args, onConfirmed: noop }).id);

    expect(new Set(ids).size).toBe(5);
  });
});

describe('StallClock', () => {
  const TIMEOUT_MS = 30_000;

  it('starts when the sent count rises from zero and ignores later sends', () => {
    const clock = new StallClock();
    expect(clock.isStalled(1_000_000, TIMEOUT_MS)).toBe(false);

    clock.onSent(1_000, 1);
    clock.onSent(5_000, 2);

    // Measured from 1 000, the first send. A restart at 5 000 would still be waiting at 31 001.
    expect(clock.isStalled(31_000, TIMEOUT_MS)).toBe(false);
    expect(clock.isStalled(31_001, TIMEOUT_MS)).toBe(true);
  });

  it('restarts on an ack while entries remain sent and stops once none are', () => {
    const clock = new StallClock();
    clock.onSent(0, 1);
    clock.onSent(0, 2);

    clock.onAck(40_000, 1);
    expect(clock.isStalled(70_000, TIMEOUT_MS)).toBe(false);
    expect(clock.isStalled(70_001, TIMEOUT_MS)).toBe(true);

    clock.onAck(50_000, 0);
    expect(clock.isStalled(1_000_000, TIMEOUT_MS)).toBe(false);
  });

  it('restarts on entering ready or unblocked, whatever the sent count', () => {
    // The clock itself ignores the sent count; the publisher checks it before acting on a stall.
    const clock = new StallClock();
    clock.restart(2_000);

    expect(clock.isStalled(32_000, TIMEOUT_MS)).toBe(false);
    expect(clock.isStalled(32_001, TIMEOUT_MS)).toBe(true);
  });

  it('measures from the first send, not from an earlier restart', () => {
    // An instance that reconnects and then idles for a minute must not count that minute as a stall
    // on its first message.
    const clock = new StallClock();
    clock.restart(0);
    clock.onSent(60_000, 1);

    expect(clock.isStalled(60_001, TIMEOUT_MS)).toBe(false);
    expect(clock.isStalled(90_001, TIMEOUT_MS)).toBe(true);
  });
});
