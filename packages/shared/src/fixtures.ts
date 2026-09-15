import type { TelemetryEventType, TelemetryMessageOf } from './message.js';

const envelope = {
  v: 1,
  deviceId: 'dev-0001',
  sessionId: 1_700_000_000_000,
  seq: 1,
  occurredAt: 1_700_000_000_500,
} as const;

/** One valid message per event type for this package's tests. Kept out of the package's public exports in index.ts — later packages build their own fixtures. */
export const exampleMessages: { [T in TelemetryEventType]: TelemetryMessageOf<T> } = {
  status: { ...envelope, type: 'status', payload: { state: 'online' } },
  metrics: {
    ...envelope,
    type: 'metrics',
    payload: { temperatureC: 41.5, cpuPercent: 12.25, ramPercent: 63 },
  },
  counters: {
    ...envelope,
    type: 'counters',
    payload: { operationsTotal: 120, uptimeMs: 3_600_000 },
  },
  diagnostic: {
    ...envelope,
    type: 'diagnostic',
    payload: { severity: 'error', code: 'E_OVERHEAT', message: 'temperature above threshold' },
  },
};

/** A valid status message with envelope overrides, for tests that only care about identity and order. */
export function makeStatusMessage(
  overrides: Partial<Omit<TelemetryMessageOf<'status'>, 'type' | 'payload'>> = {},
): TelemetryMessageOf<'status'> {
  return { ...exampleMessages.status, ...overrides };
}
