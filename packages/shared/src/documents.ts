import type { PayloadOf, TelemetryEventType } from './message.js';

/**
 * Watermark and provenance stored with every section (consistency spec, decision 7).
 * The three message fields come from the schema; `receivedAt` is stamped by ingest and has no
 * schema source. No payload may use these names — `contract.test-d.ts` enforces that, because the
 * update pipeline spreads the payload last and a collision would silently overwrite the watermark.
 */
export type SectionMeta = {
  sessionId: number;
  seq: number;
  occurredAt: number;
  receivedAt: number;
};

/** The newest unique event of one type, with its own `(sessionId, seq)` watermark. */
export type DeviceStateSection<T extends TelemetryEventType> = SectionMeta & PayloadOf<T>;

/**
 * Device-wide watermark: the newest unique event of any type (consistency spec, decision 27).
 * Advanced by the same conditional pipeline as the sections, only when the event is newer, so a
 * stale message still changes nothing. It is the "as of" marker of the document, the input for
 * liveness (`now - receivedAt`) and the reference for gap detection (`seq` skipped a value).
 */
export type LastEvent = {
  sessionId: number;
  seq: number;
  type: TelemetryEventType;
  receivedAt: number;
};

/**
 * One document per device in `device_state`; `_id` is the device id. A section is absent until
 * the first event of its type arrives. There is deliberately no unconditional `updatedAt`: every
 * field, `lastEvent` included, moves only when an event is newer than what is stored.
 */
export type DeviceStateDocument = {
  _id: string;
  lastEvent?: LastEvent;
  status?: DeviceStateSection<'status'>;
  metrics?: DeviceStateSection<'metrics'>;
  counters?: DeviceStateSection<'counters'>;
  diagnostic?: DeviceStateSection<'diagnostic'>;
};

/**
 * One document per unique event in `events`. `_id` is left to the driver (an ObjectId);
 * `(deviceId, sessionId, seq)` is the unique dedup key (EVENTS_IDENTITY_INDEX).
 */
export type EventDocument = {
  [T in TelemetryEventType]: {
    deviceId: string;
    sessionId: number;
    seq: number;
    type: T;
    occurredAt: number;
    receivedAt: number;
    processedAt: number;
    payload: PayloadOf<T>;
  };
}[TelemetryEventType];

/** One document per error diagnostic in `alerts`; `_id` is the message identity string. */
export type AlertDocument = {
  _id: string;
  deviceId: string;
  sessionId: number;
  seq: number;
  code: string;
  message: string;
  occurredAt: number;
  createdAt: number;
};
