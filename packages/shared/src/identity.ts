import type { TelemetryMessage } from './message.js';

/** The dedup key of a message (consistency spec, decision 3). Projected from the schema, not redeclared. */
export type MessageIdentity = Pick<TelemetryMessage, 'deviceId' | 'sessionId' | 'seq'>;

/**
 * The order key of a message, compared lexicographically (decision 1). Deliberately independent of
 * `TelemetryMessage`: `isNewer` also takes the watermark stored on a device-state section.
 */
export type OrderKey = { sessionId: number; seq: number };

/** Identity fields found on an unvalidated value, for log lines about rejected input. */
export type RawIdentity = Partial<MessageIdentity>;

/** `deviceId:sessionId:seq` — the log field, the AMQP messageId and the `_id` of an alert. */
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
  const identity: RawIdentity = {};
  if ('deviceId' in value && typeof value.deviceId === 'string') {
    identity.deviceId = value.deviceId;
  }
  if ('sessionId' in value && typeof value.sessionId === 'number') {
    identity.sessionId = value.sessionId;
  }
  if ('seq' in value && typeof value.seq === 'number') {
    identity.seq = value.seq;
  }
  return identity;
}
