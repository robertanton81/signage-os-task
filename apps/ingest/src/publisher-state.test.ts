import { describe, expect, it } from 'vitest';

import {
  BACKOFF_RESET_AFTER_MS,
  INITIAL_STATE,
  isConfirmStall,
  isReady,
  transition,
  type Effect,
  type LogEffectLevel,
  type PublisherEvent,
  type PublisherState,
  type Transition,
} from './publisher-state.js';

/** The current generation of every state below. */
const G = 5;

const backoff: PublisherState = {
  name: 'backoff',
  generation: G,
  attempt: 2,
  reason: 'connection_closed',
};
const connecting: PublisherState = {
  name: 'connecting',
  generation: G,
  attempt: 2,
  blocked: false,
  failed: false,
};
const blockedConnecting: PublisherState = { ...connecting, blocked: true };
const failedConnecting: PublisherState = {
  name: 'connecting',
  generation: G,
  attempt: 2,
  blocked: false,
  failed: true,
  reason: 'channel_closed',
};
// Reachable: a trigger on a blocked attempt, or a block on a failed one.
const blockedFailedConnecting: PublisherState = { ...failedConnecting, blocked: true };
const ready: PublisherState = {
  name: 'ready',
  generation: G,
  attempt: 2,
  blocked: false,
  readySince: 1_000,
};
const blockedReady: PublisherState = { ...ready, blocked: true };
const recycling: PublisherState = {
  name: 'recycling',
  generation: G,
  attempt: 3,
  reason: 'nacked',
};
const stopped: PublisherState = { name: 'stopped', generation: G };
const toStopped: PublisherState = { name: 'stopped', generation: G + 1 };

/** Event builders take every value explicitly, so no default can decide which branch a test hits. */
const ev = {
  backoffElapsed: (generation = G): PublisherEvent => ({ type: 'backoff_elapsed', generation }),
  attemptSucceeded: ({
    now,
    generation = G,
  }: {
    now: number;
    generation?: number;
  }): PublisherEvent => ({
    type: 'attempt_succeeded',
    generation,
    now,
  }),
  attemptFailed: ({
    reason,
    generation = G,
  }: {
    reason: string;
    generation?: number;
  }): PublisherEvent => ({
    type: 'attempt_failed',
    generation,
    reason,
  }),
  trigger: ({
    reason,
    now,
    generation = G,
  }: {
    reason: string;
    now: number;
    generation?: number;
  }): PublisherEvent => ({ type: 'trigger', generation, reason, now }),
  closeFinished: (generation = G): PublisherEvent => ({ type: 'close_finished', generation }),
  blocked: ({
    reason,
    generation = G,
  }: {
    reason: string;
    generation?: number;
  }): PublisherEvent => ({
    type: 'blocked',
    generation,
    reason,
  }),
  unblocked: (generation = G): PublisherEvent => ({ type: 'unblocked', generation }),
  stop: (): PublisherEvent => ({ type: 'stop' }),
};

/** Every event type that carries a generation, all on `generation`. */
function eventsAt(generation: number): PublisherEvent[] {
  return [
    ev.backoffElapsed(generation),
    ev.attemptSucceeded({ now: 0, generation }),
    ev.attemptFailed({ reason: 'any', generation }),
    ev.trigger({ reason: 'any', now: 0, generation }),
    ev.closeFinished(generation),
    ev.blocked({ reason: 'any', generation }),
    ev.unblocked(generation),
  ];
}

function log(entry: {
  level: LogEffectLevel;
  message: string;
  fields: Record<string, unknown>;
}): Effect {
  return { type: 'log', ...entry };
}
const connected = (fields: { generation: number; attempt: number }): Effect =>
  log({ level: 'info', message: 'publisher connected', fields });
const triggerDuringAttempt = (reason: string): Effect =>
  log({ level: 'debug', message: 'recycle trigger during a connect attempt', fields: { reason } });
const blockedLine = (reason: string): Effect =>
  log({ level: 'warn', message: 'connection blocked', fields: { reason } });
const unblockedLine: Effect = log({ level: 'info', message: 'connection unblocked', fields: {} });
const ignoredTrigger = (fields: { reason: string; state: string }): Effect =>
  log({ level: 'debug', message: 'ignored a recycle trigger while not ready', fields });
const stopping = (from: string): Effect =>
  log({ level: 'info', message: 'publisher stopping', fields: { from } });
const CLOSE_MODEL: Effect = { type: 'close_model' };
const startBackoff = (entry: { attempt: number; reason: string }): Effect => ({
  type: 'start_backoff',
  ...entry,
});

const VARIANTS: { key: string; state: PublisherState }[] = [
  { key: 'backoff', state: backoff },
  { key: 'connecting', state: connecting },
  { key: 'connecting-blocked', state: blockedConnecting },
  { key: 'connecting-failed', state: failedConnecting },
  { key: 'connecting-blocked-failed', state: blockedFailedConnecting },
  { key: 'ready', state: ready },
  { key: 'ready-blocked', state: blockedReady },
  { key: 'recycling', state: recycling },
  { key: 'stopped', state: stopped },
];

type RowCase = { key: string; state: PublisherState; event: PublisherEvent; expected: Transition };

/**
 * Every row of the spec's table, expanded to every state variant it applies to. The unlisted-pair
 * walk below skips exactly these pairs, so a pair can only be skipped when a case asserts it.
 */
const ROW_CASES: RowCase[] = [
  // backoff
  {
    key: 'backoff',
    state: backoff,
    event: ev.backoffElapsed(),
    expected: {
      state: { name: 'connecting', generation: G + 1, attempt: 2, blocked: false, failed: false },
      effects: [{ type: 'lose' }, { type: 'start_attempt' }],
    },
  },
  {
    key: 'backoff',
    state: backoff,
    event: ev.trigger({ reason: 'channel_closed', now: 9_000 }),
    expected: {
      state: backoff,
      effects: [ignoredTrigger({ reason: 'channel_closed', state: 'backoff' })],
    },
  },
  {
    key: 'backoff',
    state: backoff,
    event: ev.stop(),
    expected: { state: toStopped, effects: [stopping('backoff')] },
  },
  // connecting
  {
    key: 'connecting',
    state: connecting,
    event: ev.attemptSucceeded({ now: 7_000 }),
    expected: {
      state: { name: 'ready', generation: G, attempt: 2, blocked: false, readySince: 7_000 },
      effects: [
        { type: 'send_pending' },
        { type: 'restart_stall_clock' },
        connected({ generation: G, attempt: 2 }),
      ],
    },
  },
  {
    key: 'connecting',
    state: connecting,
    event: ev.attemptFailed({ reason: 'connect ECONNREFUSED' }),
    expected: {
      state: { name: 'backoff', generation: G, attempt: 3, reason: 'connect ECONNREFUSED' },
      effects: [startBackoff({ attempt: 3, reason: 'connect ECONNREFUSED' })],
    },
  },
  {
    key: 'connecting',
    state: connecting,
    event: ev.trigger({ reason: 'channel_closed', now: 9_000 }),
    expected: { state: failedConnecting, effects: [triggerDuringAttempt('channel_closed')] },
  },
  {
    key: 'connecting',
    state: connecting,
    event: ev.blocked({ reason: 'low on memory' }),
    expected: { state: blockedConnecting, effects: [blockedLine('low on memory')] },
  },
  {
    key: 'connecting',
    state: connecting,
    event: ev.unblocked(),
    expected: { state: connecting, effects: [unblockedLine] },
  },
  {
    key: 'connecting',
    state: connecting,
    event: ev.stop(),
    expected: { state: toStopped, effects: [CLOSE_MODEL, stopping('connecting')] },
  },
  // connecting, blocked
  {
    key: 'connecting-blocked',
    state: blockedConnecting,
    event: ev.attemptSucceeded({ now: 7_000 }),
    expected: {
      state: { name: 'ready', generation: G, attempt: 2, blocked: true, readySince: 7_000 },
      effects: [
        { type: 'send_pending' },
        { type: 'restart_stall_clock' },
        connected({ generation: G, attempt: 2 }),
      ],
    },
  },
  {
    key: 'connecting-blocked',
    state: blockedConnecting,
    event: ev.attemptFailed({ reason: 'connect ECONNREFUSED' }),
    expected: {
      state: { name: 'backoff', generation: G, attempt: 3, reason: 'connect ECONNREFUSED' },
      effects: [startBackoff({ attempt: 3, reason: 'connect ECONNREFUSED' })],
    },
  },
  {
    key: 'connecting-blocked',
    state: blockedConnecting,
    event: ev.trigger({ reason: 'channel_closed', now: 9_000 }),
    expected: { state: blockedFailedConnecting, effects: [triggerDuringAttempt('channel_closed')] },
  },
  {
    key: 'connecting-blocked',
    state: blockedConnecting,
    event: ev.blocked({ reason: 'low on disk' }),
    expected: { state: blockedConnecting, effects: [blockedLine('low on disk')] },
  },
  {
    key: 'connecting-blocked',
    state: blockedConnecting,
    event: ev.unblocked(),
    expected: { state: connecting, effects: [unblockedLine] },
  },
  {
    key: 'connecting-blocked',
    state: blockedConnecting,
    event: ev.stop(),
    expected: { state: toStopped, effects: [CLOSE_MODEL, stopping('connecting')] },
  },
  // connecting, failed with reason channel_closed
  {
    key: 'connecting-failed',
    state: failedConnecting,
    event: ev.attemptSucceeded({ now: 7_000 }),
    expected: {
      state: { name: 'backoff', generation: G, attempt: 3, reason: 'channel_closed' },
      effects: [CLOSE_MODEL, startBackoff({ attempt: 3, reason: 'channel_closed' })],
    },
  },
  {
    key: 'connecting-failed',
    state: failedConnecting,
    event: ev.attemptFailed({ reason: 'setup aborted' }),
    expected: {
      state: { name: 'backoff', generation: G, attempt: 3, reason: 'channel_closed' },
      effects: [startBackoff({ attempt: 3, reason: 'channel_closed' })],
    },
  },
  {
    key: 'connecting-failed',
    state: failedConnecting,
    event: ev.trigger({ reason: 'connection_closed', now: 9_000 }),
    expected: { state: failedConnecting, effects: [triggerDuringAttempt('connection_closed')] },
  },
  {
    key: 'connecting-failed',
    state: failedConnecting,
    event: ev.blocked({ reason: 'low on memory' }),
    expected: { state: blockedFailedConnecting, effects: [blockedLine('low on memory')] },
  },
  {
    key: 'connecting-failed',
    state: failedConnecting,
    event: ev.unblocked(),
    expected: { state: failedConnecting, effects: [unblockedLine] },
  },
  {
    key: 'connecting-failed',
    state: failedConnecting,
    event: ev.stop(),
    expected: { state: toStopped, effects: [CLOSE_MODEL, stopping('connecting')] },
  },
  // connecting, blocked and failed with reason channel_closed
  {
    key: 'connecting-blocked-failed',
    state: blockedFailedConnecting,
    event: ev.attemptSucceeded({ now: 7_000 }),
    expected: {
      state: { name: 'backoff', generation: G, attempt: 3, reason: 'channel_closed' },
      effects: [CLOSE_MODEL, startBackoff({ attempt: 3, reason: 'channel_closed' })],
    },
  },
  {
    key: 'connecting-blocked-failed',
    state: blockedFailedConnecting,
    event: ev.attemptFailed({ reason: 'setup aborted' }),
    expected: {
      state: { name: 'backoff', generation: G, attempt: 3, reason: 'channel_closed' },
      effects: [startBackoff({ attempt: 3, reason: 'channel_closed' })],
    },
  },
  {
    key: 'connecting-blocked-failed',
    state: blockedFailedConnecting,
    event: ev.trigger({ reason: 'connection_closed', now: 9_000 }),
    expected: {
      state: blockedFailedConnecting,
      effects: [triggerDuringAttempt('connection_closed')],
    },
  },
  {
    key: 'connecting-blocked-failed',
    state: blockedFailedConnecting,
    event: ev.blocked({ reason: 'low on disk' }),
    expected: { state: blockedFailedConnecting, effects: [blockedLine('low on disk')] },
  },
  {
    key: 'connecting-blocked-failed',
    state: blockedFailedConnecting,
    event: ev.unblocked(),
    expected: { state: failedConnecting, effects: [unblockedLine] },
  },
  {
    key: 'connecting-blocked-failed',
    state: blockedFailedConnecting,
    event: ev.stop(),
    expected: { state: toStopped, effects: [CLOSE_MODEL, stopping('connecting')] },
  },
  // ready
  {
    key: 'ready',
    state: ready,
    event: ev.trigger({ reason: 'nacked', now: 3_000 }),
    expected: {
      state: { name: 'recycling', generation: G + 1, attempt: 3, reason: 'nacked' },
      effects: [{ type: 'lose' }, CLOSE_MODEL],
    },
  },
  {
    key: 'ready',
    state: ready,
    event: ev.blocked({ reason: 'low on disk' }),
    expected: { state: blockedReady, effects: [blockedLine('low on disk')] },
  },
  {
    key: 'ready',
    state: ready,
    event: ev.stop(),
    expected: { state: toStopped, effects: [CLOSE_MODEL, stopping('ready')] },
  },
  // ready, blocked
  {
    key: 'ready-blocked',
    state: blockedReady,
    event: ev.trigger({ reason: 'connection_closed', now: 3_000 }),
    expected: {
      state: { name: 'recycling', generation: G + 1, attempt: 3, reason: 'connection_closed' },
      effects: [{ type: 'lose' }, CLOSE_MODEL],
    },
  },
  {
    key: 'ready-blocked',
    state: blockedReady,
    event: ev.unblocked(),
    expected: { state: ready, effects: [{ type: 'restart_stall_clock' }, unblockedLine] },
  },
  {
    key: 'ready-blocked',
    state: blockedReady,
    event: ev.stop(),
    expected: { state: toStopped, effects: [CLOSE_MODEL, stopping('ready')] },
  },
  // recycling
  {
    key: 'recycling',
    state: recycling,
    event: ev.closeFinished(),
    expected: {
      state: { name: 'backoff', generation: G, attempt: 3, reason: 'nacked' },
      effects: [startBackoff({ attempt: 3, reason: 'nacked' })],
    },
  },
  {
    key: 'recycling',
    state: recycling,
    event: ev.trigger({ reason: 'channel_closed', now: 9_000 }),
    expected: {
      state: recycling,
      effects: [ignoredTrigger({ reason: 'channel_closed', state: 'recycling' })],
    },
  },
  {
    key: 'recycling',
    state: recycling,
    event: ev.stop(),
    expected: { state: toStopped, effects: [CLOSE_MODEL, stopping('recycling')] },
  },
];

const ROWS = new Set(ROW_CASES.map(({ key, event }) => `${key}:${event.type}`));

describe('transition — every row of the table, for every state variant it applies to', () => {
  it.each(ROW_CASES)('$key + $event.type', ({ state, event, expected }) => {
    const before = structuredClone(state);

    expect(transition(state, event)).toEqual(expected);
    // Pure: the input state is never changed in place.
    expect(state).toEqual(before);
  });

  it('lists each pair once, with the same states the walks below use', () => {
    expect(ROWS.size).toBe(ROW_CASES.length);
    for (const { key, state } of ROW_CASES) {
      expect(VARIANTS.find((variant) => variant.key === key)?.state, key).toBe(state);
    }
  });
});

describe('transition — start, generations and unlisted pairs', () => {
  it('starts in backoff on generation 0 with no attempt made', () => {
    expect(INITIAL_STATE).toEqual({ name: 'backoff', generation: 0, attempt: 0, reason: 'start' });
  });

  it('opens generation 1 on the first backoff_elapsed', () => {
    expect(transition(INITIAL_STATE, ev.backoffElapsed(0))).toEqual({
      state: { name: 'connecting', generation: 1, attempt: 0, blocked: false, failed: false },
      effects: [{ type: 'lose' }, { type: 'start_attempt' }],
    });
  });

  it.each(VARIANTS)('$key ignores every event of an older or a newer generation', ({ state }) => {
    for (const generation of [G - 1, G + 1]) {
      for (const event of eventsAt(generation)) {
        const result = transition(state, event);
        expect(result.state, `${event.type}@${generation}`).toBe(state);
        expect(result.effects, `${event.type}@${generation}`).toEqual([]);
      }
    }
  });

  it('changes nothing for every current-generation pair that has no row', () => {
    for (const { key, state } of VARIANTS) {
      for (const event of [...eventsAt(G), ev.stop()]) {
        const pair = `${key}:${event.type}`;
        if (ROWS.has(pair)) continue;
        const result = transition(state, event);
        expect(result.state, pair).toBe(state);
        expect(result.effects, pair).toEqual([]);
      }
    }
  });

  it('emits lose on every generation increase except stop, and on no other transition', () => {
    const withLose: string[] = [];
    for (const { key, state } of VARIANTS) {
      for (const event of [...eventsAt(G), ev.stop()]) {
        const { state: next, effects } = transition(state, event);
        const loses = effects.some((effect) => effect.type === 'lose');
        if (loses) withLose.push(`${key}:${event.type}`);
        if (next.generation > state.generation && event.type !== 'stop') {
          expect(loses, `${key}:${event.type}`).toBe(true);
        }
      }
    }
    expect(withLose.sort()).toEqual([
      'backoff:backoff_elapsed',
      'ready-blocked:trigger',
      'ready:trigger',
    ]);
  });

  it.each(VARIANTS)(
    '$key + stop ends in stopped, and nothing changes stopped afterwards',
    ({ state }) => {
      const after = transition(state, ev.stop()).state;
      expect(after.name).toBe('stopped');

      for (const generation of [after.generation, after.generation - 1]) {
        for (const event of [...eventsAt(generation), ev.stop()]) {
          const result = transition(after, event);
          expect(result.state, `${event.type}@${generation}`).toBe(after);
          expect(result.effects, `${event.type}@${generation}`).toEqual([]);
        }
      }
    },
  );
});

describe('transition — race sequences', () => {
  it('a trigger during connecting fails the attempt, so its model never serves as ready', () => {
    const failed = transition(connecting, ev.trigger({ reason: 'channel_closed', now: 9_000 }));
    const result = transition(failed.state, ev.attemptSucceeded({ now: 9_500 }));

    expect(result).toEqual({
      state: { name: 'backoff', generation: G, attempt: 3, reason: 'channel_closed' },
      effects: [CLOSE_MODEL, startBackoff({ attempt: 3, reason: 'channel_closed' })],
    });
    expect(isReady(result.state)).toBe(false);
  });

  it('a block and then a trigger during connecting still back off with the trigger reason', () => {
    const blocked = transition(connecting, ev.blocked({ reason: 'low on memory' })).state;
    const failed = transition(blocked, ev.trigger({ reason: 'channel_closed', now: 9_000 })).state;

    expect(transition(failed, ev.attemptSucceeded({ now: 9_500 }))).toEqual({
      state: { name: 'backoff', generation: G, attempt: 3, reason: 'channel_closed' },
      effects: [CLOSE_MODEL, startBackoff({ attempt: 3, reason: 'channel_closed' })],
    });
  });

  it('a block during connecting carries into ready, which is then not ready', () => {
    const blocked = transition(connecting, ev.blocked({ reason: 'low on memory' })).state;
    const result = transition(blocked, ev.attemptSucceeded({ now: 4_000 }));

    expect(result.state).toEqual({
      name: 'ready',
      generation: G,
      attempt: 2,
      blocked: true,
      readySince: 4_000,
    });
    expect(isReady(result.state)).toBe(false);
  });

  it('a block and an unblock during connecting give a ready that is ready', () => {
    const blocked = transition(connecting, ev.blocked({ reason: 'low on memory' })).state;
    const unblocked = transition(blocked, ev.unblocked()).state;

    expect(isReady(transition(unblocked, ev.attemptSucceeded({ now: 4_000 })).state)).toBe(true);
  });

  it('starts every new attempt unblocked, also after a recycle from a blocked connection', () => {
    // Ready since 1 000 and recycled at 9 000: under the reset period, so the attempt rises to 3.
    const recycled = transition(
      blockedReady,
      ev.trigger({ reason: 'connection_closed', now: 9_000 }),
    );
    const backedOff = transition(recycled.state, ev.closeFinished(G + 1));

    expect(transition(backedOff.state, ev.backoffElapsed(G + 1)).state).toEqual({
      name: 'connecting',
      generation: G + 2,
      attempt: 3,
      blocked: false,
      failed: false,
    });
  });

  it('resets the attempt only after the connection was ready for the reset period', () => {
    // `ready` has been ready since 1 000.
    const recycleAt = (now: number): PublisherState =>
      transition(ready, ev.trigger({ reason: 'nacked', now })).state;

    expect(BACKOFF_RESET_AFTER_MS).toBe(10_000);
    expect(recycleAt(11_000)).toMatchObject({ name: 'recycling', attempt: 0 });
    expect(recycleAt(10_999)).toMatchObject({ name: 'recycling', attempt: 3 });
  });

  it('carries the recycle reason and the reset attempt into the backoff', () => {
    const readyAtZero: PublisherState = { ...ready, readySince: 0 };
    const recycled = transition(readyAtZero, ev.trigger({ reason: 'confirm_stall', now: 60_000 }));

    expect(transition(recycled.state, ev.closeFinished(G + 1))).toEqual({
      state: { name: 'backoff', generation: G + 1, attempt: 0, reason: 'confirm_stall' },
      effects: [startBackoff({ attempt: 0, reason: 'confirm_stall' })],
    });
  });
});

describe('isReady', () => {
  it.each([
    { key: 'backoff', state: backoff, expected: false },
    { key: 'connecting', state: connecting, expected: false },
    { key: 'connecting-blocked', state: blockedConnecting, expected: false },
    { key: 'connecting-failed', state: failedConnecting, expected: false },
    { key: 'connecting-blocked-failed', state: blockedFailedConnecting, expected: false },
    { key: 'ready', state: ready, expected: true },
    { key: 'ready-blocked', state: blockedReady, expected: false },
    { key: 'recycling', state: recycling, expected: false },
    { key: 'stopped', state: stopped, expected: false },
  ])('is $expected for $key', ({ state, expected }) => {
    expect(isReady(state)).toBe(expected);
  });
});

describe('isConfirmStall', () => {
  it.each(VARIANTS)(
    '$key recycles only when ready, unblocked, with sent entries and a stalled clock',
    ({ key, state }) => {
      const answers = [false, true].flatMap((stalled) =>
        [0, 1].map((sentCount) => isConfirmStall({ state, sentCount, stalled })),
      );
      // Not stalled with 0 and 1 sent, then stalled with 0 and 1 sent.
      expect(answers).toEqual([false, false, false, key === 'ready']);
    },
  );
});
