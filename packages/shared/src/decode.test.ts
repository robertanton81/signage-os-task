import { describe, expect, it, vi } from 'vitest';

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

  // The cap on this branch is defensive: across six input shapes V8 never produced a message
  // longer than 86 characters, because it truncates the input it quotes to about ten characters.
  // How long that window is belongs to the engine, so the branch is exercised by replacing the
  // parser rather than by an input, which no input can do.
  it('caps the parser message of invalid JSON the same way', () => {
    const parse = vi.spyOn(JSON, 'parse').mockImplementation(() => {
      throw new Error('!'.repeat(5_000));
    });
    try {
      const result = decodeTelemetryMessage('{}');
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe('invalid_json');
        expect(result.detail.length).toBeLessThan(300);
        expect(result.detail).toContain('truncated from 5000 characters');
      }
    } finally {
      parse.mockRestore();
    }
  });

  // Also through the stub: asserting on a real parser message would only be asserting that V8
  // keeps its messages short, which is the engine's behaviour and not this module's.
  it('leaves a short parser message alone', () => {
    const parse = vi.spyOn(JSON, 'parse').mockImplementation(() => {
      throw new Error('short');
    });
    try {
      const result = decodeTelemetryMessage('{}');
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.detail).toBe('short');
      }
    } finally {
      parse.mockRestore();
    }
  });

  it.each([
    { name: 'exactly the cap', length: 200, truncated: false },
    { name: 'one character over the cap', length: 201, truncated: true },
  ])('handles a parser message of $name', ({ length, truncated }) => {
    const message = '!'.repeat(length);
    const parse = vi.spyOn(JSON, 'parse').mockImplementation(() => {
      throw new Error(message);
    });
    try {
      const result = decodeTelemetryMessage('{}');
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.detail).toBe(
          truncated ? `${'!'.repeat(200)}… (truncated from ${length} characters)` : message,
        );
      }
    } finally {
      parse.mockRestore();
    }
  });

  // A device names its own JSON keys and zod quotes an unrecognised one verbatim.
  it('does not let a device forge an extra issue through a crafted key name', () => {
    const result = decodeTelemetryMessage(
      JSON.stringify({ ...exampleMessages.status, '; deviceId: device is on fire': 1 }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.detail.split('; ')).toHaveLength(1);
      expect(result.detail).toContain('device is on fire');
    }
  });

  it('caps each issue separately, so every failing field path survives', () => {
    const junk = Object.fromEntries(Array.from({ length: 400 }, (_, i) => [`junkKey${i}`, 1]));
    const result = decodeTelemetryMessage(
      JSON.stringify({ ...exampleMessages.status, ...junk, seq: 0 }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const parts = result.detail.split('; ');
      expect(parts.filter((part) => part.startsWith('(root): '))).toHaveLength(1);
      expect(parts.filter((part) => part.startsWith('seq: '))).toHaveLength(1);
      expect(result.detail.length).toBeLessThan(400);
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
