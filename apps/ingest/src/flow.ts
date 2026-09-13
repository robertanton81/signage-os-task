/**
 * A confirm window (ingest spec, decision 3): it counts the messages that wait for a broker confirm,
 * closes when the count reaches its cap, and reopens only when the count falls to half the cap,
 * rounded down, so a cap of 1 reopens at 0.
 *
 * The gap between closing and reopening is what keeps a saturated instance from pausing and
 * resuming every socket once per message exactly when the broker is slow. The cap is soft: the
 * server processes a read chunk to its end, so `add` keeps counting past the cap while closed, and
 * the window still reopens at half the cap, not at half of that overshoot.
 */
export class Window {
  readonly #cap: number;
  #size = 0;
  #open = true;

  constructor(cap: number) {
    this.#cap = cap;
  }

  get isOpen(): boolean {
    return this.#open;
  }

  get size(): number {
    return this.#size;
  }

  /** Counts one more unconfirmed message; reports `closed` only on the add that closes the window. */
  add(): 'closed' | 'unchanged' {
    this.#size += 1;
    if (this.#open && this.#size >= this.#cap) {
      this.#open = false;
      return 'closed';
    }
    return 'unchanged';
  }

  /** Counts one confirm; reports `reopened` only on the remove that reopens the window. */
  remove(): 'reopened' | 'unchanged' {
    if (this.#size === 0) {
      // A programmer error: the server removes exactly once per message it added.
      throw new Error('window underflow');
    }
    this.#size -= 1;
    if (!this.#open && this.#size <= Math.floor(this.#cap / 2)) {
      this.#open = true;
      return 'reopened';
    }
    return 'unchanged';
  }
}

export type ReadInput = {
  publisherReady: boolean;
  connectionWindowOpen: boolean;
  instanceWindowOpen: boolean;
};

/**
 * The one reading rule (decision 2): a socket reads if and only if the publisher is ready and both
 * confirm windows are open. Shutdown is deliberately not an input (decision 19).
 */
export function shouldRead({
  publisherReady,
  connectionWindowOpen,
  instanceWindowOpen,
}: ReadInput): boolean {
  return publisherReady && connectionWindowOpen && instanceWindowOpen;
}
