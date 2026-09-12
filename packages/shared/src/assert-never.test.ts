import { describe, expect, it } from 'vitest';

import { assertNever } from './assert-never.js';

describe('assertNever', () => {
  it('throws with the serialised value so the unhandled variant is visible in the error', () => {
    expect(() => assertNever({ type: 'unknown' } as never, 'unhandled event')).toThrow(
      'unhandled event: {"type":"unknown"}',
    );
  });

  it('falls back to a generic prefix when no context is given', () => {
    expect(() => assertNever('x' as never)).toThrow('unhandled variant: "x"');
  });

  // JSON.stringify returns undefined, not a string, for these, so without the fallback the
  // message would read "unhandled variant: undefined" and name nothing at all.
  // Each value is built by a thunk: a bare function in the table would be destructured out of it,
  // which `@typescript-eslint/unbound-method` rejects.
  it.each([
    {
      name: 'a function',
      make: () => function handler() {},
      context: 'callback',
      expected: /^callback: function handler/,
    },
    {
      name: 'a symbol',
      make: () => Symbol('metrics'),
      context: 'symbol',
      expected: /^symbol: Symbol\(metrics\)$/,
    },
    {
      name: 'undefined',
      make: () => undefined,
      context: 'absent',
      expected: /^absent: undefined$/,
    },
  ])(
    'names $name, which JSON.stringify renders as nothing',
    ({ make, context, expected }: { make: () => unknown; context: string; expected: RegExp }) => {
      expect(() => assertNever(make() as never, context)).toThrow(expected);
    },
  );

  it('still names the variant when the value cannot be serialised as JSON', () => {
    // JSON.stringify throws on both; the guard's own error must win, not a TypeError.
    const circular: Record<string, unknown> = {};
    circular['self'] = circular;
    expect(() => assertNever(circular as never, 'circular')).toThrow(
      /^circular: \[object Object\]$/,
    );
    expect(() => assertNever(10n as never, 'bigint')).toThrow(/^bigint: 10$/);
  });

  // A value that defeats BOTH steps: JSON.stringify throws on the cycle, and String throws
  // because there is no prototype to convert through, or its toString throws.
  it('still names the variant when the value cannot be converted at all', () => {
    const noPrototype: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    noPrototype['self'] = noPrototype;
    expect(() => assertNever(noPrototype as never, 'no prototype')).toThrow(
      /^no prototype: \[object Object\]$/,
    );

    const throwing: Record<string, unknown> = {
      toString() {
        throw new Error('toString is hostile');
      },
    };
    throwing['self'] = throwing;
    expect(() => assertNever(throwing as never, 'hostile')).toThrow(/^hostile: \[object Object\]$/);
  });
});
