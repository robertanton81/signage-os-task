import type { TelemetryEventType, TelemetryMessageOf } from '@telemetry/shared';

const envelope = {
  v: 1,
  deviceId: 'dev-0001',
  sessionId: 1_700_000_000_000,
  occurredAt: 1_700_000_000_500,
} as const;

/**
 * One valid message per event type, for ingest's tests. Each has its own `seq`, so a test that
 * checks the identity per message would notice a mix-up between them.
 *
 * Ingest builds its own fixtures: the shared package keeps its `fixtures.ts` out of its barrel on
 * purpose (shared-contract spec, module table). Not named `*.test.ts`: the unit project would report
 * a file without tests as an empty suite.
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
