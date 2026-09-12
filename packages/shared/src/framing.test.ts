import { describe, expect, it } from 'vitest';

import { exampleMessages } from './fixtures.js';
import { FrameDecoder, FrameTooLongError, MAX_FRAME_BYTES, encodeFrame } from './framing.js';

describe('encodeFrame', () => {
  it('serialises the message as one JSON line', () => {
    const message = exampleMessages.status;
    expect(encodeFrame(message).toString('utf8')).toBe(`${JSON.stringify(message)}\n`);
  });
});

describe('FrameDecoder', () => {
  it('returns each complete line and keeps the unfinished tail', () => {
    const decoder = new FrameDecoder();
    expect(decoder.push(Buffer.from('{"a":1}\n{"b":'))).toEqual(['{"a":1}']);
    expect(decoder.pendingBytes).toBe(5);
    expect(decoder.push(Buffer.from('2}\n'))).toEqual(['{"b":2}']);
    expect(decoder.pendingBytes).toBe(0);
  });

  it('returns several frames from one chunk in order', () => {
    const decoder = new FrameDecoder();
    expect(decoder.push(Buffer.from('1\n2\n3\n'))).toEqual(['1', '2', '3']);
  });

  it('reassembles a frame split inside a multi-byte character', () => {
    const bytes = Buffer.from('{"m":"čau"}\n', 'utf8');
    const cut = bytes.indexOf(0xc4) + 1; // between the two bytes of "č"
    const decoder = new FrameDecoder();
    const frames = [...decoder.push(bytes.subarray(0, cut)), ...decoder.push(bytes.subarray(cut))];
    expect(frames).toEqual(['{"m":"čau"}']);
  });

  it('skips empty and whitespace-only lines and leaves a trailing carriage return in place', () => {
    const decoder = new FrameDecoder();
    const frames = decoder.push(Buffer.from('\n  \n{"a":1}\r\n'));
    expect(frames).toEqual(['{"a":1}\r']);
    expect(JSON.parse(frames[0] ?? '') as unknown).toEqual({ a: 1 });
  });

  it('throws FrameTooLongError when the unfinished tail exceeds the limit and resets', () => {
    const decoder = new FrameDecoder(8);
    expect(() => decoder.push(Buffer.from('123456789'))).toThrow(FrameTooLongError);
    expect(decoder.pendingBytes).toBe(0);
    expect(decoder.push(Buffer.from('{"a":1}\n'))).toEqual(['{"a":1}']);
  });

  it('throws FrameTooLongError with the sizes when a completed line exceeds the limit', () => {
    const decoder = new FrameDecoder(8);
    let caught: unknown;
    try {
      decoder.push(Buffer.from('123456789\n'));
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(FrameTooLongError);
    expect(caught).toMatchObject({ bytes: 9, limit: 8 });
  });

  it('carries frames decoded before the oversized one on the error', () => {
    const decoder = new FrameDecoder(8);
    let caught: unknown;
    try {
      decoder.push(Buffer.from('ok\nXXXXXXXXXXXXX'));
    } catch (error) {
      caught = error;
    }
    // The valid frame was already decoded and is no longer in the decoder; losing it would
    // silently drop telemetry from a caller that keeps the connection open.
    expect(caught).toBeInstanceOf(FrameTooLongError);
    expect((caught as FrameTooLongError).frames).toEqual(['ok']);
    expect(decoder.pendingBytes).toBe(0);
  });

  it('accepts a line and a tail of exactly the limit', () => {
    const decoder = new FrameDecoder(8);
    expect(decoder.push(Buffer.from('12345678\n'))).toEqual(['12345678']);
    expect(() => decoder.push(Buffer.from('abcdefgh'))).not.toThrow();
    expect(decoder.pendingBytes).toBe(8);
  });

  it('stays usable after a completed line exceeded the limit', () => {
    const decoder = new FrameDecoder(8);
    expect(() => decoder.push(Buffer.from('123456789\n'))).toThrow(FrameTooLongError);
    expect(decoder.pendingBytes).toBe(0);
    expect(decoder.push(Buffer.from('{"a":1}\n'))).toEqual(['{"a":1}']);
  });

  it('clears a non-empty buffered tail when the limit is exceeded', () => {
    const decoder = new FrameDecoder(8);
    decoder.push(Buffer.from('ab'));
    expect(decoder.pendingBytes).toBe(2);
    // Without the reset the tail would stay at 2, so the 0 below can only come from the reset.
    expect(() => decoder.push(Buffer.from('cdefghij\n'))).toThrow(FrameTooLongError);
    expect(decoder.pendingBytes).toBe(0);
  });

  it("does not let the pending tail alias the caller's chunk buffer", () => {
    const decoder = new FrameDecoder();
    const chunk = Buffer.from('{"a":1}\n{"b":');
    expect(decoder.push(chunk)).toEqual(['{"a":1}']);
    chunk.fill(0); // a real socket reuses its read buffer
    expect(decoder.push(Buffer.from('2}\n'))).toEqual(['{"b":2}']);
  });

  it('keeps each decoder independent, so one connection cannot corrupt another', () => {
    const a = new FrameDecoder(8);
    const b = new FrameDecoder(8);
    a.push(Buffer.from('ab'));
    expect(() => a.push(Buffer.from('cdefghij'))).toThrow(FrameTooLongError);
    expect(b.push(Buffer.from('ok\n'))).toEqual(['ok']);
    expect(b.pendingBytes).toBe(0);
  });

  it('reassembles a frame split across three chunks', () => {
    const decoder = new FrameDecoder();
    const frames = [
      ...decoder.push(Buffer.from('{"a"')),
      ...decoder.push(Buffer.from(':123')),
      ...decoder.push(Buffer.from('}\n')),
    ];
    expect(frames).toEqual(['{"a":123}']);
  });

  it('wires the default limit to MAX_FRAME_BYTES', () => {
    const decoder = new FrameDecoder();
    expect(() => decoder.push(Buffer.from('x'.repeat(MAX_FRAME_BYTES + 1)))).toThrow(
      FrameTooLongError,
    );
  });

  it('uses a 64 KiB default limit', () => {
    expect(MAX_FRAME_BYTES).toBe(65_536);
  });

  it('round-trips every example message', () => {
    const decoder = new FrameDecoder();
    const chunk = Buffer.concat(Object.values(exampleMessages).map(encodeFrame));
    const decoded = decoder.push(chunk).map((line) => JSON.parse(line) as unknown);
    expect(decoded).toEqual(Object.values(exampleMessages));
  });
});
