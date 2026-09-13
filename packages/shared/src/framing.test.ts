import { describe, expect, it } from 'vitest';

import { exampleMessages } from './fixtures.js';
import {
  FrameDecoder,
  FrameTooLongError,
  MAX_FRAME_BYTES,
  decodeUtf8Strict,
  encodeFrame,
} from './framing.js';

describe('encodeFrame', () => {
  it('serialises the message as one UTF-8 JSON line', () => {
    const message = {
      ...exampleMessages.diagnostic,
      payload: { ...exampleMessages.diagnostic.payload, message: 'p\u0159eh\u0159\u00e1t\u00ed' },
    };
    const bytes = encodeFrame(message);
    expect(bytes.toString('utf8')).toBe(`${JSON.stringify(message)}\n`);
    // 'r' with a caron is two bytes in UTF-8 and one in latin1, so a changed encoding argument
    // fails here. Every other fixture in this file is ASCII, where the two agree.
    expect(bytes.includes(Buffer.from([0xc5, 0x99]))).toBe(true);
    expect(bytes.indexOf(0x0a)).toBe(bytes.length - 1);
  });

  it('keeps a newline inside a string value escaped, so the frame stays one line', () => {
    // The NDJSON decision rests on this: a raw U+000A can never come from a string field.
    const message = {
      ...exampleMessages.diagnostic,
      payload: { ...exampleMessages.diagnostic.payload, message: 'line one\nline two' },
    };
    const bytes = encodeFrame(message);
    expect(bytes.indexOf(0x0a)).toBe(bytes.length - 1);
    const result = new FrameDecoder().push(bytes);
    expect(result.frames).toEqual([JSON.stringify(message)]);
    expect(JSON.parse(result.frames[0] ?? '')).toEqual(message);
  });
});

describe('FrameDecoder', () => {
  it('returns each complete line and keeps the unfinished tail', () => {
    const decoder = new FrameDecoder();
    expect(decoder.push(Buffer.from('{"a":1}\n{"b":'))).toEqual({
      ok: true,
      frames: ['{"a":1}'],
      rejected: [],
    });
    expect(decoder.pendingBytes).toBe(5);
    expect(decoder.push(Buffer.from('2}\n'))).toEqual({
      ok: true,
      frames: ['{"b":2}'],
      rejected: [],
    });
    expect(decoder.pendingBytes).toBe(0);
  });

  it('returns several frames from one chunk in order', () => {
    const decoder = new FrameDecoder();
    expect(decoder.push(Buffer.from('1\n2\n3\n')).frames).toEqual(['1', '2', '3']);
  });

  it('reassembles a frame split inside a multi-byte character', () => {
    const bytes = Buffer.from('{"m":"čau"}\n', 'utf8');
    const cut = bytes.indexOf(0xc4) + 1; // between the two bytes of "č"
    const decoder = new FrameDecoder();
    const frames = [
      ...decoder.push(bytes.subarray(0, cut)).frames,
      ...decoder.push(bytes.subarray(cut)).frames,
    ];
    expect(frames).toEqual(['{"m":"čau"}']);
  });

  it('reassembles a frame split across three chunks', () => {
    const decoder = new FrameDecoder();
    const frames = [
      ...decoder.push(Buffer.from('{"a"')).frames,
      ...decoder.push(Buffer.from(':123')).frames,
      ...decoder.push(Buffer.from('}\n')).frames,
    ];
    expect(frames).toEqual(['{"a":123}']);
  });

  it('skips empty and whitespace-only lines and leaves a trailing carriage return in place', () => {
    const decoder = new FrameDecoder();
    const { frames } = decoder.push(Buffer.from('\n  \n{"a":1}\r\n'));
    expect(frames).toEqual(['{"a":1}\r']);
    expect(JSON.parse(frames[0] ?? '') as unknown).toEqual({ a: 1 });
  });

  it('reports a FrameTooLongError with the sizes when a completed line exceeds the limit', () => {
    const decoder = new FrameDecoder(8);
    const result = decoder.push(Buffer.from('123456789\n'));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(FrameTooLongError);
      expect(result.error).toMatchObject({ bytes: 9, limit: 8 });
      // Pinned once: the two numbers can be correct as fields and swapped in the template.
      expect(result.error.message).toBe('frame of 9 bytes exceeds the limit of 8 bytes');
    }
  });

  it('reports a FrameTooLongError when the unfinished tail exceeds the limit and resets', () => {
    const decoder = new FrameDecoder(8);
    const result = decoder.push(Buffer.from('123456789'));
    expect(result).toMatchObject({ ok: false, error: { bytes: 9, limit: 8 } });
    expect(decoder.pendingBytes).toBe(0);
    expect(decoder.push(Buffer.from('{"a":1}\n'))).toEqual({
      ok: true,
      frames: ['{"a":1}'],
      rejected: [],
    });
  });

  it('counts the buffered tail into the length of the line it belongs to', () => {
    const decoder = new FrameDecoder(8);
    expect(decoder.push(Buffer.from('12345')).ok).toBe(true);
    // 5 buffered + 4 new = 9 bytes for one line, although neither chunk alone exceeds 8.
    expect(decoder.push(Buffer.from('6789\n'))).toMatchObject({
      ok: false,
      error: { bytes: 9, limit: 8 },
    });
    expect(decoder.pendingBytes).toBe(0);
  });

  it('still returns the frames decoded before the oversized one', () => {
    const decoder = new FrameDecoder(8);
    const result = decoder.push(Buffer.from('ok\nXXXXXXXXXXXXX'));
    // The valid frame was already decoded and is no longer in the decoder; losing it would
    // silently drop telemetry from a caller that keeps the connection open.
    expect(result).toMatchObject({ ok: false, frames: ['ok'] });
    expect(decoder.pendingBytes).toBe(0);
  });

  // The case above ends without a newline, so it is the tail that is too long. Here the oversized
  // line is complete, which is the other branch that returns an error.
  it('still returns the frames decoded before an oversized completed line', () => {
    const decoder = new FrameDecoder(8);
    const result = decoder.push(Buffer.from('ok\nXXXXXXXXXXXXX\nlater\n'));
    expect(result).toMatchObject({ ok: false, frames: ['ok'] });
    expect(decoder.pendingBytes).toBe(0);
  });

  it('accepts a line and a tail of exactly the limit', () => {
    const decoder = new FrameDecoder(8);
    expect(decoder.push(Buffer.from('12345678\n'))).toEqual({
      ok: true,
      frames: ['12345678'],
      rejected: [],
    });
    expect(decoder.push(Buffer.from('abcdefgh')).ok).toBe(true);
    expect(decoder.pendingBytes).toBe(8);
  });

  it('stays usable after a completed line exceeded the limit', () => {
    const decoder = new FrameDecoder(8);
    expect(decoder.push(Buffer.from('123456789\n')).ok).toBe(false);
    expect(decoder.pendingBytes).toBe(0);
    expect(decoder.push(Buffer.from('{"a":1}\n'))).toEqual({
      ok: true,
      frames: ['{"a":1}'],
      rejected: [],
    });
  });

  it('clears a non-empty buffered tail when the limit is exceeded', () => {
    const decoder = new FrameDecoder(8);
    decoder.push(Buffer.from('ab'));
    expect(decoder.pendingBytes).toBe(2);
    // Without the reset the tail would stay at 2, so the 0 below can only come from the reset.
    expect(decoder.push(Buffer.from('cdefghij\n')).ok).toBe(false);
    expect(decoder.pendingBytes).toBe(0);
  });

  it("does not let the pending tail alias the caller's chunk buffer", () => {
    const decoder = new FrameDecoder();
    const chunk = Buffer.from('{"a":1}\n{"b":');
    expect(decoder.push(chunk).frames).toEqual(['{"a":1}']);
    chunk.fill(0); // a real socket reuses its read buffer
    expect(decoder.push(Buffer.from('2}\n')).frames).toEqual(['{"b":2}']);
  });

  it('keeps each decoder independent, so one connection cannot corrupt another', () => {
    const a = new FrameDecoder(8);
    const b = new FrameDecoder(8);
    a.push(Buffer.from('ab'));
    expect(a.push(Buffer.from('cdefghij')).ok).toBe(false);
    expect(b.push(Buffer.from('ok\n'))).toEqual({ ok: true, frames: ['ok'], rejected: [] });
    expect(b.pendingBytes).toBe(0);
  });

  it('wires the default limit to MAX_FRAME_BYTES', () => {
    const decoder = new FrameDecoder();
    expect(decoder.push(Buffer.from('x'.repeat(MAX_FRAME_BYTES))).ok).toBe(true);
    expect(decoder.push(Buffer.from('x'))).toMatchObject({
      ok: false,
      error: { bytes: MAX_FRAME_BYTES + 1, limit: MAX_FRAME_BYTES },
    });
  });

  it('costs one scan per byte when a line arrives one byte at a time', () => {
    // A misbehaving device drips bytes. Re-copying and re-scanning the whole tail on every push
    // made this quadratic: 65 536 single-byte pushes took ~280 ms of blocked event loop per
    // connection. Linear work stays far under the budget below on any machine.
    const decoder = new FrameDecoder();
    const byte = Buffer.from('x');
    let rejected = 0;
    const started = performance.now();
    for (let i = 0; i < MAX_FRAME_BYTES; i++) {
      if (!decoder.push(byte).ok) {
        rejected += 1;
      }
    }
    expect(performance.now() - started).toBeLessThan(150);
    expect(rejected).toBe(0);
    expect(decoder.pendingBytes).toBe(MAX_FRAME_BYTES);
    expect(decoder.push(Buffer.from('\n')).frames).toEqual(['x'.repeat(MAX_FRAME_BYTES)]);
  });

  it('holds the unfinished tail in bounded memory when it arrives one byte at a time', () => {
    // Linear time can be bought with a list of the chunks as they arrived, but that costs one JS
    // Buffer object per chunk: this drip then held ~9.4 MB of heap for 64 KiB of data, which is a
    // cheaper denial of service than the quadratic copying it replaced. One buffer that grows by
    // doubling uses ~0.6 MB. The bound below sits far from both numbers.
    const decoder = new FrameDecoder();
    const byte = Buffer.from('x');
    const before = process.memoryUsage().heapUsed;
    for (let i = 0; i < MAX_FRAME_BYTES; i++) {
      decoder.push(byte);
    }
    expect(decoder.pendingBytes).toBe(MAX_FRAME_BYTES);
    expect(process.memoryUsage().heapUsed - before).toBeLessThan(4 * 1024 * 1024);
  });

  // Invalid bytes are rejected, never repaired: repaired to U+FFFD inside a string value they would
  // pass JSON and the schema (shared-contract spec, decision 1, amended 2026-09-13).
  it('rejects a line that is not valid UTF-8 instead of repairing it, and keeps the stream usable', () => {
    const decoder = new FrameDecoder();
    // An invalid byte inside a string value: repaired to U+FFFD it would pass JSON and the schema
    // and be published as telemetry the device never sent.
    const corrupt = Buffer.concat([
      Buffer.from('{"a":"'),
      Buffer.from([0xff]),
      Buffer.from('"}\n'),
    ]);
    const result = decoder.push(
      Buffer.concat([Buffer.from('{"before":1}\n'), corrupt, Buffer.from('{"after":2}\n')]),
    );
    expect(result.ok).toBe(true);
    expect(result.frames).toEqual(['{"before":1}', '{"after":2}']);
    expect(result.rejected.map((rejection) => [rejection.reason, rejection.bytes])).toEqual([
      ['invalid_utf8', corrupt.length - 1],
    ]);
    expect(result.rejected[0]?.detail).toContain('utf-8');
    expect(decoder.pendingBytes).toBe(0);
  });

  it('reports every invalid line of one chunk, and still returns the valid one between them', () => {
    const decoder = new FrameDecoder();
    const bad = (text: string) => Buffer.concat([Buffer.from(text), Buffer.from([0xff, 0x0a])]);
    const result = decoder.push(
      Buffer.concat([bad('{"a":"'), Buffer.from('{"ok":1}\n'), bad('{"b":"')]),
    );
    expect(result.frames).toEqual(['{"ok":1}']);
    expect(result.rejected.map((rejection) => [rejection.reason, rejection.bytes])).toEqual([
      ['invalid_utf8', 7],
      ['invalid_utf8', 7],
    ]);
  });

  it('rejects a line whose multi-byte character is cut off at the newline', () => {
    const decoder = new FrameDecoder();
    const truncated = Buffer.from('é', 'utf8').subarray(0, 1);
    const result = decoder.push(
      Buffer.concat([Buffer.from('{"a":"'), truncated, Buffer.from('"}\n')]),
    );
    expect(result.ok).toBe(true);
    expect(result.frames).toEqual([]);
    expect(result.rejected.map((rejection) => rejection.reason)).toEqual(['invalid_utf8']);
  });

  it('rejects an invalid line that was buffered across chunks, with the whole line counted', () => {
    const decoder = new FrameDecoder();
    expect(decoder.push(Buffer.from('{"a":"ab')).rejected).toEqual([]);
    const result = decoder.push(Buffer.concat([Buffer.from([0xc3, 0x28]), Buffer.from('"}\n')]));
    expect(result.frames).toEqual([]);
    expect(result.rejected.map((rejection) => [rejection.reason, rejection.bytes])).toEqual([
      ['invalid_utf8', '{"a":"ab'.length + 2 + '"}'.length],
    ]);
    expect(decoder.push(Buffer.from('{"b":2}\n')).frames).toEqual(['{"b":2}']);
  });

  it('keeps a byte order mark as text rather than silently stripping it', () => {
    const decoder = new FrameDecoder();
    const result = decoder.push(
      Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('{"a":1}\n')]),
    );
    expect(result.frames).toEqual(['\uFEFF{"a":1}']);
    expect(result.rejected).toEqual([]);
  });

  // Every other growth case needs the tail buffer to grow one step. A single large continuation
  // needs several, and a capacity that came out short would truncate the line with no error:
  // Buffer.copy writes only what fits and pendingBytes would still report the full length.
  it('keeps every byte when one continuation chunk needs several growth steps', () => {
    const decoder = new FrameDecoder();
    const line = 'x'.repeat(5000);
    expect(decoder.push(Buffer.from(line)).ok).toBe(true);
    expect(decoder.pendingBytes).toBe(5000);
    const result = decoder.push(Buffer.from('\n'));
    expect(result.frames).toEqual([line]);
  });

  it('finishes a buffered line and decodes a further complete line in the same push', () => {
    const decoder = new FrameDecoder();
    expect(decoder.push(Buffer.from('{"a":1}')).ok).toBe(true);
    const result = decoder.push(Buffer.from('\n{"b":2}\n'));
    expect(result.frames).toEqual(['{"a":1}', '{"b":2}']);
    expect(decoder.pendingBytes).toBe(0);
  });

  it('treats an empty chunk as a no-op', () => {
    const decoder = new FrameDecoder();
    expect(decoder.push(Buffer.from('partial')).ok).toBe(true);
    expect(decoder.push(Buffer.alloc(0))).toEqual({ ok: true, frames: [], rejected: [] });
    expect(decoder.pendingBytes).toBe(7);
  });

  it('round-trips every example message', () => {
    const decoder = new FrameDecoder();
    const chunk = Buffer.concat(Object.values(exampleMessages).map(encodeFrame));
    const decoded = decoder.push(chunk).frames.map((line) => JSON.parse(line) as unknown);
    expect(decoded).toEqual(Object.values(exampleMessages));
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
