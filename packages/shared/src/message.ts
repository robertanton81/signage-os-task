import { z } from 'zod';

/** Contract version carried by every message as `v`. Bump on an incompatible change. */
export const CONTRACT_VERSION = 1;

export const DEVICE_ID_PATTERN = /^[A-Za-z0-9_-]+$/;
export const DEVICE_ID_MAX_LENGTH = 64;
export const DIAGNOSTIC_CODE_MAX_LENGTH = 64;
export const DIAGNOSTIC_MESSAGE_MAX_LENGTH = 1024;

/**
 * Plausible window for `sessionId`, milliseconds since the epoch: 2017-07-14 to 2099-12-03.
 * One value outside it would poison a device for good — a microsecond clock is 1 000× too large
 * and stays "newer" than every later real session, a clock that was never set is 1970 and stays
 * "older" — so both are rejected loudly at validation instead of silently freezing the state.
 * The ceiling is a cliff: past it no device can open a session at all (trade-off T18).
 */
export const SESSION_ID_MIN = 1_500_000_000_000;
export const SESSION_ID_MAX = 4_100_000_000_000;

/**
 * Ceiling for `seq`, the other half of the order key. The same poisoning argument applies inside
 * one session: a single huge `seq` makes every later event of that session "older" and silently
 * stale. The damage is narrower than a bad `sessionId` — the next session resets `seq` to 1 — but
 * a device on a long-lived connection may not restart for months. A billion leaves about three
 * years of headroom at ten messages a second, and is six orders of magnitude below
 * `Number.MAX_SAFE_INTEGER`, so timestamp-shaped rubbish in this field is rejected.
 */
export const SEQ_MAX = 1_000_000_000;
export const PERCENT_MIN = 0;
export const PERCENT_MAX = 100;

export const TELEMETRY_EVENT_TYPES = ['status', 'metrics', 'counters', 'diagnostic'] as const;
export type TelemetryEventType = (typeof TELEMETRY_EVENT_TYPES)[number];

// Envelope: device identity, message identity and order (consistency spec, decisions 1–4).
// `occurredAt` is the device clock and is diagnostic only; `(sessionId, seq)` decides order.
const envelopeShape = {
  v: z.literal(CONTRACT_VERSION),
  deviceId: z.string().min(1).max(DEVICE_ID_MAX_LENGTH).regex(DEVICE_ID_PATTERN),
  sessionId: z.int().min(SESSION_ID_MIN).max(SESSION_ID_MAX),
  seq: z.int().min(1).max(SEQ_MAX),
  occurredAt: z.int().min(0),
};

// Payloads carry absolute values (decision 5); counters are cumulative per session (decision 6).
export const statusPayloadSchema = z.strictObject({
  state: z.enum(['online', 'degraded', 'offline']),
});

export const metricsPayloadSchema = z.strictObject({
  // No range check, unlike the two percentages: Celsius has no fixed domain, and the readings
  // worth keeping most — a genuine overheat or a failed sensor — are the extreme ones.
  temperatureC: z.number(),
  cpuPercent: z.number().min(PERCENT_MIN).max(PERCENT_MAX),
  ramPercent: z.number().min(PERCENT_MIN).max(PERCENT_MAX),
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
