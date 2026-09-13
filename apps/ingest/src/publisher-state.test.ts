import { describe, expect, it } from 'vitest';

import {
  BACKOFF_RESET_AFTER_MS,
  INITIAL_STATE,
  isReady,
  transition,
  type Effect,
  type LogEffectLevel,
  type PublisherEvent,
  type PublisherState,
} from './publisher-state.js';

/** The current generation of every state built below. */
const G = 5;

function backoff(attempt = 2, reason = 'connection_closed'): PublisherState {
  return { name: 'backoff', generation: G, attempt, reason };
}
function connecting(blocked = false): PublisherState {
  return { name: 'connecting', generation: G, attempt: 2, blocked, failed: false };
}
function failedConnecting(reason = 'channel_closed'): PublisherState {
  return { name: 'connecting', generation: G, attempt: 2, blocked: false, failed: true, reason };
}
function ready(blocked = false, readySince = 1_000): PublisherState {
  return { name: 'ready', generation: G, attempt: 2, blocked, readySince };
}
function recycling(attempt = 3, reason = 'nacked'): PublisherState {
  return { name: 'recycling', generation: G, attempt, reason };
}
const stopped: PublisherState = { name: 'stopped', generation: G };

const ev = {
  backoffElapsed: (generation = G): PublisherEvent => ({ type: 'backoff_elapsed', generation }),
  attemptSucceeded: ({ now = 9_000, generation = G }: { now?: number; generation?: number } = {}) =>
    ({ type: 'attempt_succeeded', generation, now }) satisfies PublisherEvent,
  attemptFailed: ({
    reason = 'connect ECONNREFUSED',
    generation = G,
  }: { reason?: string; generation?: number } = {}) =>
    ({ type: 'attempt_failed', generation, reason }) satisfies PublisherEvent,
  trigger: ({
    reason = 'channel_closed',
    now = 9_000,
    generation = G,
  }: { reason?: string; now?: number; generation?: number } = {}) =>
    ({ type: 'trigger', generation, reason, now }) satisfies PublisherEvent,
  closeFinished: (generation = G): PublisherEvent => ({ type: 'close_finished', generation }),
  blocked: ({
    reason = 'low on memory',
    generation = G,
  }: { reason?: string; generation?: number } = {}) =>
    ({ type: 'blocked', generation, reason }) satisfies PublisherEvent,
  unblocked: (generation = G): PublisherEvent => ({ type: 'unblocked', generation }),
  stop: (): PublisherEvent => ({ type: 'stop' }),
};

/** Every event type that carries a generation, all on `generation`. */
function eventsAt(generation: number): PublisherEvent[] {
  return [
    ev.backoffElapsed(generation),
    ev.attemptSucceeded({ generation }),
    ev.attemptFailed({ generation }),
    ev.trigger({ generation }),
    ev.closeFinished(generation),
    ev.blocked({ generation }),
    ev.unblocked(generation),
  ];
}

function logEffect(entry: {
  level: LogEffectLevel;
  message: string;
  fields: Record<string, unknown>;
}): Effect {
  return { type: 'log', ...entry };
}

const VARIANTS: { key: string; state: PublisherState }[] = [
  { key: 'backoff', state: backoff() },
  { key: 'connecting', state: connecting() },
  { key: 'connecting-blocked', state: connecting(true) },
  { key: 'connecting-failed', state: failedConnecting() },
  { key: 'ready', state: ready() },
  { key: 'ready-blocked', state: ready(true) },
  { key: 'recycling', state: recycling() },
  { key: 'stopped', state: stopped },
];

/** The rows of the spec's transition table, as `variant:event` pairs. */
const CONNECTING_EVENTS = [
  'attempt_succeeded',
  'attempt_failed',
  'trigger',
  'blocked',
  'unblocked',
  'stop',
];
const ROWS = new Set([
  'backoff:backoff_elapsed',
  'backoff:trigger',
  'backoff:stop',
  ...['connecting', 'connecting-blocked', 'connecting-failed'].flatMap((key) =>
    CONNECTING_EVENTS.map((type) => `${key}:${type}`),
  ),
  'ready:trigger',
  'ready:blocked',
  'ready:stop',
  'ready-blocked:trigger',
  'ready-blocked:unblocked',
  'ready-blocked:stop',
  'recycling:close_finished',
  'recycling:trigger',
  'recycling:stop',
]);

describe('transition — one test per row of the table', () => {
  it('backoff + backoff_elapsed: starts an attempt on a new generation after losing sent entries', () => {
    expect(transition(backoff(), ev.backoffElapsed())).toEqual({
      state: { name: 'connecting', generation: G + 1, attempt: 2, blocked: false, failed: false },
      effects: [{ type: 'lose' }, { type: 'start_attempt' }],
    });
  });

  it('connecting + attempt_succeeded: enters ready, publishes the pending entries, restarts the stall clock', () => {
    expect(transition(connecting(), ev.attemptSucceeded({ now: 7_000 }))).toEqual({
      state: { name: 'ready', generation: G, attempt: 2, blocked: false, readySince: 7_000 },
      effects: [
        { type: 'send_pending' },
        { type: 'restart_stall_clock' },
        logEffect({
          level: 'info',
          message: 'publisher connected',
          fields: { generation: G, attempt: 2 },
        }),
      ],
    });
  });

  it('failed connecting + attempt_succeeded: closes the new model and backs off with the trigger reason', () => {
    expect(transition(failedConnecting('channel_closed'), ev.attemptSucceeded())).toEqual({
      state: { name: 'backoff', generation: G, attempt: 3, reason: 'channel_closed' },
      effects: [
        { type: 'close_model' },
        { type: 'start_backoff', attempt: 3, reason: 'channel_closed' },
      ],
    });
  });

  it('connecting + attempt_failed: backs off one attempt further with the failure reason', () => {
    expect(transition(connecting(), ev.attemptFailed({ reason: 'connect ECONNREFUSED' }))).toEqual({
      state: { name: 'backoff', generation: G, attempt: 3, reason: 'connect ECONNREFUSED' },
      effects: [{ type: 'start_backoff', attempt: 3, reason: 'connect ECONNREFUSED' }],
    });
  });

  it('failed connecting + attempt_failed: backs off with the trigger reason, the root cause', () => {
    expect(
      transition(failedConnecting('channel_closed'), ev.attemptFailed({ reason: 'setup aborted' })),
    ).toEqual({
      state: { name: 'backoff', generation: G, attempt: 3, reason: 'channel_closed' },
      effects: [{ type: 'start_backoff', attempt: 3, reason: 'channel_closed' }],
    });
  });

  it('connecting + trigger: marks the attempt failed and keeps the reason', () => {
    expect(transition(connecting(), ev.trigger({ reason: 'channel_closed' }))).toEqual({
      state: {
        name: 'connecting',
        generation: G,
        attempt: 2,
        blocked: false,
        failed: true,
        reason: 'channel_closed',
      },
      effects: [
        logEffect({
          level: 'debug',
          message: 'recycle trigger during a connect attempt',
          fields: { reason: 'channel_closed' },
        }),
      ],
    });
  });

  it('failed connecting + trigger: keeps the first reason', () => {
    const state = failedConnecting('channel_closed');
    const result = transition(state, ev.trigger({ reason: 'connection_closed' }));

    expect(result.state).toBe(state);
    expect(result.effects).toEqual([
      logEffect({
        level: 'debug',
        message: 'recycle trigger during a connect attempt',
        fields: { reason: 'connection_closed' },
      }),
    ]);
  });

  it('connecting + blocked: records the block', () => {
    expect(transition(connecting(), ev.blocked({ reason: 'low on memory' }))).toEqual({
      state: { name: 'connecting', generation: G, attempt: 2, blocked: true, failed: false },
      effects: [
        logEffect({
          level: 'warn',
          message: 'connection blocked',
          fields: { reason: 'low on memory' },
        }),
      ],
    });
  });

  it('connecting + unblocked: clears the block', () => {
    expect(transition(connecting(true), ev.unblocked())).toEqual({
      state: { name: 'connecting', generation: G, attempt: 2, blocked: false, failed: false },
      effects: [logEffect({ level: 'info', message: 'connection unblocked', fields: {} })],
    });
  });

  it('ready + trigger: recycles on a new generation, loses sent entries and closes the model', () => {
    expect(transition(ready(false, 1_000), ev.trigger({ reason: 'nacked', now: 3_000 }))).toEqual({
      state: { name: 'recycling', generation: G + 1, attempt: 3, reason: 'nacked' },
      effects: [{ type: 'lose' }, { type: 'close_model' }],
    });
  });

  it('recycling + close_finished: starts the backoff with the recycle attempt and reason', () => {
    expect(transition(recycling(0, 'confirm_stall'), ev.closeFinished())).toEqual({
      state: { name: 'backoff', generation: G, attempt: 0, reason: 'confirm_stall' },
      effects: [{ type: 'start_backoff', attempt: 0, reason: 'confirm_stall' }],
    });
  });

  it('ready + blocked: stays ready but blocked', () => {
    expect(transition(ready(), ev.blocked({ reason: 'low on disk' }))).toEqual({
      state: { name: 'ready', generation: G, attempt: 2, blocked: true, readySince: 1_000 },
      effects: [
        logEffect({
          level: 'warn',
          message: 'connection blocked',
          fields: { reason: 'low on disk' },
        }),
      ],
    });
  });

  it('blocked ready + unblocked: unblocks and restarts the stall clock', () => {
    expect(transition(ready(true), ev.unblocked())).toEqual({
      state: { name: 'ready', generation: G, attempt: 2, blocked: false, readySince: 1_000 },
      effects: [
        { type: 'restart_stall_clock' },
        logEffect({ level: 'info', message: 'connection unblocked', fields: {} }),
      ],
    });
  });

  it.each([
    { key: 'recycling', state: recycling() },
    { key: 'backoff', state: backoff() },
  ])('$key + trigger: ignores it with a debug line', ({ state }) => {
    const result = transition(state, ev.trigger({ reason: 'channel_closed' }));

    expect(result.state).toBe(state);
    expect(result.effects).toEqual([
      logEffect({
        level: 'debug',
        message: 'ignored a recycle trigger while not ready',
        fields: { reason: 'channel_closed', state: state.name },
      }),
    ]);
  });

  it.each([
    { key: 'backoff', state: backoff(), closesModel: false },
    { key: 'connecting', state: connecting(), closesModel: true },
    { key: 'connecting-failed', state: failedConnecting(), closesModel: true },
    { key: 'ready', state: ready(), closesModel: true },
    { key: 'ready-blocked', state: ready(true), closesModel: true },
    { key: 'recycling', state: recycling(), closesModel: true },
  ])(
    '$key + stop: stops on a new generation (closes a model: $closesModel)',
    ({ state, closesModel }) => {
      const stopping = logEffect({
        level: 'info',
        message: 'publisher stopping',
        fields: { from: state.name },
      });

      expect(transition(state, ev.stop())).toEqual({
        state: { name: 'stopped', generation: G + 1 },
        effects: closesModel ? [{ type: 'close_model' }, stopping] : [stopping],
      });
    },
  );
});

describe('transition — generations and unlisted pairs', () => {
  it('starts in backoff on generation 0, and the first backoff_elapsed opens generation 1', () => {
    expect(INITIAL_STATE).toEqual({ name: 'backoff', generation: 0, attempt: 0, reason: 'start' });
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
    const failed = transition(connecting(), ev.trigger({ reason: 'channel_closed' })).state;
    const result = transition(failed, ev.attemptSucceeded());

    expect(result).toEqual({
      state: { name: 'backoff', generation: G, attempt: 3, reason: 'channel_closed' },
      effects: [
        { type: 'close_model' },
        { type: 'start_backoff', attempt: 3, reason: 'channel_closed' },
      ],
    });
    expect(isReady(result.state)).toBe(false);
  });

  it('a block during connecting carries into ready, which is then not ready', () => {
    const blocked = transition(connecting(), ev.blocked()).state;
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
    const blocked = transition(connecting(), ev.blocked()).state;
    const unblocked = transition(blocked, ev.unblocked()).state;

    expect(isReady(transition(unblocked, ev.attemptSucceeded()).state)).toBe(true);
  });

  it('starts every new attempt unblocked, also after a recycle from a blocked connection', () => {
    const recycled = transition(ready(true), ev.trigger({ reason: 'connection_closed' })).state;
    const backedOff = transition(recycled, ev.closeFinished(G + 1)).state;

    expect(transition(backedOff, ev.backoffElapsed(G + 1)).state).toEqual({
      name: 'connecting',
      generation: G + 2,
      attempt: 3,
      blocked: false,
      failed: false,
    });
  });

  it('resets the attempt only after the connection was ready for the reset period', () => {
    const since = 1_000;
    const recycleAt = (now: number): PublisherState =>
      transition(ready(false, since), ev.trigger({ now })).state;

    expect(BACKOFF_RESET_AFTER_MS).toBe(10_000);
    expect(recycleAt(since + 10_000)).toMatchObject({ name: 'recycling', attempt: 0 });
    expect(recycleAt(since + 9_999)).toMatchObject({ name: 'recycling', attempt: 3 });
  });

  it('carries the recycle reason and the reset attempt into the backoff', () => {
    const recycled = transition(
      ready(false, 0),
      ev.trigger({ reason: 'confirm_stall', now: 60_000 }),
    );

    expect(transition(recycled.state, ev.closeFinished(G + 1))).toEqual({
      state: { name: 'backoff', generation: G + 1, attempt: 0, reason: 'confirm_stall' },
      effects: [{ type: 'start_backoff', attempt: 0, reason: 'confirm_stall' }],
    });
  });
});

describe('isReady', () => {
  it.each([
    { key: 'backoff', state: backoff(), expected: false },
    { key: 'connecting', state: connecting(), expected: false },
    { key: 'connecting-blocked', state: connecting(true), expected: false },
    { key: 'connecting-failed', state: failedConnecting(), expected: false },
    { key: 'ready', state: ready(), expected: true },
    { key: 'ready-blocked', state: ready(true), expected: false },
    { key: 'recycling', state: recycling(), expected: false },
    { key: 'stopped', state: stopped, expected: false },
  ])('is $expected for $key', ({ state, expected }) => {
    expect(isReady(state)).toBe(expected);
  });
});
