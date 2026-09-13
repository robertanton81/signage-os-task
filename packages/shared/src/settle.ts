export type Settled<T> =
  | { outcome: 'resolved'; value: T }
  | { outcome: 'rejected'; error: unknown }
  | { outcome: 'timed_out' };

/**
 * Waits for `promise` at most `timeoutMs` and never rejects. A rejection that arrives after the
 * timeout is still handled, so it never becomes an unhandled rejection. The timer is cleared.
 *
 * The one bounded wait of the services: the ingest publisher's connect, setup and close steps, the
 * emulator's DNS lookups (which `dns.lookup` cannot bound itself), and the processing consumer's
 * shutdown drain. Timing out never cancels the work — nothing here can — it only stops waiting.
 */
export function settleWithin<T>(promise: Promise<T>, timeoutMs: number): Promise<Settled<T>> {
  let timer: NodeJS.Timeout | undefined;
  const timedOut = new Promise<Settled<T>>((resolve) => {
    timer = setTimeout(() => {
      resolve({ outcome: 'timed_out' });
    }, timeoutMs);
  });
  const settled = promise.then(
    (value): Settled<T> => ({ outcome: 'resolved', value }),
    (error: unknown): Settled<T> => ({ outcome: 'rejected', error }),
  );
  return Promise.race([settled, timedOut]).finally(() => {
    clearTimeout(timer);
  });
}
