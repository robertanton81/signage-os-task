import {
  DUPLICATE_KEY_ERROR_CODE,
  assertNever,
  backoffDelay,
  messageIdentity,
  messageLogger,
  rejectedMessageLogger,
  type EventDocument,
  type Logger,
  type TelemetryMessage,
} from '@telemetry/shared';

import { decodeDelivery, type DeliveryRejectionReason } from './delivery.js';
import { StoreError, classifyFailure, type FailureClass, type StoreFailure } from './failure.js';
import { buildStateUpdate, classifyOutcome, detectGap, type StateOutcome } from './state-update.js';
import type { StorePort } from './store.js';

/** Full Jitter between the transient attempts of one handler (processing spec, decision 13). */
export const HANDLER_BACKOFF_BASE_MS = 200;
export const HANDLER_BACKOFF_MAX_MS = 5_000;

export type AlertResult = 'created' | 'exists' | 'none';

/**
 * How one delivery ends: acknowledged, rejected without requeue (dead-lettered), or abandoned —
 * no acknowledgement at all, because the tag is void after an abort, the client is closing, or the
 * instance is about to pause and return what it holds (decision 7). `attempts` counts the attempts
 * started; a body that never decoded made none.
 */
export type HandlerResult =
  | {
      verdict: 'ack';
      outcome: StateOutcome;
      duplicate: boolean;
      alert: AlertResult;
      gap: boolean;
      attempts: number;
    }
  | { verdict: 'reject'; reason: DeliveryRejectionReason | 'permanent'; attempts: number }
  | { verdict: 'abandon'; cause: 'aborted' | 'closed' | 'store_unavailable'; attempts: number };

export type HandlerInput = {
  content: Buffer;
  headers: Record<string, unknown> | undefined;
  redelivered: boolean;
  store: StorePort;
  clock: () => number;
  /** Resolves after `ms`; rejects as soon as the signal aborts (`timers/promises` in production). */
  sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  /** A draw in [0, 1) for the backoff; `Math.random` in production. */
  random: () => number;
  /** Fires when the link closes, the broker cancels the consumer, or the instance pauses or stops. */
  signal: AbortSignal;
  /** Consecutive transient failures before the handler gives up and the instance pauses (decision 12). */
  transientAttempts: number;
  logger: Logger;
};

type Step = 'insertEvent' | 'applyState' | 'insertAlert';

type AttemptResult =
  | { kind: 'ack'; outcome: StateOutcome; duplicate: boolean; alert: AlertResult; gap: boolean }
  | { kind: 'aborted' }
  | { kind: 'failed'; step: Step; failure: StoreFailure; klass: FailureClass };

type Context = {
  message: TelemetryMessage;
  receivedAt: number;
  store: StorePort;
  clock: () => number;
  signal: AbortSignal;
  log: Logger;
};

/**
 * The second duplicate key error of the state upsert within one attempt: the racing first insert
 * of a new device collided twice (consistency spec, decision 29). Treated as transient without
 * going through `classifyFailure`, which calls 11000 permanent — the document exists by now, and
 * the restarted attempt's event insert is a harmless duplicate.
 */
const STATE_COLLISION: StoreFailure = {
  kind: 'server',
  code: DUPLICATE_KEY_ERROR_CODE,
  codeName: 'DuplicateKey',
  labels: [],
  message: 'state upsert collided twice',
};

/**
 * Processes one delivery: decode, then the consistency spec's three idempotent writes in order —
 * insert the event, apply the section under the server-evaluated guard, insert the alert of an
 * error diagnostic — and report the verdict the consumer turns into an ack, a reject or nothing
 * (processing spec, decisions 13–17, 22). Never rejects: a throw that is not a `StoreError` is a
 * programmer error, logged and dead-lettered so the delivery does not stay in limbo. The abort
 * signal is checked before every write, before the acknowledgement and before every retry.
 */
export async function processDelivery(input: HandlerInput): Promise<HandlerResult> {
  const { content, headers, redelivered, store, clock, sleep, random, signal, logger } = input;
  const decoded = decodeDelivery({ content, headers, redelivered, clock });
  if (!decoded.ok) {
    const { reason, detail, bytes, identity } = decoded.rejection;
    rejectedMessageLogger(logger, identity).warn({ reason, detail, bytes }, 'message rejected');
    return { verdict: 'reject', reason, attempts: 0 };
  }
  const { message, receivedAt, receivedAtSource } = decoded.delivery;
  const log = messageLogger(logger, message);
  if (receivedAtSource === 'clock') {
    log.warn({ receivedAt }, 'received-at header missing');
  }
  const context: Context = { message, receivedAt, store, clock, signal, log };

  for (let attempt = 1; ; attempt += 1) {
    let result: AttemptResult;
    try {
      result = await runAttempt(context);
    } catch (error) {
      log.error({ err: error, attempt }, 'handler failed');
      return { verdict: 'reject', reason: 'permanent', attempts: attempt };
    }
    switch (result.kind) {
      case 'aborted':
        return { verdict: 'abandon', cause: 'aborted', attempts: attempt };
      case 'ack': {
        const { outcome, duplicate, alert, gap } = result;
        const fields = { outcome, duplicate, redelivered, alert, attempts: attempt };
        // `stale` and `duplicate` are the visible proof of invariants 1 and 2, and rare (decision 22).
        if (outcome === 'stale' || duplicate) {
          log.info(fields, 'delivery processed');
        } else {
          log.debug(fields, 'delivery processed');
        }
        return { verdict: 'ack', outcome, duplicate, alert, gap, attempts: attempt };
      }
      case 'failed': {
        const { failure, step, klass } = result;
        if (klass === 'permanent') {
          log.error({ failure, step, attempt }, 'permanent store failure');
          return { verdict: 'reject', reason: 'permanent', attempts: attempt };
        }
        if (klass === 'closed') {
          log.warn({ failure, step, attempt }, 'store closed');
          return { verdict: 'abandon', cause: 'closed', attempts: attempt };
        }
        log.warn({ failure, step, attempt }, 'transient store failure');
        if (attempt >= input.transientAttempts) {
          return { verdict: 'abandon', cause: 'store_unavailable', attempts: attempt };
        }
        try {
          await sleep(
            backoffDelay({
              attempt: attempt - 1,
              baseMs: HANDLER_BACKOFF_BASE_MS,
              maxMs: HANDLER_BACKOFF_MAX_MS,
              random,
            }),
            signal,
          );
        } catch {
          // The sleep rejects only when the signal aborted: the tag is void, nothing to acknowledge.
          return { verdict: 'abandon', cause: 'aborted', attempts: attempt };
        }
        break;
      }
      default:
        return assertNever(result, 'attempt result');
    }
  }
}

/** One attempt of steps 2–5; a `StoreError` becomes a `failed` result, anything else propagates. */
async function runAttempt({
  message,
  receivedAt,
  store,
  clock,
  signal,
  log,
}: Context): Promise<AttemptResult> {
  if (signal.aborted) {
    return { kind: 'aborted' };
  }
  let step: Step = 'insertEvent';
  try {
    const inserted = await store.insertEvent(
      toEventDocument({ message, receivedAt, processedAt: clock() }),
    );
    const duplicate = inserted === 'duplicate';
    if (duplicate) {
      log.debug('event already stored');
    }
    if (signal.aborted) {
      return { kind: 'aborted' };
    }

    step = 'applyState';
    const update = buildStateUpdate(message, receivedAt);
    let applied = await store.applyState(update);
    if (applied.result === 'duplicate') {
      // The racing first insert of a new device: the document exists now, so once more, at once.
      if (signal.aborted) {
        return { kind: 'aborted' };
      }
      applied = await store.applyState(update);
    }
    if (applied.result === 'duplicate') {
      return { kind: 'failed', step, failure: STATE_COLLISION, klass: 'transient' };
    }
    const outcome = classifyOutcome(applied.before, message);
    const gap = detectGap(applied.before, message);
    if (gap !== undefined) {
      log.info({ previousSeq: gap.previousSeq, seq: gap.seq }, 'sequence gap');
    }
    if (signal.aborted) {
      return { kind: 'aborted' };
    }

    let alert: AlertResult = 'none';
    if (message.type === 'diagnostic' && message.payload.severity === 'error') {
      step = 'insertAlert';
      const result = await store.insertAlert({
        _id: messageIdentity(message),
        deviceId: message.deviceId,
        sessionId: message.sessionId,
        seq: message.seq,
        code: message.payload.code,
        message: message.payload.message,
        occurredAt: message.occurredAt,
        createdAt: clock(),
      });
      alert = result === 'inserted' ? 'created' : 'exists';
    }
    if (signal.aborted) {
      return { kind: 'aborted' };
    }
    return { kind: 'ack', outcome, duplicate, alert, gap: gap !== undefined };
  } catch (error) {
    if (error instanceof StoreError) {
      return {
        kind: 'failed',
        step,
        failure: error.failure,
        klass: classifyFailure(error.failure),
      };
    }
    throw error;
  }
}

/** The `events` document of a message; a switch per type keeps `type` and `payload` correlated. */
function toEventDocument({
  message,
  receivedAt,
  processedAt,
}: {
  message: TelemetryMessage;
  receivedAt: number;
  processedAt: number;
}): EventDocument {
  const meta = {
    deviceId: message.deviceId,
    sessionId: message.sessionId,
    seq: message.seq,
    occurredAt: message.occurredAt,
    receivedAt,
    processedAt,
  };
  switch (message.type) {
    case 'status':
      return { ...meta, type: 'status', payload: message.payload };
    case 'metrics':
      return { ...meta, type: 'metrics', payload: message.payload };
    case 'counters':
      return { ...meta, type: 'counters', payload: message.payload };
    case 'diagnostic':
      return { ...meta, type: 'diagnostic', payload: message.payload };
    default:
      return assertNever(message, 'message type');
  }
}
