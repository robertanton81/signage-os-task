// Type-level assertions. Checked by `pnpm --filter @telemetry/shared typecheck` (tsc -b compiles
// the whole src tree); the Vitest unit project only runs *.test.ts, so nothing here executes.
import { expectTypeOf } from 'vitest';

import type {
  AlertDocument,
  DeviceStateDocument,
  DeviceStateSection,
  EventDocument,
  SectionMeta,
} from './documents.js';
import type {
  CountersPayload,
  PayloadOf,
  TelemetryEventType,
  TelemetryMessage,
} from './message.js';

// The event-type list and the schema union agree.
expectTypeOf<TelemetryMessage['type']>().toEqualTypeOf<TelemetryEventType>();

// Every event type has exactly one optional section in the state document, and nothing else.
expectTypeOf<Exclude<keyof DeviceStateDocument, '_id'>>().toEqualTypeOf<TelemetryEventType>();
// Each section is pinned to its OWN event type: the keyof check above sees only key names, so
// without this a swap (status holding a diagnostic section) would compile cleanly.
expectTypeOf<DeviceStateDocument>().toEqualTypeOf<{
  _id: string;
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
