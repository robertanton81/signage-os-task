import { assertNever } from '@telemetry/shared';

/**
 * A MongoDB failure as the handler sees it: a structural view built by the store shell from the
 * driver's error (processing spec, decision 9). The driver's error classes never cross the store
 * port, so the classification below is testable without a database and a driver upgrade touches
 * `store.ts` only.
 */
export type StoreFailure =
  | {
      kind: 'server';
      code: number | undefined;
      codeName: string | undefined;
      labels: readonly string[];
      message: string;
    }
  | { kind: 'network'; message: string }
  | { kind: 'server_selection'; message: string }
  | { kind: 'closed'; message: string }
  | { kind: 'other'; name: string; message: string };

/**
 * What a store port method rejects with. An `Error` subclass rather than the bare view: the lint
 * rules `only-throw-error` and `prefer-promise-reject-errors` forbid rejecting with a plain object,
 * and a stack trace helps when a permanent failure is logged. The messages are driver text, which
 * can quote the connection string: the store redacts URL userinfo when it builds the view, and a
 * log line passes the error as `err` (or the view as a plain field), so the shared logger redacts
 * it again — never copy `.message` into a field of its own.
 */
export class StoreError extends Error {
  override readonly name = 'StoreError';

  constructor(readonly failure: StoreFailure) {
    super(failure.message);
  }
}

export type FailureClass = 'transient' | 'permanent' | 'closed';

/** The driver attaches this label to a write the server says is safe to retry. */
export const RETRYABLE_WRITE_LABEL = 'RetryableWriteError';

/**
 * Server error codes that name a passing condition (consistency spec, decision 26): LockTimeout
 * (24), MaxTimeMSExpired (50), WriteConcernTimeout (64), ShutdownInProgress (91),
 * ExceededTimeLimit (262), NotWritablePrimary (10107), InterruptedAtShutdown (11600).
 */
export const TRANSIENT_SERVER_CODES: ReadonlySet<number> = new Set([
  24, 50, 64, 91, 262, 10107, 11600,
]);

/**
 * Transient → retry in place, then pause the instance; closed → the client is shutting down, so
 * the delivery is left for the broker to requeue; permanent → dead-letter (decision 9). A duplicate
 * key (11000) must never reach this function: the store port's contract is to turn it into the
 * `'duplicate'` result before the handler sees a failure (decision 8, `store.ts`). Should that
 * contract ever break, 11000 falls through as permanent like every other unlisted server code, and
 * a duplicate is dead-lettered instead of silently accepted — the safe failure mode.
 */
export function classifyFailure(failure: StoreFailure): FailureClass {
  switch (failure.kind) {
    case 'network':
    case 'server_selection':
      return 'transient';
    case 'server':
      return failure.labels.includes(RETRYABLE_WRITE_LABEL) ||
        (failure.code !== undefined && TRANSIENT_SERVER_CODES.has(failure.code))
        ? 'transient'
        : 'permanent';
    case 'closed':
      return 'closed';
    case 'other':
      return 'permanent';
    default:
      return assertNever(failure, 'store failure');
  }
}
