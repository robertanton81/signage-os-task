import { DEVICE_ID_MAX_LENGTH, DEVICE_ID_PATTERN, type TelemetryMessage } from './message.js';

/** The dedup key of a message (consistency spec, decision 3). Projected from the schema, not redeclared. */
export type MessageIdentity = Pick<TelemetryMessage, 'deviceId' | 'sessionId' | 'seq'>;

/**
 * The order key of a message, compared lexicographically (decision 1). Deliberately independent of
 * `TelemetryMessage`: `isNewer` also takes the watermark stored on a device-state section.
 */
export type OrderKey = { sessionId: number; seq: number };

/** Identity fields found on an unvalidated value, for log lines about rejected input. */
export type RawIdentity = Partial<MessageIdentity>;

/**
 * `deviceId:sessionId:seq` — the log field, the AMQP messageId and the `_id` of an alert.
 * Callers must pass fields the schema has validated. The string is only collision-free because
 * `DEVICE_ID_PATTERN` forbids a colon; never build it from `RawIdentity`, whose fields come from
 * a message that failed validation.
 */
export function messageIdentity(message: MessageIdentity): string {
  return `${message.deviceId}:${message.sessionId}:${message.seq}`;
}

/**
 * The order key as a tuple, for logging and for building a storage key.
 * Never compare two of these with `<` or `>`: JavaScript compares arrays by string coercion, so
 * `[2, 1] > [10, 50]` is `true`, which is numerically backwards. Only `isNewer` decides order.
 */
export function orderKey(message: OrderKey): readonly [sessionId: number, seq: number] {
  return [message.sessionId, message.seq];
}

/**
 * The single definition of "newer" (decision 8). Equal keys are duplicates and are not newer.
 * The MongoDB update pipeline in processing is derived from this function and tested against it.
 */
export function isNewer(candidate: OrderKey, stored: OrderKey): boolean {
  return (
    candidate.sessionId > stored.sessionId ||
    (candidate.sessionId === stored.sessionId && candidate.seq > stored.seq)
  );
}

export function extractRawIdentity(value: unknown): RawIdentity {
  if (typeof value !== 'object' || value === null) {
    return {};
  }
  // `in` rather than Object.hasOwn: TypeScript 6.0.3 declares hasOwn as returning plain `boolean`,
  // so it does not narrow `unknown`. The only caller passes `JSON.parse` output, which never has
  // inherited properties, so the two are equivalent here.
  // This object lands on every log line about a rejected frame, and the frame is whatever the
  // device sent, so each field is kept only when it could belong to a real message.
  const identity: RawIdentity = {};
  // A `deviceId` is kept only when it satisfies the contract exactly. Truncating an oversized one
  // instead would put its first 64 characters on the line, and those can be another device's id —
  // a device could make its own rejected frames look like that device's. Dropping it also removes
  // control characters, ANSI escapes and half of a split surrogate pair in one rule. Cost named: a
  // frame whose `deviceId` is itself malformed logs no device id, and the zod issue in `detail`
  // already says which field was wrong.
  if (
    'deviceId' in value &&
    typeof value.deviceId === 'string' &&
    value.deviceId.length <= DEVICE_ID_MAX_LENGTH &&
    DEVICE_ID_PATTERN.test(value.deviceId)
  ) {
    identity.deviceId = value.deviceId;
  }
  // `Number.isSafeInteger` is declared `(number: unknown) => boolean` in TypeScript 6.0.3
  // (`lib.es2015.core.d.ts`), a plain boolean and not a type predicate, so it does not narrow
  // `unknown`: the `typeof` check in front of it is what makes the assignment type-check.
  // It also rejects what `Number.isFinite` would let through — `2 ** 53` and `1.5` — and
  // `Infinity`, which pino prints as `null`.
  if (
    'sessionId' in value &&
    typeof value.sessionId === 'number' &&
    Number.isSafeInteger(value.sessionId)
  ) {
    identity.sessionId = value.sessionId;
  }
  if ('seq' in value && typeof value.seq === 'number' && Number.isSafeInteger(value.seq)) {
    identity.seq = value.seq;
  }
  return identity;
}
