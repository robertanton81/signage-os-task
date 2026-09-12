import { describe, expect, it } from 'vitest';

import { exampleMessages } from './fixtures.js';
import {
  DIAGNOSTIC_CODE_MAX_LENGTH,
  DIAGNOSTIC_MESSAGE_MAX_LENGTH,
  TELEMETRY_EVENT_TYPES,
  telemetryMessageSchema,
} from './message.js';

describe('telemetryMessageSchema', () => {
  it.each(TELEMETRY_EVENT_TYPES)('accepts a valid %s message and returns an equal copy', (type) => {
    const input = exampleMessages[type];
    const result = telemetryMessageSchema.safeParse(input);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual(input);
      // A fresh object: processing may enrich the parsed message without touching the caller's.
      expect(result.data).not.toBe(input);
    }
  });

  it('accepts a diagnostic message that starts with a dollar sign', () => {
    // Processing stores it under $literal; the contract must not reject it (consistency spec, decision 8).
    const input = {
      ...exampleMessages.diagnostic,
      payload: { ...exampleMessages.diagnostic.payload, message: '$set is not a field path' },
    };
    expect(telemetryMessageSchema.safeParse(input).success).toBe(true);
  });

  const { status, metrics, counters, diagnostic } = exampleMessages;
  const { type: _omittedType, ...statusWithoutType } = status;
  const { occurredAt: _omittedOccurredAt, ...statusWithoutOccurredAt } = status;
  const { ramPercent: _omittedRam, ...metricsPayloadWithoutRam } = metrics.payload;

  const invalid: { name: string; input: unknown; code: string; path: PropertyKey[] }[] = [
    {
      name: 'an unknown type',
      input: { ...status, type: 'bogus' },
      code: 'invalid_union',
      path: ['type'],
    },
    { name: 'a missing type', input: statusWithoutType, code: 'invalid_union', path: ['type'] },
    {
      name: 'contract version 2',
      input: { ...status, v: 2 },
      code: 'invalid_value',
      path: ['v'],
    },
    {
      name: 'a deviceId with a space',
      input: { ...status, deviceId: 'dev 01' },
      code: 'invalid_format',
      path: ['deviceId'],
    },
    {
      name: 'a 65-character deviceId',
      input: { ...status, deviceId: 'd'.repeat(65) },
      code: 'too_big',
      path: ['deviceId'],
    },
    {
      name: 'an empty deviceId',
      input: { ...status, deviceId: '' },
      code: 'too_small',
      path: ['deviceId'],
    },
    { name: 'seq 0', input: { ...status, seq: 0 }, code: 'too_small', path: ['seq'] },
    {
      name: 'a fractional seq',
      input: { ...status, seq: 1.5 },
      code: 'invalid_type',
      path: ['seq'],
    },
    {
      name: 'sessionId 0',
      input: { ...status, sessionId: 0 },
      code: 'too_small',
      path: ['sessionId'],
    },
    {
      name: 'a fractional sessionId',
      input: { ...status, sessionId: 1.5 },
      code: 'invalid_type',
      path: ['sessionId'],
    },
    {
      name: 'a string sessionId',
      input: { ...status, sessionId: '1' },
      code: 'invalid_type',
      path: ['sessionId'],
    },
    {
      name: 'a missing occurredAt',
      input: statusWithoutOccurredAt,
      code: 'invalid_type',
      path: ['occurredAt'],
    },
    {
      name: 'an unknown envelope key',
      input: { ...status, extra: 1 },
      code: 'unrecognized_keys',
      path: [],
    },
    {
      name: 'an unknown payload key',
      input: { ...status, payload: { state: 'online', extra: 1 } },
      code: 'unrecognized_keys',
      path: ['payload'],
    },
    {
      name: 'an unknown metrics payload key',
      input: { ...metrics, payload: { ...metrics.payload, extra: 1 } },
      code: 'unrecognized_keys',
      path: ['payload'],
    },
    {
      name: 'an unknown counters payload key',
      input: { ...counters, payload: { ...counters.payload, extra: 1 } },
      code: 'unrecognized_keys',
      path: ['payload'],
    },
    {
      name: 'an unknown diagnostic payload key',
      input: { ...diagnostic, payload: { ...diagnostic.payload, extra: 1 } },
      code: 'unrecognized_keys',
      path: ['payload'],
    },
    {
      name: 'metrics without ramPercent',
      input: { ...metrics, payload: metricsPayloadWithoutRam },
      code: 'invalid_type',
      path: ['payload', 'ramPercent'],
    },
    {
      name: 'a NaN temperature',
      input: { ...metrics, payload: { ...metrics.payload, temperatureC: Number.NaN } },
      code: 'invalid_type',
      path: ['payload', 'temperatureC'],
    },
    {
      name: 'an infinite temperature',
      input: {
        ...metrics,
        payload: { ...metrics.payload, temperatureC: Number.POSITIVE_INFINITY },
      },
      code: 'invalid_type',
      path: ['payload', 'temperatureC'],
    },
    {
      name: 'a NaN cpuPercent',
      input: { ...metrics, payload: { ...metrics.payload, cpuPercent: Number.NaN } },
      code: 'invalid_type',
      path: ['payload', 'cpuPercent'],
    },
    {
      name: 'an infinite ramPercent',
      input: {
        ...metrics,
        payload: { ...metrics.payload, ramPercent: Number.POSITIVE_INFINITY },
      },
      code: 'invalid_type',
      path: ['payload', 'ramPercent'],
    },
    {
      name: 'a negative operationsTotal',
      input: { ...counters, payload: { ...counters.payload, operationsTotal: -1 } },
      code: 'too_small',
      path: ['payload', 'operationsTotal'],
    },
    {
      name: 'a fractional uptimeMs',
      input: { ...counters, payload: { ...counters.payload, uptimeMs: 0.5 } },
      code: 'invalid_type',
      path: ['payload', 'uptimeMs'],
    },
    {
      name: 'a fractional operationsTotal',
      input: { ...counters, payload: { ...counters.payload, operationsTotal: 0.5 } },
      code: 'invalid_type',
      path: ['payload', 'operationsTotal'],
    },
    {
      name: 'a negative uptimeMs',
      input: { ...counters, payload: { ...counters.payload, uptimeMs: -1 } },
      code: 'too_small',
      path: ['payload', 'uptimeMs'],
    },
    {
      name: 'an unknown status state',
      input: { ...status, payload: { state: 'rebooting' } },
      code: 'invalid_value',
      path: ['payload', 'state'],
    },
    {
      name: 'an unknown severity',
      input: { ...diagnostic, payload: { ...diagnostic.payload, severity: 'fatal' } },
      code: 'invalid_value',
      path: ['payload', 'severity'],
    },
    {
      name: 'an empty diagnostic code',
      input: { ...diagnostic, payload: { ...diagnostic.payload, code: '' } },
      code: 'too_small',
      path: ['payload', 'code'],
    },
    {
      name: 'a diagnostic code over the limit',
      input: {
        ...diagnostic,
        payload: { ...diagnostic.payload, code: 'x'.repeat(DIAGNOSTIC_CODE_MAX_LENGTH + 1) },
      },
      code: 'too_big',
      path: ['payload', 'code'],
    },
    {
      name: 'a diagnostic message over the limit',
      input: {
        ...diagnostic,
        payload: {
          ...diagnostic.payload,
          message: 'x'.repeat(DIAGNOSTIC_MESSAGE_MAX_LENGTH + 1),
        },
      },
      code: 'too_big',
      path: ['payload', 'message'],
    },
    { name: 'a non-object', input: 'text', code: 'invalid_type', path: [] },
    { name: 'null', input: null, code: 'invalid_type', path: [] },
  ];

  it.each(invalid)('rejects $name with $code at $path', ({ input, code, path }) => {
    const result = telemetryMessageSchema.safeParse(input);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toContainEqual(expect.objectContaining({ code, path }));
    }
  });
});
