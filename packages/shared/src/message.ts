import { z } from 'zod';

/** Contract version carried by every message as `v`. Bump on an incompatible change. */
export const CONTRACT_VERSION = 1;

export const DEVICE_ID_PATTERN = /^[A-Za-z0-9_-]+$/;
export const DEVICE_ID_MAX_LENGTH = 64;
export const DIAGNOSTIC_CODE_MAX_LENGTH = 64;
export const DIAGNOSTIC_MESSAGE_MAX_LENGTH = 1024;

export const TELEMETRY_EVENT_TYPES = ['status', 'metrics', 'counters', 'diagnostic'] as const;
export type TelemetryEventType = (typeof TELEMETRY_EVENT_TYPES)[number];

// Envelope: device identity, message identity and order (consistency spec, decisions 1–4).
// `occurredAt` is the device clock and is diagnostic only; `(sessionId, seq)` decides order.
const envelopeShape = {
  v: z.literal(CONTRACT_VERSION),
  deviceId: z.string().min(1).max(DEVICE_ID_MAX_LENGTH).regex(DEVICE_ID_PATTERN),
  sessionId: z.int().min(1),
  seq: z.int().min(1),
  occurredAt: z.int(),
};

// Payloads carry absolute values (decision 5); counters are cumulative per session (decision 6).
export const statusPayloadSchema = z.strictObject({
  state: z.enum(['online', 'degraded', 'offline']),
});

export const metricsPayloadSchema = z.strictObject({
  temperatureC: z.number(),
  cpuPercent: z.number(),
  ramPercent: z.number(),
});

export const countersPayloadSchema = z.strictObject({
  operationsTotal: z.int().min(0),
  uptimeMs: z.int().min(0),
});

export const diagnosticPayloadSchema = z.strictObject({
  severity: z.enum(['info', 'warning', 'error']),
  code: z.string().min(1).max(DIAGNOSTIC_CODE_MAX_LENGTH),
  message: z.string().max(DIAGNOSTIC_MESSAGE_MAX_LENGTH),
});

/** The whole message. Strict everywhere: unknown keys are rejected at any level. */
export const telemetryMessageSchema = z.discriminatedUnion('type', [
  z.strictObject({ ...envelopeShape, type: z.literal('status'), payload: statusPayloadSchema }),
  z.strictObject({ ...envelopeShape, type: z.literal('metrics'), payload: metricsPayloadSchema }),
  z.strictObject({
    ...envelopeShape,
    type: z.literal('counters'),
    payload: countersPayloadSchema,
  }),
  z.strictObject({
    ...envelopeShape,
    type: z.literal('diagnostic'),
    payload: diagnosticPayloadSchema,
  }),
]);

export type TelemetryMessage = z.infer<typeof telemetryMessageSchema>;
export type TelemetryMessageOf<T extends TelemetryEventType> = Extract<
  TelemetryMessage,
  { type: T }
>;
export type PayloadOf<T extends TelemetryEventType> = TelemetryMessageOf<T>['payload'];
export type StatusPayload = z.infer<typeof statusPayloadSchema>;
export type MetricsPayload = z.infer<typeof metricsPayloadSchema>;
export type CountersPayload = z.infer<typeof countersPayloadSchema>;
export type DiagnosticPayload = z.infer<typeof diagnosticPayloadSchema>;
