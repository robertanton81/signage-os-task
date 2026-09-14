import { describe, expect, it } from 'vitest';

import {
  RETRYABLE_WRITE_LABEL,
  StoreError,
  TRANSIENT_SERVER_CODES,
  classifyFailure,
  type StoreFailure,
} from './failure.js';

function server(fields: Partial<Extract<StoreFailure, { kind: 'server' }>>): StoreFailure {
  return {
    kind: 'server',
    code: undefined,
    codeName: undefined,
    labels: [],
    message: 'server failure',
    ...fields,
  };
}

describe('classifyFailure', () => {
  it.each<StoreFailure>([
    { kind: 'network', message: 'connection reset' },
    { kind: 'server_selection', message: 'no server available' },
  ])('classifies a $kind failure as transient', (failure) => {
    expect(classifyFailure(failure)).toBe('transient');
  });

  it.each([
    { label: 'the label alone', code: undefined, labels: [RETRYABLE_WRITE_LABEL] },
    {
      label: 'the label next to another one and an unlisted code',
      code: 999,
      labels: ['Other', RETRYABLE_WRITE_LABEL],
    },
  ])(
    'classifies a server failure with the retryable-write label as transient: $label',
    ({ code, labels }) => {
      expect(classifyFailure(server({ code, labels }))).toBe('transient');
    },
  );

  it.each([24, 50, 64, 91, 262, 10107, 11600])(
    'classifies server code %i as transient (consistency spec, decision 26)',
    (code) => {
      expect(classifyFailure(server({ code }))).toBe('transient');
    },
  );

  it('lists exactly the seven transient codes', () => {
    expect([...TRANSIENT_SERVER_CODES].sort((a, b) => a - b)).toEqual([
      24, 50, 64, 91, 262, 10107, 11600,
    ]);
  });

  it.each([
    { label: 'a schema validation refusal (121)', code: 121, labels: [] },
    { label: 'an authentication failure (18)', code: 18, labels: [] },
    {
      label: 'a duplicate key (11000), which the store turns into a result before it gets here',
      code: 11000,
      labels: [],
    },
    { label: 'no code at all', code: undefined, labels: [] },
    {
      label: 'a label that is not the retryable-write one',
      code: undefined,
      labels: ['TransientTransactionError'],
    },
  ])('classifies a server failure with $label as permanent', ({ code, labels }) => {
    expect(classifyFailure(server({ code, labels }))).toBe('permanent');
  });

  it('classifies a closed client as closed', () => {
    expect(classifyFailure({ kind: 'closed', message: 'client was closed' })).toBe('closed');
  });

  it('classifies any other error as permanent', () => {
    expect(classifyFailure({ kind: 'other', name: 'TypeError', message: 'x' })).toBe('permanent');
  });
});

describe('StoreError', () => {
  it('is an Error named StoreError that carries the failure view and its message', () => {
    const failure: StoreFailure = { kind: 'network', message: 'socket timed out' };

    const error = new StoreError(failure);

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('StoreError');
    expect(error.message).toBe('socket timed out');
    expect(error.failure).toBe(failure);
  });
});
