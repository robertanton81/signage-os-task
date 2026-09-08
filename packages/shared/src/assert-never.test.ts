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
});
