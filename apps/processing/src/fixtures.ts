import {
  messageIdentity,
  type AlertDocument,
  type DeviceStateDocument,
  type EventDocument,
  type TelemetryEventType,
  type TelemetryMessageOf,
} from '@telemetry/shared';

/** The `x-received-at` header value the tests attach: ingest's clock, after `occurredAt`. */
export const EXAMPLE_RECEIVED_AT = 1_700_000_000_600;
/** The handler's clock in the tests: `processedAt` and an alert's `createdAt`. */
export const EXAMPLE_PROCESSED_AT = 1_700_000_000_700;

const envelope = {
  v: 1,
  deviceId: 'dev-0001',
  sessionId: 1_700_000_000_000,
  occurredAt: 1_700_000_000_500,
} as const;

/**
 * One valid message per event type, for processing's tests: ingest's literals, one `seq` each, so
 * a test that checks the identity per message would notice a mix-up between them. Processing builds
 * its own fixtures: the shared package keeps its `fixtures.ts` out of its barrel on purpose
 * (shared-contract spec, module table; processing spec, decision 25). Not named `*.test.ts`: the
 * unit project would report a file without tests as an empty suite.
 */
export const exampleMessages: { [T in TelemetryEventType]: TelemetryMessageOf<T> } = {
  status: { ...envelope, seq: 1, type: 'status', payload: { state: 'online' } },
  metrics: {
    ...envelope,
    seq: 2,
    type: 'metrics',
    payload: { temperatureC: 41.5, cpuPercent: 12.25, ramPercent: 63 },
  },
  counters: {
    ...envelope,
    seq: 3,
    type: 'counters',
    payload: { operationsTotal: 120, uptimeMs: 3_600_000 },
  },
  diagnostic: {
    ...envelope,
    seq: 4,
    type: 'diagnostic',
    payload: { severity: 'error', code: 'E_OVERHEAT', message: 'temperature above threshold' },
  },
};

const eventMeta = {
  deviceId: envelope.deviceId,
  sessionId: envelope.sessionId,
  occurredAt: envelope.occurredAt,
  receivedAt: EXAMPLE_RECEIVED_AT,
  processedAt: EXAMPLE_PROCESSED_AT,
} as const;

/** The `events` document each example message produces. */
export const exampleEvents: { [T in TelemetryEventType]: Extract<EventDocument, { type: T }> } = {
  status: { ...eventMeta, seq: 1, type: 'status', payload: { state: 'online' } },
  metrics: {
    ...eventMeta,
    seq: 2,
    type: 'metrics',
    payload: { temperatureC: 41.5, cpuPercent: 12.25, ramPercent: 63 },
  },
  counters: {
    ...eventMeta,
    seq: 3,
    type: 'counters',
    payload: { operationsTotal: 120, uptimeMs: 3_600_000 },
  },
  diagnostic: {
    ...eventMeta,
    seq: 4,
    type: 'diagnostic',
    payload: { severity: 'error', code: 'E_OVERHEAT', message: 'temperature above threshold' },
  },
};

/** The alert of the diagnostic message: `_id` is its identity string. */
export const exampleAlert: AlertDocument = {
  _id: messageIdentity(exampleMessages.diagnostic),
  deviceId: envelope.deviceId,
  sessionId: envelope.sessionId,
  seq: 4,
  code: 'E_OVERHEAT',
  message: 'temperature above threshold',
  occurredAt: envelope.occurredAt,
  createdAt: EXAMPLE_PROCESSED_AT,
};

const sectionMeta = {
  sessionId: envelope.sessionId,
  occurredAt: envelope.occurredAt,
  receivedAt: EXAMPLE_RECEIVED_AT,
} as const;

/** The `device_state` document after the four example messages in `seq` order. */
export const exampleState: DeviceStateDocument = {
  _id: envelope.deviceId,
  lastEvent: {
    sessionId: envelope.sessionId,
    seq: 4,
    type: 'diagnostic',
    receivedAt: EXAMPLE_RECEIVED_AT,
  },
  status: { ...sectionMeta, seq: 1, state: 'online' },
  metrics: { ...sectionMeta, seq: 2, temperatureC: 41.5, cpuPercent: 12.25, ramPercent: 63 },
  counters: { ...sectionMeta, seq: 3, operationsTotal: 120, uptimeMs: 3_600_000 },
  diagnostic: {
    ...sectionMeta,
    seq: 4,
    severity: 'error',
    code: 'E_OVERHEAT',
    message: 'temperature above threshold',
  },
};
