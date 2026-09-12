import { describe, expect, it } from 'vitest';

import { decodeTelemetryMessage } from './decode.js';
import { exampleMessages } from './fixtures.js';

describe('decodeTelemetryMessage', () => {
  it('returns the validated message for a valid frame', () => {
    const result = decodeTelemetryMessage(JSON.stringify(exampleMessages.metrics));
    expect(result).toEqual({ ok: true, message: exampleMessages.metrics });
  });

  it('reports invalid JSON with the parser message and no identity', () => {
    const result = decodeTelemetryMessage('{"deviceId":');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('invalid_json');
      // The real parser message must be forwarded, not a placeholder that merely says "JSON".
      let expected = '';
      try {
        JSON.parse('{"deviceId":');
      } catch (error) {
        expected = (error as Error).message;
      }
      expect(result.detail).toBe(expected);
      expect(result.identity).toEqual({});
    }
  });

  it('reports a schema violation with the offending path and the identity fields', () => {
    const input = {
      ...exampleMessages.metrics,
      payload: { ...exampleMessages.metrics.payload, temperatureC: 'hot' },
    };
    const result = decodeTelemetryMessage(JSON.stringify(input));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('invalid_schema');
      expect(result.detail).toMatch(/^payload\.temperatureC: /);
      expect(result.identity).toEqual({
        deviceId: input.deviceId,
        sessionId: input.sessionId,
        seq: input.seq,
      });
    }
  });

  it('renders an empty issue path as (root)', () => {
    const result = decodeTelemetryMessage('"text"');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.detail).toMatch(/^\(root\): /);
    }
  });

  it('lists every issue exactly once, joined by a semicolon', () => {
    const result = decodeTelemetryMessage(
      JSON.stringify({ ...exampleMessages.status, seq: 0, v: 2 }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const parts = result.detail.split('; ');
      expect(parts).toHaveLength(2);
      expect(parts.filter((part) => part.startsWith('v: '))).toHaveLength(1);
      expect(parts.filter((part) => part.startsWith('seq: '))).toHaveLength(1);
    }
  });

  it('keeps only identity fields of the right type', () => {
    const result = decodeTelemetryMessage(JSON.stringify({ deviceId: 7, sessionId: 1, seq: 'x' }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.identity).toEqual({ sessionId: 1 });
    }
  });

  it('caps detail so a device cannot drive the log line size', () => {
    // zod quotes unrecognized key names verbatim, so the text is device-controlled.
    const junk = Object.fromEntries(Array.from({ length: 400 }, (_, i) => [`junkKey${i}`, 1]));
    const result = decodeTelemetryMessage(JSON.stringify({ ...exampleMessages.status, ...junk }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.detail.length).toBeLessThan(600);
      expect(result.detail).toMatch(/truncated from \d+ characters\)$/);
    }
  });

  // The no-throw contract is the reason this function exists, so it is proved per hostile input
  // rather than once: each of these reaches a different part of the pipeline.
  it.each([
    { name: 'an empty frame', text: '' },
    { name: 'deeply nested JSON', text: `${'['.repeat(100_000)}${']'.repeat(100_000)}` },
    { name: 'a JSON null', text: 'null' },
    { name: 'a JSON array', text: '[]' },
    {
      name: 'an own __proto__ key',
      text: '{"__proto__":{"polluted":true},"type":"status"}',
    },
    { name: 'a lone surrogate', text: '"\ud800"' },
  ])('never throws for $name', ({ text }) => {
    expect(() => decodeTelemetryMessage(text)).not.toThrow();
    expect(decodeTelemetryMessage(text).ok).toBe(false);
  });

  it('does not pollute Object.prototype through a __proto__ key', () => {
    decodeTelemetryMessage('{"__proto__":{"polluted":true},"type":"status"}');
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
  });
});
