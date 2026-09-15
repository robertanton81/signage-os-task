import {
  assertNever,
  type AlertDocument,
  type DeviceStateDocument,
  type EventDocument,
  type TelemetryMessage,
} from '@telemetry/shared';

import { StoreError, type StoreFailure } from './failure.js';
import type { StorePort } from './store.js';

export type StoreCall =
  | { method: 'insertEvent'; doc: EventDocument }
  | { method: 'applyState'; deviceId: string; message: TelemetryMessage; receivedAt: number }
  | { method: 'insertAlert'; doc: AlertDocument };

export type StoreMethod = StoreCall['method'];

export type StoreAnswer =
  /** `before` applies to applyState only; it defaults to null (the upsert created the document). */
  | { outcome: 'ok'; before?: DeviceStateDocument | null }
  | { outcome: 'duplicate' }
  /** Rejects with `new StoreError(failure)`, as the MongoDB store does. */
  | { outcome: 'fail'; failure: StoreFailure }
  /** Rejects with the error itself: a programmer error escaping the store. */
  | { outcome: 'throw'; error: Error };

/**
 * The in-memory implementation of the store port for the handler's tests (processing spec,
 * decision 8): records every call in order and answers each one from a scripted queue per method,
 * or with success when nothing is scripted. Not a mock of MongoDB — the same seam the ingest
 * server's tests use for its publisher. Not named `*.test.ts`: the unit project would report a
 * file without tests as an empty suite. The methods return settled promises without `async`,
 * because the `require-await` rule forbids an async function that never awaits.
 */
export class TestStore implements StorePort {
  /** Every call in order, with its arguments. */
  readonly calls: StoreCall[] = [];
  /** Runs after every call is recorded; a test aborts the handler's signal from here. */
  onCall: ((call: StoreCall) => void) | undefined;

  readonly #answers: Record<StoreMethod, StoreAnswer[]> = {
    insertEvent: [],
    applyState: [],
    insertAlert: [],
  };

  /** Queues the answer for the next call of `method`; unscripted calls answer `{ outcome: 'ok' }`. */
  answer(method: StoreMethod, answer: StoreAnswer): void {
    this.#answers[method].push(answer);
  }

  insertEvent(doc: EventDocument): Promise<'inserted' | 'duplicate'> {
    return this.#insert({ method: 'insertEvent', doc });
  }

  applyState(
    message: TelemetryMessage,
    receivedAt: number,
  ): Promise<{ result: 'updated'; before: DeviceStateDocument | null } | { result: 'duplicate' }> {
    const answer = this.#record({
      method: 'applyState',
      deviceId: message.deviceId,
      message,
      receivedAt,
    });
    switch (answer.outcome) {
      case 'ok':
        return Promise.resolve({ result: 'updated', before: answer.before ?? null });
      case 'duplicate':
        return Promise.resolve({ result: 'duplicate' });
      case 'fail':
        return Promise.reject(new StoreError(answer.failure));
      case 'throw':
        return Promise.reject(answer.error);
      default:
        return assertNever(answer, 'store answer');
    }
  }

  insertAlert(doc: AlertDocument): Promise<'inserted' | 'duplicate'> {
    return this.#insert({ method: 'insertAlert', doc });
  }

  #record(call: StoreCall): StoreAnswer {
    this.calls.push(call);
    const answer = this.#answers[call.method].shift() ?? { outcome: 'ok' };
    this.onCall?.(call);
    return answer;
  }

  #insert(call: StoreCall): Promise<'inserted' | 'duplicate'> {
    const answer = this.#record(call);
    switch (answer.outcome) {
      case 'ok':
        return Promise.resolve('inserted');
      case 'duplicate':
        return Promise.resolve('duplicate');
      case 'fail':
        return Promise.reject(new StoreError(answer.failure));
      case 'throw':
        return Promise.reject(answer.error);
      default:
        return assertNever(answer, 'store answer');
    }
  }
}
