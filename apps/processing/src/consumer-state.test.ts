import { describe, expect, it } from 'vitest';

import {
  INITIAL_STATE,
  LINK_RESET_AFTER_MS,
  isConsuming,
  transition,
  type ConsumerEvent,
  type ConsumerState,
  type Effect,
} from './consumer-state.js';

const G = 4;
const OPENED_AT = 1_000;

function backoff(storeReady: boolean, attempt = 2): ConsumerState {
  return { name: 'backoff', attempt, generation: G, storeReady };
}
function connecting(storeReady: boolean, attempt = 2): ConsumerState {
  return { name: 'connecting', attempt, generation: G, storeReady };
}
function open(consumer: 'idle' | 'active', storeReady: boolean): ConsumerState {
  return { name: 'open', consumer, attempt: 2, openedAt: OPENED_AT, generation: G, storeReady };
}
function draining(storeReady: boolean): ConsumerState {
  return { name: 'draining', generation: G, storeReady };
}
function stopped(storeReady: boolean): ConsumerState {
  return { name: 'stopped', generation: G, storeReady };
}

/** Every variant the machine distinguishes, with both values of the store flag. */
const VARIANTS: { label: string; state: ConsumerState }[] = [
  { label: 'backoff (store not ready)', state: backoff(false) },
  { label: 'backoff (store ready)', state: backoff(true) },
  { label: 'connecting (store not ready)', state: connecting(false) },
  { label: 'connecting (store ready)', state: connecting(true) },
  { label: 'open/idle (store not ready)', state: open('idle', false) },
  { label: 'open/idle (store ready)', state: open('idle', true) },
  { label: 'open/active (store not ready)', state: open('active', false) },
  { label: 'open/active (store ready)', state: open('active', true) },
  { label: 'draining (store not ready)', state: draining(false) },
  { label: 'draining (store ready)', state: draining(true) },
  { label: 'stopped (store not ready)', state: stopped(false) },
  { label: 'stopped (store ready)', state: stopped(true) },
];

const NOW = 5_000;

function generationEvents(generation: number): ConsumerEvent[] {
  return [
    { type: 'backoff_elapsed', generation },
    { type: 'link_opened', generation, now: NOW },
    { type: 'link_failed', generation, reason: 'connect_failed' },
    { type: 'link_closed', generation, reason: 'connection_closed', now: NOW },
    { type: 'consumer_registered', generation },
    { type: 'broker_cancelled', generation },
    { type: 'drained', generation },
  ];
}

const STORE_EVENTS: ConsumerEvent[] = [{ type: 'store_ready' }, { type: 'store_unavailable' }];
const STOP: ConsumerEvent = { type: 'stop' };
const ALL_EVENTS: ConsumerEvent[] = [...generationEvents(G), ...STORE_EVENTS, STOP];

const linkClosed = (now: number): ConsumerEvent => ({
  type: 'link_closed',
  generation: G,
  reason: 'connection_closed',
  now,
});

type Row = {
  label: string;
  state: ConsumerState;
  event: ConsumerEvent;
  next: ConsumerState;
  effects: Effect[];
};

/** The spec's table, one row per state variant it applies to (processing spec, decision 5). */
const ROWS: Row[] = [
  {
    label: 'backoff + backoff_elapsed opens a link on the next generation',
    state: backoff(false),
    event: { type: 'backoff_elapsed', generation: G },
    next: { name: 'connecting', attempt: 2, generation: G + 1, storeReady: false },
    effects: [{ kind: 'open_link' }],
  },
  {
    label: 'backoff + backoff_elapsed keeps the store flag',
    state: backoff(true),
    event: { type: 'backoff_elapsed', generation: G },
    next: { name: 'connecting', attempt: 2, generation: G + 1, storeReady: true },
    effects: [{ kind: 'open_link' }],
  },
  {
    label: 'connecting + link_opened consumes when the store is ready',
    state: connecting(true),
    event: { type: 'link_opened', generation: G, now: NOW },
    next: {
      name: 'open',
      consumer: 'idle',
      attempt: 2,
      openedAt: NOW,
      generation: G,
      storeReady: true,
    },
    effects: [{ kind: 'consume' }],
  },
  {
    label: 'connecting + link_opened waits for the store when it is not ready',
    state: connecting(false),
    event: { type: 'link_opened', generation: G, now: NOW },
    next: {
      name: 'open',
      consumer: 'idle',
      attempt: 2,
      openedAt: NOW,
      generation: G,
      storeReady: false,
    },
    effects: [],
  },
  {
    label: 'connecting + link_failed backs off with the next attempt',
    state: connecting(true),
    event: { type: 'link_failed', generation: G, reason: 'connect_failed' },
    next: backoff(true, 3),
    effects: [{ kind: 'schedule_backoff', attempt: 3, reason: 'connect_failed' }],
  },
  {
    label: 'open/idle + link_closed aborts the handlers and backs off',
    state: open('idle', true),
    event: linkClosed(OPENED_AT + LINK_RESET_AFTER_MS - 1),
    next: backoff(true, 3),
    effects: [
      { kind: 'abort_handlers' },
      { kind: 'schedule_backoff', attempt: 3, reason: 'connection_closed' },
    ],
  },
  {
    label: 'open/active + link_closed after a long open link resets the attempt',
    state: open('active', true),
    event: linkClosed(OPENED_AT + LINK_RESET_AFTER_MS),
    next: backoff(true, 0),
    effects: [
      { kind: 'abort_handlers' },
      { kind: 'schedule_backoff', attempt: 0, reason: 'connection_closed' },
    ],
  },
  {
    label: 'open/idle + consumer_registered becomes active',
    state: open('idle', true),
    event: { type: 'consumer_registered', generation: G },
    next: open('active', true),
    effects: [],
  },
  {
    label: 'open/active + broker_cancelled aborts and consumes again',
    state: open('active', true),
    event: { type: 'broker_cancelled', generation: G },
    next: open('idle', true),
    effects: [{ kind: 'abort_handlers' }, { kind: 'consume' }],
  },
  {
    label: 'open/active + broker_cancelled without a ready store only aborts',
    state: open('active', false),
    event: { type: 'broker_cancelled', generation: G },
    next: open('idle', false),
    effects: [{ kind: 'abort_handlers' }],
  },
  {
    label: 'open/active + store_unavailable runs the pause sequence',
    state: open('active', true),
    event: { type: 'store_unavailable' },
    next: open('idle', false),
    effects: [
      { kind: 'cancel_consumer' },
      { kind: 'abort_handlers' },
      { kind: 'return_held' },
      { kind: 'watch_store' },
    ],
  },
  {
    label: 'backoff + store_unavailable starts a watch when the store was ready',
    state: backoff(true),
    event: { type: 'store_unavailable' },
    next: backoff(false),
    effects: [{ kind: 'watch_store' }],
  },
  {
    label: 'backoff + store_unavailable changes nothing when the store was not ready',
    state: backoff(false),
    event: { type: 'store_unavailable' },
    next: backoff(false),
    effects: [],
  },
  {
    label: 'connecting + store_unavailable starts a watch when the store was ready',
    state: connecting(true),
    event: { type: 'store_unavailable' },
    next: connecting(false),
    effects: [{ kind: 'watch_store' }],
  },
  {
    label: 'open/idle + store_unavailable starts a watch when the store was ready',
    state: open('idle', true),
    event: { type: 'store_unavailable' },
    next: open('idle', false),
    effects: [{ kind: 'watch_store' }],
  },
  {
    label: 'open/idle + store_unavailable changes nothing when already paused',
    state: open('idle', false),
    event: { type: 'store_unavailable' },
    next: open('idle', false),
    effects: [],
  },
  {
    label: 'backoff + store_ready sets the flag',
    state: backoff(false),
    event: { type: 'store_ready' },
    next: backoff(true),
    effects: [],
  },
  {
    label: 'connecting + store_ready sets the flag without consuming',
    state: connecting(false),
    event: { type: 'store_ready' },
    next: connecting(true),
    effects: [],
  },
  {
    label: 'open/idle + store_ready consumes',
    state: open('idle', false),
    event: { type: 'store_ready' },
    next: open('idle', true),
    effects: [{ kind: 'consume' }],
  },
  {
    label: 'open/idle + store_ready while already ready does not consume twice',
    state: open('idle', true),
    event: { type: 'store_ready' },
    next: open('idle', true),
    effects: [],
  },
  {
    label: 'open/active + store_ready changes nothing',
    state: open('active', true),
    event: { type: 'store_ready' },
    next: open('active', true),
    effects: [],
  },
  {
    label: 'open/active + stop drains after cancelling the consumer',
    state: open('active', true),
    event: STOP,
    next: draining(true),
    effects: [{ kind: 'cancel_consumer' }],
  },
  {
    label: 'open/idle + stop drains with nothing to cancel',
    state: open('idle', true),
    event: STOP,
    next: draining(true),
    effects: [],
  },
  {
    label: 'backoff + stop stops at once',
    state: backoff(true),
    event: STOP,
    next: stopped(true),
    effects: [],
  },
  {
    label: 'connecting + stop stops and closes what the attempt opened',
    state: connecting(false),
    event: STOP,
    next: stopped(false),
    effects: [{ kind: 'close_link' }],
  },
  {
    label: 'draining + drained aborts the rest and closes the link',
    state: draining(true),
    event: { type: 'drained', generation: G },
    next: stopped(true),
    effects: [{ kind: 'abort_handlers' }, { kind: 'close_link' }],
  },
  {
    label: 'draining + link_closed stops without a close',
    state: draining(true),
    event: linkClosed(NOW),
    next: stopped(true),
    effects: [{ kind: 'abort_handlers' }],
  },
  {
    label: 'draining + broker_cancelled aborts the handlers',
    state: draining(true),
    event: { type: 'broker_cancelled', generation: G },
    next: draining(true),
    effects: [{ kind: 'abort_handlers' }],
  },
  {
    label: 'draining + consumer_registered cancels the late registration',
    state: draining(true),
    event: { type: 'consumer_registered', generation: G },
    next: draining(true),
    effects: [{ kind: 'cancel_consumer' }],
  },
  {
    label: 'draining + store_unavailable only updates the flag',
    state: draining(true),
    event: { type: 'store_unavailable' },
    next: draining(false),
    effects: [],
  },
  {
    label: 'draining + store_ready only updates the flag',
    state: draining(false),
    event: { type: 'store_ready' },
    next: draining(true),
    effects: [],
  },
];

function pairKey(state: ConsumerState, event: ConsumerEvent): string {
  const consumer = state.name === 'open' ? state.consumer : '-';
  return `${state.name}/${consumer}/${event.type}`;
}

/** The (state, consumer, event) triples the table above has a row for. */
const COVERED = new Set(ROWS.map((row) => pairKey(row.state, row.event)));

describe('transition', () => {
  it.each(ROWS)('$label', ({ state, event, next, effects }) => {
    expect(transition(state, event)).toEqual({ state: next, effects });
  });

  it('starts by opening the first link on generation 1', () => {
    expect(transition(INITIAL_STATE, { type: 'backoff_elapsed', generation: 0 })).toEqual({
      state: { name: 'connecting', attempt: 0, generation: 1, storeReady: false },
      effects: [{ kind: 'open_link' }],
    });
  });

  it('runs the pause once, ignores a second report, and consumes again when the store is back', () => {
    const paused = transition(open('active', true), { type: 'store_unavailable' });
    expect(paused.effects).toEqual([
      { kind: 'cancel_consumer' },
      { kind: 'abort_handlers' },
      { kind: 'return_held' },
      { kind: 'watch_store' },
    ]);
    expect(paused.state).toEqual(open('idle', false));

    const again = transition(paused.state, { type: 'store_unavailable' });
    expect(again).toEqual({ state: paused.state, effects: [] });

    const resumed = transition(again.state, { type: 'store_ready' });
    expect(resumed).toEqual({ state: open('idle', true), effects: [{ kind: 'consume' }] });
  });

  it('re-registers on the same link after a broker cancel', () => {
    const cancelled = transition(open('active', true), { type: 'broker_cancelled', generation: G });
    expect(cancelled).toEqual({
      state: open('idle', true),
      effects: [{ kind: 'abort_handlers' }, { kind: 'consume' }],
    });

    const registered = transition(cancelled.state, { type: 'consumer_registered', generation: G });
    expect(registered).toEqual({ state: open('active', true), effects: [] });
  });

  it('drains in two phases: cancel on stop, abort and close on drained', () => {
    const drainingNow = transition(open('active', true), STOP);
    expect(drainingNow).toEqual({ state: draining(true), effects: [{ kind: 'cancel_consumer' }] });

    const done = transition(drainingNow.state, { type: 'drained', generation: G });
    expect(done).toEqual({
      state: stopped(true),
      effects: [{ kind: 'abort_handlers' }, { kind: 'close_link' }],
    });

    expect(transition(open('idle', true), STOP)).toEqual({ state: draining(true), effects: [] });
  });

  it('resets the attempt only after the link stayed open for LINK_RESET_AFTER_MS', () => {
    const reset = transition(open('active', true), linkClosed(OPENED_AT + LINK_RESET_AFTER_MS));
    const notYet = transition(
      open('active', true),
      linkClosed(OPENED_AT + LINK_RESET_AFTER_MS - 1),
    );

    expect(reset.state).toMatchObject({ name: 'backoff', attempt: 0 });
    expect(notYet.state).toMatchObject({ name: 'backoff', attempt: 3 });
  });

  it.each(VARIANTS)('ignores every event of another generation in $label', ({ state }) => {
    for (const event of [...generationEvents(G - 1), ...generationEvents(G + 1)]) {
      expect(transition(state, event)).toEqual({ state, effects: [] });
    }
  });

  it.each(VARIANTS)('leaves $label unchanged for every pair without a row', ({ state }) => {
    for (const event of ALL_EVENTS) {
      if (state.name !== 'stopped' && COVERED.has(pairKey(state, event))) {
        continue;
      }
      expect(transition(state, event)).toEqual({ state, effects: [] });
    }
  });

  it('never leaves stopped, whatever arrives', () => {
    for (const storeReady of [false, true]) {
      for (const event of ALL_EVENTS) {
        expect(transition(stopped(storeReady), event)).toEqual({
          state: stopped(storeReady),
          effects: [],
        });
      }
    }
  });

  it.each(VARIANTS)('stops or drains from $label', ({ state }) => {
    const { state: next } = transition(state, STOP);

    expect(['stopped', 'draining']).toContain(next.name);
    expect(next.generation).toBe(state.generation);
    expect(next.storeReady).toBe(state.storeReady);
  });

  it('waits for the store after a link opened without it, then consumes on store_ready', () => {
    const opened = transition(connecting(false), { type: 'link_opened', generation: G, now: NOW });
    expect(opened.effects).toEqual([]);

    const ready = transition(opened.state, { type: 'store_ready' });
    expect(ready.effects).toEqual([{ kind: 'consume' }]);
    expect(ready.state).toMatchObject({ name: 'open', consumer: 'idle', storeReady: true });
  });
});

describe('isConsuming', () => {
  it.each(VARIANTS)('is true only for open/active with a ready store: $label', ({ state }) => {
    const expected = state.name === 'open' && state.consumer === 'active' && state.storeReady;

    expect(isConsuming(state)).toBe(expected);
  });
});
