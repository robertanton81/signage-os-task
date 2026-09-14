import {
  isNewer,
  type DeviceStateDocument,
  type OrderKey,
  type TelemetryMessage,
} from '@telemetry/shared';

/**
 * The one write that enforces invariants 1–3: a single-document pipeline update on the `_id`
 * filter (consistency spec, decision 8; processing spec, decision 18). Driver-free: the pipeline is
 * plain objects, and it is mutable because the driver's `findOneAndUpdate` takes a `Document[]`,
 * to which a readonly array is not assignable.
 */
export type StateUpdate = {
  filter: { _id: string };
  pipeline: Record<string, unknown>[];
};

export type StateOutcome = 'created' | 'applied' | 'stale';

export type SequenceGap = { previousSeq: number; seq: number };

/**
 * `isNewer(key, stored)` as an aggregation expression over the stored watermark at `path`: the
 * section is missing, or its session is older, or the session is the same and its `seq` lower.
 * Evaluated by the server against the document as it is at the moment of the update, so two
 * concurrent writers cannot both win with a stale key (consistency spec, "The conditional upsert").
 * The unit test runs it against `isNewer` over the spec's five cases; step 7 runs it on the server.
 */
export function newerThanStoredExpr(path: string, key: OrderKey): Record<string, unknown> {
  const field = `$${path}`;
  return {
    $or: [
      { $eq: [{ $type: field }, 'missing'] },
      { $lt: [`${field}.sessionId`, key.sessionId] },
      {
        $and: [{ $eq: [`${field}.sessionId`, key.sessionId] }, { $lt: [`${field}.seq`, key.seq] }],
      },
    ],
  };
}

/**
 * One `$set` stage: the message's section and `lastEvent`, each replaced only when the message is
 * newer than what is stored, otherwise kept as it is. Both `then` values sit under `$literal`,
 * because a pipeline parses an object as an expression and a diagnostic `message` that starts with
 * `$` would be read as a field path.
 */
export function buildStateUpdate(message: TelemetryMessage, receivedAt: number): StateUpdate {
  const key: OrderKey = { sessionId: message.sessionId, seq: message.seq };
  const section = {
    sessionId: message.sessionId,
    seq: message.seq,
    occurredAt: message.occurredAt,
    receivedAt,
    ...message.payload,
  };
  const lastEvent = {
    sessionId: message.sessionId,
    seq: message.seq,
    type: message.type,
    receivedAt,
  };
  return {
    filter: { _id: message.deviceId },
    pipeline: [
      {
        $set: {
          [message.type]: {
            $cond: {
              if: newerThanStoredExpr(message.type, key),
              then: { $literal: section },
              else: `$${message.type}`,
            },
          },
          lastEvent: {
            $cond: {
              if: newerThanStoredExpr('lastEvent', key),
              then: { $literal: lastEvent },
              else: '$lastEvent',
            },
          },
        },
      },
    ],
  };
}

/**
 * The outcome of the state write, read from the document as it was before the update
 * (`returnDocument: 'before'`, consistency spec decision 29): no document → the upsert created it;
 * the section absent or older → replaced; otherwise the stored section is newer or has the same
 * key and nothing changed. The same rule as the server's expression, through the one `isNewer`.
 */
export function classifyOutcome(
  before: DeviceStateDocument | null,
  message: TelemetryMessage,
): StateOutcome {
  if (before === null) {
    return 'created';
  }
  const stored = before[message.type];
  return stored === undefined || isNewer(message, stored) ? 'applied' : 'stale';
}

/**
 * A skipped `seq` within one session (consistency spec, decision 27; processing spec, decision
 * 17): defined only when the previous `lastEvent` belongs to the same session and the message
 * jumps past `seq + 1`. A stale or duplicate message never satisfies the condition, and a new
 * session never compares against the old one.
 */
export function detectGap(
  before: DeviceStateDocument | null,
  message: TelemetryMessage,
): SequenceGap | undefined {
  const last = before?.lastEvent;
  if (last === undefined || last.sessionId !== message.sessionId || message.seq <= last.seq + 1) {
    return undefined;
  }
  return { previousSeq: last.seq, seq: message.seq };
}
