import { describe, expect, it } from 'vitest';

import { decodeTelemetryMessage } from './decode.js';
import { exampleMessages } from './fixtures.js';
import {
  MAX_FRAME_BYTES,
  TELEMETRY_SOCKET_PATH,
  decodeUtf8Strict,
  encodeMessage,
} from './framing.js';

describe('encodeMessage', () => {
  it('produces compact JSON on one line, with a newline inside a string value escaped', () => {
    const message = {
      ...exampleMessages.diagnostic,
      payload: { ...exampleMessages.diagnostic.payload, message: 'line one\nline two' },
    };
    const text = encodeMessage(message);
    expect(text).toBe(JSON.stringify(message));
    expect(text.includes('\n')).toBe(false);
    // No whitespace between tokens: the text is the AMQP body byte for byte.
    expect(text.includes(': ')).toBe(false);
    expect(text.includes(', ')).toBe(false);
  });

  it.each(Object.values(exampleMessages))(
    'round-trips the $type fixture through the decoder',
    (message) => {
      expect(decodeTelemetryMessage(encodeMessage(message))).toEqual({ ok: true, message });
    },
  );

  it('stays far below the message bound for a valid message', () => {
    const longest = Math.max(
      ...Object.values(exampleMessages).map((message) => Buffer.byteLength(encodeMessage(message))),
    );
    expect(longest).toBeLessThan(1024);
    expect(longest).toBeLessThan(MAX_FRAME_BYTES);
  });
});

describe('TELEMETRY_SOCKET_PATH', () => {
  it('is the absolute path of the device endpoint', () => {
    expect(TELEMETRY_SOCKET_PATH).toBe('/telemetry');
    expect(new URL(TELEMETRY_SOCKET_PATH, 'ws://ingest:4000').pathname).toBe('/telemetry');
  });
});

describe('decodeUtf8Strict', () => {
  it('decodes valid UTF-8, multi-byte characters included', () => {
    expect(decodeUtf8Strict(Buffer.from('{"m":"přehřátí"}', 'utf8'))).toEqual({
      ok: true,
      text: '{"m":"přehřátí"}',
    });
  });

  it('reports an invalid sequence instead of substituting U+FFFD', () => {
    const result = decodeUtf8Strict(Buffer.from([0x61, 0xff, 0x62]));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.detail).toContain('utf-8');
    }
  });

  it('reports a sequence cut off at the end', () => {
    expect(decodeUtf8Strict(Buffer.from([0xe2, 0x82])).ok).toBe(false);
  });

  it('decodes an empty input to an empty string', () => {
    expect(decodeUtf8Strict(Buffer.alloc(0))).toEqual({ ok: true, text: '' });
  });
});
