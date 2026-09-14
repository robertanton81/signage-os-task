import { isNewer, type DeviceStateDocument, type OrderKey } from '@telemetry/shared';
import { describe, expect, it } from 'vitest';

import { EXAMPLE_RECEIVED_AT, exampleMessages, exampleState } from './fixtures.js';
import {
  buildStateUpdate,
  classifyOutcome,
  detectGap,
  newerThanStoredExpr,
} from './state-update.js';

type Doc = Record<string, unknown>;

/** `a.b.c` on a plain document; `undefined` when any step is missing. */
function resolve(doc: Doc, path: string): unknown {
  let current: unknown = doc;
  for (const step of path.split('.')) {
    if (typeof current !== 'object' || current === null) {
      return undefined;
    }
    current = (current as Doc)[step];
  }
  return current;
}

/**
 * The smallest evaluator that runs the guard the way the server does for the values it sees: a
 * `$`-prefixed string is a field path, an array is evaluated element-wise, `$type` of a missing
 * path is `'missing'`, `$or`/`$and`/`$eq` are the boolean operators, and `$lt` follows the BSON
 * comparison order for the two cases that occur here — two numbers, or a missing value against a
 * number (missing sorts first, so it is "less"). Anything else is a literal.
 */
function evaluate(expr: unknown, doc: Doc): unknown {
  if (typeof expr === 'string' && expr.startsWith('$')) {
    return resolve(doc, expr.slice(1));
  }
  if (Array.isArray(expr)) {
    return expr.map((item: unknown) => evaluate(item, doc));
  }
  if (typeof expr !== 'object' || expr === null) {
    return expr;
  }
  const entries = Object.entries(expr as Record<string, unknown>);
  const entry = entries.length === 1 ? entries[0] : undefined;
  if (entry === undefined) {
    return expr;
  }
  const [operator, argument] = entry;
  const operands = Array.isArray(argument)
    ? argument.map((item: unknown) => evaluate(item, doc))
    : [];
  switch (operator) {
    case '$or':
      return operands.some((value) => value === true);
    case '$and':
      return operands.every((value) => value === true);
    case '$eq':
      return operands[0] === operands[1];
    case '$lt': {
      const [left, right] = operands;
      if (typeof left === 'number' && typeof right === 'number') {
        return left < right;
      }
      return left === undefined && typeof right === 'number';
    }
    case '$type':
      return evaluate(argument, doc) === undefined ? 'missing' : 'present';
    default:
      return expr;
  }
}

const SESSION = exampleMessages.status.sessionId;
const KEY: OrderKey = { sessionId: SESSION, seq: 5 };

/** The consistency spec's five cases; `stored` is undefined when the section is absent. */
const STORED_CASES: { label: string; stored: OrderKey | undefined; expected: boolean }[] = [
  { label: 'the section is absent', stored: undefined, expected: true },
  {
    label: 'the stored session is older',
    stored: { sessionId: SESSION - 1000, seq: 9 },
    expected: true,
  },
  {
    label: 'the same session with a lower seq',
    stored: { sessionId: SESSION, seq: 4 },
    expected: true,
  },
  { label: 'the same key', stored: { sessionId: SESSION, seq: 5 }, expected: false },
  {
    label: 'a newer session with a lower seq',
    stored: { sessionId: SESSION + 1, seq: 1 },
    expected: false,
  },
];

describe('newerThanStoredExpr', () => {
  it.each(STORED_CASES)('agrees with isNewer for a section when $label', ({ stored, expected }) => {
    const doc: Doc = stored === undefined ? {} : { metrics: { ...stored, temperatureC: 1 } };

    const answer = evaluate(newerThanStoredExpr('metrics', KEY), doc);

    expect(answer).toBe(expected);
    if (stored !== undefined) {
      expect(answer).toBe(isNewer(KEY, stored));
    }
  });

  it.each(STORED_CASES)('agrees with isNewer for lastEvent when $label', ({ stored, expected }) => {
    const doc: Doc = stored === undefined ? {} : { lastEvent: { ...stored, type: 'status' } };

    const answer = evaluate(newerThanStoredExpr('lastEvent', KEY), doc);

    expect(answer).toBe(expected);
    if (stored !== undefined) {
      expect(answer).toBe(isNewer(KEY, stored));
    }
  });
});

describe('buildStateUpdate', () => {
  const message = {
    ...exampleMessages.diagnostic,
    payload: { ...exampleMessages.diagnostic.payload, message: '$set me' },
  };
  const key: OrderKey = { sessionId: message.sessionId, seq: message.seq };

  it('filters on the device id and sets the section and lastEvent under the guard in one stage', () => {
    const update = buildStateUpdate(message, EXAMPLE_RECEIVED_AT);

    expect(update.filter).toEqual({ _id: 'dev-0001' });
    expect(update.pipeline).toEqual([
      {
        $set: {
          diagnostic: {
            $cond: {
              if: newerThanStoredExpr('diagnostic', key),
              then: {
                $literal: {
                  sessionId: message.sessionId,
                  seq: message.seq,
                  occurredAt: message.occurredAt,
                  receivedAt: EXAMPLE_RECEIVED_AT,
                  severity: 'error',
                  code: 'E_OVERHEAT',
                  message: '$set me',
                },
              },
              else: '$diagnostic',
            },
          },
          lastEvent: {
            $cond: {
              if: newerThanStoredExpr('lastEvent', key),
              then: {
                $literal: {
                  sessionId: message.sessionId,
                  seq: message.seq,
                  type: 'diagnostic',
                  receivedAt: EXAMPLE_RECEIVED_AT,
                },
              },
              else: '$lastEvent',
            },
          },
        },
      },
    ]);
  });

  it('builds a guard that replaces an older stored section and keeps a newer one', () => {
    const { pipeline } = buildStateUpdate(message, EXAMPLE_RECEIVED_AT);
    const stage = pipeline[0] as { $set: { diagnostic: { $cond: { if: unknown } } } };
    const guard = stage.$set.diagnostic.$cond.if;

    expect(evaluate(guard, { diagnostic: { sessionId: message.sessionId, seq: 1 } })).toBe(true);
    expect(evaluate(guard, { diagnostic: { sessionId: message.sessionId, seq: 9 } })).toBe(false);
  });
});

describe('classifyOutcome', () => {
  const stored = exampleState.metrics;
  if (stored === undefined) throw new Error('the fixture has a metrics section');

  it.each([
    { label: 'no document', before: null, seq: 3, expected: 'created' },
    {
      label: 'a document without the section',
      before: { _id: 'dev-0001' },
      seq: 3,
      expected: 'applied',
    },
    {
      label: 'an older stored key',
      before: exampleState,
      seq: stored.seq + 1,
      expected: 'applied',
    },
    { label: 'the same key', before: exampleState, seq: stored.seq, expected: 'stale' },
    { label: 'a newer stored key', before: exampleState, seq: stored.seq - 1, expected: 'stale' },
  ])('answers $expected for $label', ({ before, seq, expected }) => {
    const message = { ...exampleMessages.metrics, seq };

    expect(classifyOutcome(before, message)).toBe(expected);
  });
});

describe('detectGap', () => {
  const lastEvent = exampleState.lastEvent;
  if (lastEvent === undefined) throw new Error('the fixture has a lastEvent');
  const at = (seq: number, sessionId = SESSION) => ({ ...exampleMessages.status, sessionId, seq });

  it.each<{ label: string; before: DeviceStateDocument | null; seq: number; sessionId?: number }>([
    { label: 'no document', before: null, seq: 9 },
    { label: 'no lastEvent', before: { _id: 'dev-0001' }, seq: 9 },
    { label: 'another session', before: exampleState, seq: 9, sessionId: SESSION + 1 },
    { label: 'the next seq', before: exampleState, seq: lastEvent.seq + 1 },
    { label: 'a stale seq', before: exampleState, seq: lastEvent.seq - 1 },
    { label: 'the same seq', before: exampleState, seq: lastEvent.seq },
  ])('reports nothing for $label', ({ before, seq, sessionId }) => {
    expect(detectGap(before, at(seq, sessionId))).toBeUndefined();
  });

  it.each([
    { label: 'the smallest gap, one skipped value', seq: lastEvent.seq + 2 },
    { label: 'a wider gap', seq: lastEvent.seq + 3 },
  ])('reports the previous and the received seq for $label', ({ seq }) => {
    expect(detectGap(exampleState, at(seq))).toEqual({ previousSeq: lastEvent.seq, seq });
  });
});
