import { describe, expect, it } from 'vitest';

import { makeStatusMessage } from './fixtures.js';
import { extractRawIdentity, isNewer, messageIdentity, orderKey } from './identity.js';
import { DEVICE_ID_MAX_LENGTH } from './message.js';

describe('messageIdentity', () => {
  it('joins device, session and sequence with colons', () => {
    const message = makeStatusMessage({
      deviceId: 'dev-0042',
      sessionId: 1_700_000_000_000,
      seq: 7,
    });
    expect(messageIdentity(message)).toBe('dev-0042:1700000000000:7');
  });
});

describe('orderKey', () => {
  it('is the session and sequence pair', () => {
    expect(orderKey({ sessionId: 5, seq: 3 })).toEqual([5, 3]);
  });
});

describe('isNewer', () => {
  it.each([
    {
      name: 'a newer session',
      candidate: { sessionId: 2, seq: 1 },
      stored: { sessionId: 1, seq: 9 },
      expected: true,
    },
    {
      name: 'the same session and a higher seq',
      candidate: { sessionId: 1, seq: 10 },
      stored: { sessionId: 1, seq: 9 },
      expected: true,
    },
    {
      name: 'the same key (a duplicate)',
      candidate: { sessionId: 1, seq: 9 },
      stored: { sessionId: 1, seq: 9 },
      expected: false,
    },
    {
      name: 'the same session and a lower seq',
      candidate: { sessionId: 1, seq: 8 },
      stored: { sessionId: 1, seq: 9 },
      expected: false,
    },
    {
      name: 'an older session with a higher seq',
      candidate: { sessionId: 1, seq: 99 },
      stored: { sessionId: 2, seq: 1 },
      expected: false,
    },
    {
      name: 'a numerically larger session whose digit string is shorter',
      candidate: { sessionId: 10, seq: 1 },
      stored: { sessionId: 9, seq: 5 },
      expected: true,
    },
    {
      name: 'an older session with an equal seq',
      candidate: { sessionId: 1, seq: 9 },
      stored: { sessionId: 2, seq: 9 },
      expected: false,
    },
  ])('$name → $expected', ({ candidate, stored, expected }) => {
    expect(isNewer(candidate, stored)).toBe(expected);
  });
});

describe('extractRawIdentity', () => {
  it('returns the three identity fields when they have the right types', () => {
    expect(extractRawIdentity({ deviceId: 'dev-1', sessionId: 2, seq: 3, type: 'x' })).toEqual({
      deviceId: 'dev-1',
      sessionId: 2,
      seq: 3,
    });
  });

  it('drops deviceId when it has the wrong type and keeps the others', () => {
    expect(extractRawIdentity({ deviceId: 42, sessionId: 2, seq: 3 })).toEqual({
      sessionId: 2,
      seq: 3,
    });
  });

  it('drops seq when it has the wrong type and keeps the others', () => {
    expect(extractRawIdentity({ deviceId: 'dev-1', sessionId: 2, seq: '3' })).toEqual({
      deviceId: 'dev-1',
      sessionId: 2,
    });
  });

  it('returns an empty object when no identity field is present', () => {
    expect(extractRawIdentity({})).toEqual({});
  });

  it('drops sessionId when it has the wrong type and keeps the others', () => {
    expect(extractRawIdentity({ deviceId: 'dev-1', sessionId: '2', seq: 3 })).toEqual({
      deviceId: 'dev-1',
      seq: 3,
    });
  });

  it('keeps a present field when the others are absent', () => {
    expect(extractRawIdentity({ deviceId: 'dev-1' })).toEqual({ deviceId: 'dev-1' });
  });

  it('returns an empty object for null', () => {
    // typeof null === 'object', so null is the only input that needs the explicit null check.
    expect(extractRawIdentity(null)).toEqual({});
  });

  it('returns an empty object for a non-object primitive', () => {
    expect(extractRawIdentity('text')).toEqual({});
    expect(extractRawIdentity(undefined)).toEqual({});
  });

  it('returns an empty object for an array', () => {
    expect(extractRawIdentity(['dev-1', 2, 3])).toEqual({});
  });

  it('keeps a deviceId of exactly the contract maximum', () => {
    const longest = 'd'.repeat(DEVICE_ID_MAX_LENGTH);
    expect(extractRawIdentity({ deviceId: longest })).toEqual({ deviceId: longest });
  });

  // Truncating would have put these first 64 characters on the line, which are a real device's
  // id: the sender could make its own rejected frames look like that device's.
  it('drops an oversized deviceId rather than logging its first characters', () => {
    const victim = 'dev-0042'.padEnd(DEVICE_ID_MAX_LENGTH, 'x');
    expect(extractRawIdentity({ deviceId: `${victim}${'y'.repeat(100_000)}` })).toEqual({});
  });

  it.each([
    { name: 'a newline', deviceId: 'dev-1\nlevel=fatal msg=fake' },
    { name: 'an ANSI escape', deviceId: 'dev-1\u001b[2J' },
    { name: 'a colon, which messageIdentity uses as its separator', deviceId: 'dev:1' },
    { name: 'half of a surrogate pair', deviceId: 'dev-\ud83d' },
  ])('drops a deviceId containing $name', ({ deviceId }) => {
    expect(extractRawIdentity({ deviceId })).toEqual({});
  });

  it.each([
    {
      name: 'a non-finite sessionId and seq',
      input: { sessionId: Number.POSITIVE_INFINITY, seq: Number.NaN },
    },
    {
      name: 'a sessionId one past MAX_SAFE_INTEGER and a non-integer seq',
      input: { sessionId: 2 ** 53, seq: 1.5 },
    },
  ])('drops $name, which pino would print as null', ({ input }) => {
    expect(extractRawIdentity(input)).toEqual({});
  });
});
