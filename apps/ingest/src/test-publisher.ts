import type { PublishPort, PublishRequest } from './publisher.js';

/**
 * An in-memory `PublishPort` for the socket server's tests (ingest spec, decision 24). It records
 * every request, confirms one only when the test says so, and changes readiness on demand, so a test
 * controls the three inputs the reading rule and the shutdown drain depend on.
 *
 * Not named `*.test.ts`: the unit project would report a file without tests as an empty suite.
 */
export type TestPublisher = {
  port: PublishPort;
  /** Every request, in arrival order. */
  requests: PublishRequest[];
  /** Changes readiness and notifies the listeners, but only when the value changes. */
  setReady(ready: boolean): void;
  /** Calls `onConfirmed` of the request at `index` once; a second call for it does nothing. */
  confirm(index: number): void;
  confirmAll(): void;
  /** Resolves once `requests.length >= count`; the vitest timeout bounds it. */
  waitForRequests(count: number): Promise<PublishRequest[]>;
};

export function createTestPublisher({ ready = true }: { ready?: boolean } = {}): TestPublisher {
  const requests: PublishRequest[] = [];
  const confirmed = new Set<number>();
  const listeners = new Set<(ready: boolean) => void>();
  // A set, as in the emulator's test sink: two waits at once must not overwrite each other.
  const waiters = new Set<() => void>();
  let readyNow = ready;

  const confirm = (index: number): void => {
    const request = requests[index];
    if (request === undefined) {
      throw new Error(`no request at index ${index}`);
    }
    if (confirmed.has(index)) {
      return;
    }
    // Counted before the callback runs, as the real ledger removes an entry before it calls
    // `onConfirmed`: the drain check inside the callback must already see the smaller count.
    confirmed.add(index);
    request.onConfirmed();
  };

  const port: PublishPort = {
    publish: (request) => {
      requests.push(request);
      for (const waiter of [...waiters]) {
        waiter();
      }
    },
    get isReady() {
      return readyNow;
    },
    onReadyChange: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    get unconfirmed() {
      return requests.length - confirmed.size;
    },
    stop: () => Promise.resolve(),
  };

  return {
    port,
    requests,
    setReady: (next) => {
      if (next === readyNow) {
        return;
      }
      readyNow = next;
      for (const listener of [...listeners]) {
        listener(next);
      }
    },
    confirm,
    confirmAll: () => {
      for (let index = 0; index < requests.length; index += 1) {
        confirm(index);
      }
    },
    waitForRequests: (count) =>
      new Promise<PublishRequest[]>((resolve) => {
        const check = (): void => {
          if (requests.length >= count) {
            waiters.delete(check);
            resolve([...requests]);
          }
        };
        waiters.add(check);
        check();
      }),
  };
}
