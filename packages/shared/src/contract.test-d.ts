// Type-level assertions. Checked by `pnpm --filter @telemetry/shared typecheck` (tsc -b compiles
// the whole src tree); the Vitest unit project only runs *.test.ts, so nothing here executes.
import { expectTypeOf } from 'vitest';

import { EVENTS_IDENTITY_INDEX_SPEC } from './collections.js';
import type {
  AlertDocument,
  DeviceStateDocument,
  DeviceStateSection,
  EventDocument,
  LastEvent,
  SectionMeta,
} from './documents.js';
import type {
  CountersPayload,
  PayloadOf,
  TelemetryEventType,
  TelemetryMessage,
} from './message.js';
import {
  DEAD_LETTER_EXCHANGE_OPTIONS,
  DEAD_LETTER_QUEUE_OPTIONS,
  TELEMETRY_EXCHANGE_OPTIONS,
  TELEMETRY_QUEUE_OPTIONS,
} from './topology.js';

// The event-type list and the schema union agree.
expectTypeOf<TelemetryMessage['type']>().toEqualTypeOf<TelemetryEventType>();

// Every event type has exactly one optional section in the state document; the only other
// fields are the id and the device-wide watermark.
expectTypeOf<
  Exclude<keyof DeviceStateDocument, '_id' | 'lastEvent'>
>().toEqualTypeOf<TelemetryEventType>();
// Each section is pinned to its OWN event type: the keyof check above sees only key names, so
// without this a swap (status holding a diagnostic section) would compile cleanly.
expectTypeOf<DeviceStateDocument>().toEqualTypeOf<{
  _id: string;
  lastEvent?: LastEvent;
  status?: DeviceStateSection<'status'>;
  metrics?: DeviceStateSection<'metrics'>;
  counters?: DeviceStateSection<'counters'>;
  diagnostic?: DeviceStateSection<'diagnostic'>;
}>();

/**
 * No payload field may be named like a watermark field. The update pipeline builds a section as
 * `{ ...meta, ...payload }`, so a collision would overwrite the watermark and break invariant 1.
 * The mapped type is required: `keyof PayloadOf<TelemetryEventType>` is the intersection of the
 * four payload key sets, which is already `never`, so it would pass whatever happened.
 */
type SectionMetaCollision = {
  [T in TelemetryEventType]: keyof PayloadOf<T> & keyof SectionMeta;
}[TelemetryEventType];
expectTypeOf<SectionMetaCollision>().toBeNever();
// The four fields are inlined on purpose, not written as `SectionMeta & CountersPayload`:
// this is the only assertion that would catch a field added to or removed from SectionMeta.
expectTypeOf<DeviceStateSection<'counters'>>().toEqualTypeOf<
  { sessionId: number; seq: number; occurredAt: number; receivedAt: number } & CountersPayload
>();

// The event document narrows its payload by type and has no _id (the driver adds the ObjectId).
expectTypeOf<Extract<EventDocument, { type: 'counters' }>>().toEqualTypeOf<{
  deviceId: string;
  sessionId: number;
  seq: number;
  type: 'counters';
  occurredAt: number;
  receivedAt: number;
  processedAt: number;
  payload: CountersPayload;
}>();
expectTypeOf<Extract<keyof EventDocument, '_id'>>().toBeNever();

// Alerts are keyed by the message identity string. The whole shape is pinned: nothing else in the
// repository consumes AlertDocument yet, so this file is its only check.
expectTypeOf<AlertDocument>().toEqualTypeOf<{
  _id: string;
  deviceId: string;
  sessionId: number;
  seq: number;
  code: string;
  message: string;
  occurredAt: number;
  createdAt: number;
}>();

// The one index option invariant 2 depends on, and the declaration options both services must
// agree on, are literally `true` in the shared definitions. A mismatch on redeclaration is a 406
// PRECONDITION_FAILED for the exchanges and the queues, and an index conflict for `unique`.
expectTypeOf(EVENTS_IDENTITY_INDEX_SPEC.unique).toEqualTypeOf<true>();
expectTypeOf(TELEMETRY_EXCHANGE_OPTIONS.durable).toEqualTypeOf<true>();
expectTypeOf(DEAD_LETTER_EXCHANGE_OPTIONS.durable).toEqualTypeOf<true>();
expectTypeOf(TELEMETRY_QUEUE_OPTIONS.durable).toEqualTypeOf<true>();
expectTypeOf(DEAD_LETTER_QUEUE_OPTIONS.durable).toEqualTypeOf<true>();
