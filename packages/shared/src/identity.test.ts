import { describe, expect, it } from 'vitest';

import { makeStatusMessage } from './fixtures.js';
import { extractRawIdentity, isNewer, messageIdentity, orderKey } from './identity.js';

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
      name: 'a newer session with a lower seq',
      candidate: { sessionId: 3, seq: 1 },
      stored: { sessionId: 2, seq: 50 },
      expected: true,
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

  it('drops deviceId and seq when they have the wrong type', () => {
    expect(extractRawIdentity({ deviceId: 42, seq: '3' })).toEqual({});
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
});
