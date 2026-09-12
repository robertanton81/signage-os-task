import { encodeFrame, type TelemetryMessage } from '@telemetry/shared';

/** The message is kept alongside its bytes for the drop log and for the eviction rule's type check. */
export type OutboxEntry = { message: TelemetryMessage; frame: Buffer };

/**
 * A bounded FIFO of frames waiting for a writable socket.
 *
 * It is the only place in the emulator that drops a message, which is why `push` reports what it
 * evicted: the caller logs it at `warn` with the identity, so this named loss window is never
 * silent. It is also the only source of a genuine `seq` gap — chaos duplicates and reorders, but
 * never skips — and that gap is what the consistency spec's gap log surfaces downstream.
 */
export class Outbox {
  readonly #maxEntries: number;
  #entries: OutboxEntry[] = [];

  constructor(maxEntries: number) {
    this.#maxEntries = maxEntries;
  }

  get length(): number {
    return this.#entries.length;
  }

  /**
   * Appends, encoding the frame now so the queue holds exactly the bytes that will be written.
   * Returns the entry evicted to make room, or null.
   *
   * Eviction spares diagnostics until nothing else is left: under absolute values the newest
   * reading is worth more than the oldest, but a dropped `error` diagnostic is an alert that is
   * never created at all. The scan is O(n) in the worst case, with n bounded by
   * `EMULATOR_OUTBOX_MAX` (default 1 000) and only on an already-overflowing outbox — accepted
   * rather than split into two queues.
   */
  push(message: TelemetryMessage): OutboxEntry | null {
    const evicted = this.#entries.length >= this.#maxEntries ? this.#evict() : null;
    this.#entries.push({ message, frame: encodeFrame(message) });
    return evicted;
  }

  shift(): OutboxEntry | null {
    return this.#entries.shift() ?? null;
  }

  clear(): void {
    this.#entries = [];
  }

  #evict(): OutboxEntry | null {
    const index = this.#entries.findIndex((entry) => entry.message.type !== 'diagnostic');
    const [evicted] = this.#entries.splice(index === -1 ? 0 : index, 1);
    return evicted ?? null;
  }
}
