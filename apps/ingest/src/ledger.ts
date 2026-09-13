import type { PublishArgs } from './amqp-message.js';

export type LedgerEntry = {
  /** Instance-local counter; the ledger never keys anything by device (invariant 6). */
  readonly id: number;
  readonly args: PublishArgs;
  /** Runs once, when the broker acks the message. */
  readonly onConfirmed: () => void;
  // `state` and `wasSent` are written only by the Ledger's own methods: `sentCount` stays right
  // only while no caller assigns them.
  state: { name: 'pending' } | { name: 'sent'; generation: number };
  /** Set by markSent and never cleared: a pending entry with `wasSent` true is a re-publish. */
  wasSent: boolean;
};

/**
 * Every message handed to the publisher, kept until the broker acks it — whether or not its device
 * connection still exists (ingest spec, decision 11). A `Map` keeps insertion order, so messages
 * that come back through `lose()` are published again in the order they first arrived. The sent
 * count is kept incrementally, because the stall check reads it on every tick.
 */
export class Ledger {
  readonly #entries = new Map<number, LedgerEntry>();
  #nextId = 1;
  #sentCount = 0;

  get size(): number {
    return this.#entries.size;
  }

  get sentCount(): number {
    return this.#sentCount;
  }

  add({ args, onConfirmed }: { args: PublishArgs; onConfirmed: () => void }): LedgerEntry {
    const entry: LedgerEntry = {
      id: this.#nextId,
      args,
      onConfirmed,
      state: { name: 'pending' },
      wasSent: false,
    };
    this.#nextId += 1;
    this.#entries.set(entry.id, entry);
    return entry;
  }

  /** The pending entries in insertion order. */
  pending(): LedgerEntry[] {
    return [...this.#entries.values()].filter((entry) => entry.state.name === 'pending');
  }

  /** Marks an entry sent on a channel generation. An entry already sent is not counted twice. */
  markSent(entry: LedgerEntry, generation: number): void {
    if (!this.#entries.has(entry.id)) {
      return;
    }
    if (entry.state.name === 'pending') {
      this.#sentCount += 1;
    }
    entry.state = { name: 'sent', generation };
    entry.wasSent = true;
  }

  /**
   * Removes the entry and calls its `onConfirmed`. A second confirm of the same entry does nothing:
   * a stale callback is filtered earlier by its generation, but the ledger stays safe on its own.
   */
  confirm(entry: LedgerEntry): void {
    if (!this.#entries.delete(entry.id)) {
      return;
    }
    if (entry.state.name === 'sent') {
      this.#sentCount -= 1;
    }
    entry.onConfirmed();
  }

  /** Every sent entry becomes pending again; runs on every channel generation increase (decision 12). */
  lose(): void {
    for (const entry of this.#entries.values()) {
      entry.state = { name: 'pending' };
    }
    this.#sentCount = 0;
  }
}

/**
 * How long the publisher has waited for an ack (ingest spec, decision 15). One timestamp rather than
 * a timer per message: the wait starts when the sent count rises from zero, restarts on every ack
 * while entries remain sent, restarts on entering ready and on unblocked, and stops once nothing is
 * sent. The clock does not know the sent count between calls; the publisher checks it before it
 * acts on a stall. A method that takes two numbers takes them as one named object, so a swapped
 * call cannot pass the type checker (CLAUDE.md, "Arguments and validation boundaries").
 */
export class StallClock {
  #startedAt: number | null = null;

  /** Called after an entry was marked sent, with the new sent count. */
  onSent({ now, sentCount }: { now: number; sentCount: number }): void {
    if (sentCount === 1) {
      this.#startedAt = now;
    }
  }

  /** Called after an ack, with the sent count that remains. */
  onAck({ now, sentCount }: { now: number; sentCount: number }): void {
    this.#startedAt = sentCount > 0 ? now : null;
  }

  /** Called on entering ready and on unblocked, also while the clock is already counting. */
  restart(now: number): void {
    this.#startedAt = now;
  }

  isStalled({ now, timeoutMs }: { now: number; timeoutMs: number }): boolean {
    return this.#startedAt !== null && now - this.#startedAt > timeoutMs;
  }
}
