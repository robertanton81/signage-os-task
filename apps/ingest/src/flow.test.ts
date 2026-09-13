import { describe, expect, it } from 'vitest';

import { Window, shouldRead } from './flow.js';

/** Calls `step` `times` times and returns the 1-based call number and result of every real change. */
function changes<R extends string>(times: number, step: () => R): [call: number, result: R][] {
  const seen: [number, R][] = [];
  for (let call = 1; call <= times; call += 1) {
    const result = step();
    if (result !== 'unchanged') seen.push([call, result]);
  }
  return seen;
}

describe('Window', () => {
  it('closes at a cap of 1 and reopens when it is empty again', () => {
    const window = new Window(1);

    expect(window.add()).toBe('closed');
    expect(window.isOpen).toBe(false);
    expect(window.remove()).toBe('reopened');
    expect(window.isOpen).toBe(true);
    expect(window.size).toBe(0);
  });

  it('closes at a cap of 2 and reopens at 1', () => {
    const window = new Window(2);

    expect(window.add()).toBe('unchanged');
    expect(window.add()).toBe('closed');
    expect(window.remove()).toBe('reopened');
    expect(window.size).toBe(1);
  });

  it('reopens an odd cap at half the cap rounded down', () => {
    // A cap of 3 reopens at 1. Rounding up or to nearest would reopen at 2; the even caps above and
    // below cannot tell the two apart.
    const window = new Window(3);

    expect(changes(3, () => window.add())).toEqual([[3, 'closed']]);
    expect(window.remove()).toBe('unchanged');
    expect(window.isOpen).toBe(false);
    expect(window.remove()).toBe('reopened');
    expect(window.size).toBe(1);
  });

  it('changes state at exactly the 256th add and at the remove that reaches 128, and nowhere else', () => {
    const window = new Window(256);

    // One add past the cap: a read chunk is processed to its end, so the cap is soft (decision 3).
    expect(changes(257, () => window.add())).toEqual([[256, 'closed']]);
    expect(window.size).toBe(257);
    // From 257, the 129th remove brings the size to 128.
    expect(changes(257, () => window.remove())).toEqual([[129, 'reopened']]);
    expect(window.size).toBe(0);
    expect(window.isOpen).toBe(true);
  });

  it('reopens at half the cap, not at half of an overshoot', () => {
    const window = new Window(4);

    expect(changes(6, () => window.add())).toEqual([[4, 'closed']]);
    // Sizes 5, 4 and 3 stay closed; 2 is half the cap and reopens.
    expect(changes(4, () => window.remove())).toEqual([[4, 'reopened']]);
  });

  it('reports no change for removes from a window that never closed', () => {
    const window = new Window(10);

    expect(changes(5, () => window.add())).toEqual([]);
    expect(changes(5, () => window.remove())).toEqual([]);
    expect(window.isOpen).toBe(true);
  });

  it('throws on a remove from an empty window and leaves the window unchanged', () => {
    const window = new Window(3);

    expect(() => window.remove()).toThrow('window underflow');
    // A guard placed after the decrement would throw the same error but leave the size at -1.
    expect(window.size).toBe(0);
    expect(window.isOpen).toBe(true);
  });
});

describe('shouldRead', () => {
  it.each([
    { publisherReady: true, connectionWindowOpen: true, instanceWindowOpen: true, expected: true },
    {
      publisherReady: true,
      connectionWindowOpen: true,
      instanceWindowOpen: false,
      expected: false,
    },
    {
      publisherReady: true,
      connectionWindowOpen: false,
      instanceWindowOpen: true,
      expected: false,
    },
    {
      publisherReady: true,
      connectionWindowOpen: false,
      instanceWindowOpen: false,
      expected: false,
    },
    {
      publisherReady: false,
      connectionWindowOpen: true,
      instanceWindowOpen: true,
      expected: false,
    },
    {
      publisherReady: false,
      connectionWindowOpen: true,
      instanceWindowOpen: false,
      expected: false,
    },
    {
      publisherReady: false,
      connectionWindowOpen: false,
      instanceWindowOpen: true,
      expected: false,
    },
    {
      publisherReady: false,
      connectionWindowOpen: false,
      instanceWindowOpen: false,
      expected: false,
    },
  ])(
    'is $expected for publisher $publisherReady, connection window $connectionWindowOpen, instance window $instanceWindowOpen',
    ({ expected, ...input }) => {
      expect(shouldRead(input)).toBe(expected);
    },
  );
});
