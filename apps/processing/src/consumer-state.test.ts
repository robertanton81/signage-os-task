import { describe, expect, it } from 'vitest';

import {
  INITIAL_STATE,
  LINK_RESET_AFTER_MS,
  isConsuming,
  transition,
  type ConsumerEvent,
  type ConsumerState,
  type ConsumerStatus,
  type Effect,
} from './consumer-state.js';

const G = 4;
const OPENED_AT = 1_000;
const ATTEMPT = 2;

function backoff(storeReady: boolean, attempt = ATTEMPT): ConsumerState {
  return { name: 'backoff', attempt, generation: G, storeReady };
}
function connecting(storeReady: boolean): ConsumerState {
  return { name: 'connecting', attempt: ATTEMPT, generation: G, storeReady };
}
function open(consumer: ConsumerStatus, storeReady: boolean): ConsumerState {
  return {
    name: 'open',
    consumer,
    attempt: ATTEMPT,
    openedAt: OPENED_AT,
    generation: G,
    storeReady,
  };
}
function draining(storeReady: boolean): ConsumerState {
  return { name: 'draining', generation: G, storeReady };
}
function stopped(storeReady: boolean): ConsumerState {
  return { name: 'stopped', generation: G, storeReady };
}

/** Every variant the machine distinguishes, with both values of the store flag. */
const VARIANTS: { label: string; state: ConsumerState }[] = [false, true].flatMap((ready) => {
  const flag = ready ? 'store ready' : 'store not ready';
  return [
    { label: `backoff (${flag})`, state: backoff(ready) },
    { label: `connecting (${flag})`, state: connecting(ready) },
    { label: `open/idle (${flag})`, state: open('idle', ready) },
    { label: `open/registering (${flag})`, state: open('registering', ready) },
    { label: `open/active (${flag})`, state: open('active', ready) },
    { label: `draining (${flag})`, state: draining(ready) },
    { label: `stopped (${flag})`, state: stopped(ready) },
  ];
});

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

const BACKOFF_ELAPSED: ConsumerEvent = { type: 'backoff_elapsed', generation: G };
const LINK_OPENED: ConsumerEvent = { type: 'link_opened', generation: G, now: NOW };
const LINK_FAILED: ConsumerEvent = { type: 'link_failed', generation: G, reason: 'connect_failed' };
const REGISTERED: ConsumerEvent = { type: 'consumer_registered', generation: G };
const BROKER_CANCELLED: ConsumerEvent = { type: 'broker_cancelled', generation: G };
const DRAINED: ConsumerEvent = { type: 'drained', generation: G };
const STORE_READY: ConsumerEvent = { type: 'store_ready' };
const STORE_UNAVAILABLE: ConsumerEvent = { type: 'store_unavailable' };
const STOP: ConsumerEvent = { type: 'stop' };
const ALL_EVENTS: ConsumerEvent[] = [...generationEvents(G), STORE_READY, STORE_UNAVAILABLE, STOP];

const linkClosed = (now: number): ConsumerEvent => ({
  type: 'link_closed',
  generation: G,
  reason: 'connection_closed',
  now,
});
/** A close before the reset window: the attempt grows. */
const EARLY_CLOSE = linkClosed(OPENED_AT + LINK_RESET_AFTER_MS - 1);

const WATCH: Effect[] = [{ kind: 'watch_store' }];
const CONSUME: Effect[] = [{ kind: 'consume' }];
const PAUSE: Effect[] = [
  { kind: 'cancel_consumer' },
  { kind: 'abort_handlers' },
  { kind: 'return_held' },
  { kind: 'watch_store' },
];
const RECYCLE: Effect[] = [
  { kind: 'abort_handlers' },
  { kind: 'schedule_backoff', attempt: ATTEMPT + 1, reason: 'connection_closed' },
];

type Row = {
  label: string;
  state: ConsumerState;
  event: ConsumerEvent;
  next: ConsumerState;
  effects?: Effect[];
};

const BOTH = [false, true] as const;
const flag = (ready: boolean): string => (ready ? 'store ready' : 'store not ready');

/**
 * The spec's table (processing spec, decision 5), one row per state variant and store flag it
 * applies to. Every pair not listed here is asserted unchanged by the sweep below.
 */
const ROWS: Row[] = [
  // backoff
  ...BOTH.map((ready) => ({
    label: `backoff (${flag(ready)}) + backoff_elapsed opens the next link`,
    state: backoff(ready),
    event: BACKOFF_ELAPSED,
    next: { name: 'connecting', attempt: ATTEMPT, generation: G + 1, storeReady: ready } as const,
    effects: [{ kind: 'open_link' }] as Effect[],
  })),
  {
    label: 'backoff + store_unavailable watches when the store was ready',
    state: backoff(true),
    event: STORE_UNAVAILABLE,
    next: backoff(false),
    effects: WATCH,
  },
  {
    label: 'backoff + store_unavailable changes nothing when it was not',
    state: backoff(false),
    event: STORE_UNAVAILABLE,
    next: backoff(false),
  },
  {
    label: 'backoff + store_ready sets the flag',
    state: backoff(false),
    event: STORE_READY,
    next: backoff(true),
  },
  {
    label: 'backoff + store_ready while ready changes nothing',
    state: backoff(true),
    event: STORE_READY,
    next: backoff(true),
  },
  ...BOTH.map((ready) => ({
    label: `backoff (${flag(ready)}) + stop stops at once`,
    state: backoff(ready),
    event: STOP,
    next: stopped(ready),
  })),
  // connecting
  {
    label: 'connecting + link_opened registers when the store is ready',
    state: connecting(true),
    event: LINK_OPENED,
    next: {
      name: 'open',
      consumer: 'registering',
      attempt: ATTEMPT,
      openedAt: NOW,
      generation: G,
      storeReady: true,
    },
    effects: CONSUME,
  },
  {
    label: 'connecting + link_opened waits idle when the store is not ready',
    state: connecting(false),
    event: LINK_OPENED,
    next: {
      name: 'open',
      consumer: 'idle',
      attempt: ATTEMPT,
      openedAt: NOW,
      generation: G,
      storeReady: false,
    },
  },
  ...BOTH.map((ready) => ({
    label: `connecting (${flag(ready)}) + link_failed backs off with the next attempt`,
    state: connecting(ready),
    event: LINK_FAILED,
    next: backoff(ready, ATTEMPT + 1),
    effects: [
      { kind: 'schedule_backoff', attempt: ATTEMPT + 1, reason: 'connect_failed' },
    ] as Effect[],
  })),
  {
    label: 'connecting + store_unavailable watches when the store was ready',
    state: connecting(true),
    event: STORE_UNAVAILABLE,
    next: connecting(false),
    effects: WATCH,
  },
  {
    label: 'connecting + store_unavailable changes nothing when it was not',
    state: connecting(false),
    event: STORE_UNAVAILABLE,
    next: connecting(false),
  },
  {
    label: 'connecting + store_ready sets the flag without consuming',
    state: connecting(false),
    event: STORE_READY,
    next: connecting(true),
  },
  {
    label: 'connecting + store_ready while ready changes nothing',
    state: connecting(true),
    event: STORE_READY,
    next: connecting(true),
  },
  ...BOTH.map((ready) => ({
    label: `connecting (${flag(ready)}) + stop stops and closes what the attempt opened`,
    state: connecting(ready),
    event: STOP,
    next: stopped(ready),
    effects: [{ kind: 'close_link' }] as Effect[],
  })),
  // open/idle
  ...BOTH.map((ready) => ({
    label: `open/idle (${flag(ready)}) + link_closed recycles`,
    state: open('idle', ready),
    event: EARLY_CLOSE,
    next: backoff(ready, ATTEMPT + 1),
    effects: RECYCLE,
  })),
  {
    label: 'open/idle + store_ready registers',
    state: open('idle', false),
    event: STORE_READY,
    next: open('registering', true),
    effects: CONSUME,
  },
  {
    label: 'open/idle + store_ready while ready changes nothing',
    state: open('idle', true),
    event: STORE_READY,
    next: open('idle', true),
  },
  {
    label: 'open/idle + store_unavailable watches when the store was ready',
    state: open('idle', true),
    event: STORE_UNAVAILABLE,
    next: open('idle', false),
    effects: WATCH,
  },
  {
    label: 'open/idle + store_unavailable changes nothing when already paused',
    state: open('idle', false),
    event: STORE_UNAVAILABLE,
    next: open('idle', false),
  },
  ...BOTH.map((ready) => ({
    label: `open/idle (${flag(ready)}) + stop drains with nothing to cancel`,
    state: open('idle', ready),
    event: STOP,
    next: draining(ready),
  })),
  // open/registering
  {
    label: 'open/registering + consumer_registered becomes active while the store is ready',
    state: open('registering', true),
    event: REGISTERED,
    next: open('active', true),
  },
  {
    label: 'open/registering + consumer_registered keeps the openedAt the link was opened with',
    state: {
      name: 'open',
      consumer: 'registering',
      attempt: ATTEMPT,
      openedAt: 2_222,
      generation: G,
      storeReady: true,
    },
    event: REGISTERED,
    next: {
      name: 'open',
      consumer: 'active',
      attempt: ATTEMPT,
      openedAt: 2_222,
      generation: G,
      storeReady: true,
    },
  },
  {
    label:
      'open/registering + consumer_registered is cancelled and returned when the store went away',
    state: open('registering', false),
    event: REGISTERED,
    next: open('idle', false),
    effects: [{ kind: 'cancel_consumer' }, { kind: 'abort_handlers' }, { kind: 'return_held' }],
  },
  {
    label: 'open/registering + store_unavailable watches and keeps the registration pending',
    state: open('registering', true),
    event: STORE_UNAVAILABLE,
    next: open('registering', false),
    effects: WATCH,
  },
  {
    label: 'open/registering + store_unavailable changes nothing when already paused',
    state: open('registering', false),
    event: STORE_UNAVAILABLE,
    next: open('registering', false),
  },
  {
    label: 'open/registering + store_ready issues no second consume',
    state: open('registering', false),
    event: STORE_READY,
    next: open('registering', true),
  },
  {
    label: 'open/registering + store_ready while ready changes nothing',
    state: open('registering', true),
    event: STORE_READY,
    next: open('registering', true),
  },
  ...BOTH.map((ready) => ({
    label: `open/registering (${flag(ready)}) + link_closed recycles`,
    state: open('registering', ready),
    event: EARLY_CLOSE,
    next: backoff(ready, ATTEMPT + 1),
    effects: RECYCLE,
  })),
  ...BOTH.map((ready) => ({
    label: `open/registering (${flag(ready)}) + stop drains; the late registration is cancelled there`,
    state: open('registering', ready),
    event: STOP,
    next: draining(ready),
  })),
  // open/active
  {
    label: 'open/active + broker_cancelled aborts and registers again',
    state: open('active', true),
    event: BROKER_CANCELLED,
    next: open('registering', true),
    effects: [{ kind: 'abort_handlers' }, { kind: 'consume' }],
  },
  {
    label: 'open/active + broker_cancelled without a ready store only aborts',
    state: open('active', false),
    event: BROKER_CANCELLED,
    next: open('idle', false),
    effects: [{ kind: 'abort_handlers' }],
  },
  ...BOTH.map((ready) => ({
    label: `open/active (${flag(ready)}) + store_unavailable runs the pause sequence`,
    state: open('active', ready),
    event: STORE_UNAVAILABLE,
    next: open('idle', false),
    effects: PAUSE,
  })),
  {
    label: 'open/active + store_ready while ready changes nothing',
    state: open('active', true),
    event: STORE_READY,
    next: open('active', true),
  },
  {
    label: 'open/active + store_ready sets the flag',
    state: open('active', false),
    event: STORE_READY,
    next: open('active', true),
  },
  ...BOTH.map((ready) => ({
    label: `open/active (${flag(ready)}) + link_closed recycles`,
    state: open('active', ready),
    event: EARLY_CLOSE,
    next: backoff(ready, ATTEMPT + 1),
    effects: RECYCLE,
  })),
  ...BOTH.map((ready) => ({
    label: `open/active (${flag(ready)}) + stop cancels and drains`,
    state: open('active', ready),
    event: STOP,
    next: draining(ready),
    effects: [{ kind: 'cancel_consumer' }] as Effect[],
  })),
  // draining
  ...BOTH.map((ready) => ({
    label: `draining (${flag(ready)}) + drained aborts the rest and closes the link`,
    state: draining(ready),
    event: DRAINED,
    next: stopped(ready),
    effects: [{ kind: 'abort_handlers' }, { kind: 'close_link' }] as Effect[],
  })),
  ...BOTH.map((ready) => ({
    label: `draining (${flag(ready)}) + link_closed stops without a close`,
    state: draining(ready),
    event: linkClosed(NOW),
    next: stopped(ready),
    effects: [{ kind: 'abort_handlers' }] as Effect[],
  })),
  ...BOTH.map((ready) => ({
    label: `draining (${flag(ready)}) + broker_cancelled aborts the handlers`,
    state: draining(ready),
    event: BROKER_CANCELLED,
    next: draining(ready),
    effects: [{ kind: 'abort_handlers' }] as Effect[],
  })),
  ...BOTH.map((ready) => ({
    label: `draining (${flag(ready)}) + consumer_registered cancels the late registration`,
    state: draining(ready),
    event: REGISTERED,
    next: draining(ready),
    effects: [{ kind: 'cancel_consumer' }] as Effect[],
  })),
  {
    label: 'draining + store_unavailable only updates the flag',
    state: draining(true),
    event: STORE_UNAVAILABLE,
    next: draining(false),
  },
  {
    label: 'draining + store_unavailable while paused changes nothing',
    state: draining(false),
    event: STORE_UNAVAILABLE,
    next: draining(false),
  },
  {
    label: 'draining + store_ready only updates the flag',
    state: draining(false),
    event: STORE_READY,
    next: draining(true),
  },
  {
    label: 'draining + store_ready while ready changes nothing',
    state: draining(true),
    event: STORE_READY,
    next: draining(true),
  },
];

function pairKey(state: ConsumerState, event: ConsumerEvent): string {
  const consumer = state.name === 'open' ? state.consumer : '-';
  return `${state.name}/${consumer}/${String(state.storeReady)}/${event.type}`;
}

/** The (state, consumer, store flag, event) tuples the table above has a row for. */
const COVERED = new Set(ROWS.map((entry) => pairKey(entry.state, entry.event)));

describe('transition', () => {
  it.each(ROWS)('$label', ({ state, event, next, effects = [] }) => {
    expect(transition(state, event)).toEqual({ state: next, effects });
  });

  it('starts by opening the first link on generation 1', () => {
    expect(transition(INITIAL_STATE, { type: 'backoff_elapsed', generation: 0 })).toEqual({
      state: { name: 'connecting', attempt: 0, generation: 1, storeReady: false },
      effects: [{ kind: 'open_link' }],
    });
  });

  it('runs the pause once, ignores a second report, and registers again when the store is back', () => {
    const paused = transition(open('active', true), STORE_UNAVAILABLE);
    expect(paused).toEqual({ state: open('idle', false), effects: PAUSE });

    const again = transition(paused.state, STORE_UNAVAILABLE);
    expect(again).toEqual({ state: paused.state, effects: [] });

    const resumed = transition(again.state, STORE_READY);
    expect(resumed).toEqual({ state: open('registering', true), effects: CONSUME });

    expect(transition(resumed.state, REGISTERED)).toEqual({
      state: open('active', true),
      effects: [],
    });
  });

  it('re-registers on the same link after a broker cancel', () => {
    const cancelled = transition(open('active', true), BROKER_CANCELLED);
    expect(cancelled).toEqual({
      state: open('registering', true),
      effects: [{ kind: 'abort_handlers' }, { kind: 'consume' }],
    });

    expect(transition(cancelled.state, REGISTERED)).toEqual({
      state: open('active', true),
      effects: [],
    });
  });

  it('cancels and returns a registration that lands after the store went away, then registers again', () => {
    const outage = transition(open('registering', true), STORE_UNAVAILABLE);
    expect(outage).toEqual({ state: open('registering', false), effects: WATCH });

    const landed = transition(outage.state, REGISTERED);
    expect(landed).toEqual({
      state: open('idle', false),
      effects: [{ kind: 'cancel_consumer' }, { kind: 'abort_handlers' }, { kind: 'return_held' }],
    });

    const back = transition(landed.state, STORE_READY);
    expect(back).toEqual({ state: open('registering', true), effects: CONSUME });
    expect(transition(back.state, REGISTERED)).toEqual({
      state: open('active', true),
      effects: [],
    });
  });

  it('issues no second consume when the store comes back while a registration is pending', () => {
    const outage = transition(open('registering', true), STORE_UNAVAILABLE);
    const back = transition(outage.state, STORE_READY);
    expect(back).toEqual({ state: open('registering', true), effects: [] });

    expect(transition(back.state, REGISTERED)).toEqual({
      state: open('active', true),
      effects: [],
    });
  });

  it('drains in two phases: cancel on stop, abort and close on drained', () => {
    const drainingNow = transition(open('active', true), STOP);
    expect(drainingNow).toEqual({ state: draining(true), effects: [{ kind: 'cancel_consumer' }] });

    const done = transition(drainingNow.state, DRAINED);
    expect(done).toEqual({
      state: stopped(true),
      effects: [{ kind: 'abort_handlers' }, { kind: 'close_link' }],
    });
  });

  it('resets the attempt only after the link stayed open for LINK_RESET_AFTER_MS', () => {
    const reset = transition(open('active', true), linkClosed(OPENED_AT + LINK_RESET_AFTER_MS));
    const notYet = transition(open('active', true), EARLY_CLOSE);

    expect(reset).toEqual({
      state: backoff(true, 0),
      effects: [
        { kind: 'abort_handlers' },
        { kind: 'schedule_backoff', attempt: 0, reason: 'connection_closed' },
      ],
    });
    expect(notYet.state).toEqual(backoff(true, ATTEMPT + 1));
  });

  it.each(VARIANTS)('ignores every event of another generation in $label', ({ state }) => {
    for (const event of [...generationEvents(G - 1), ...generationEvents(G + 1)]) {
      expect(transition(state, event)).toEqual({ state, effects: [] });
    }
  });

  it.each(VARIANTS)('leaves $label unchanged for every pair without a row', ({ state }) => {
    for (const event of ALL_EVENTS) {
      if (COVERED.has(pairKey(state, event))) {
        continue;
      }
      expect(transition(state, event)).toEqual({ state, effects: [] });
    }
  });

  it('never leaves stopped, whatever arrives', () => {
    for (const storeReady of BOTH) {
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

  it('waits idle for the store after a link opened without it, then registers on store_ready', () => {
    const opened = transition(connecting(false), LINK_OPENED);
    expect(opened.effects).toEqual([]);
    expect(opened.state).toMatchObject({ name: 'open', consumer: 'idle', storeReady: false });

    const ready = transition(opened.state, STORE_READY);
    expect(ready.effects).toEqual(CONSUME);
    expect(ready.state).toMatchObject({ name: 'open', consumer: 'registering', storeReady: true });
  });
});

describe('isConsuming', () => {
  /** The contract as a table: exactly one of the fourteen variants consumes. */
  const CONSUMING = new Set(['open/active (store ready)']);

  it.each(VARIANTS)(
    'is true only for open/active with a ready store: $label',
    ({ label, state }) => {
      expect(isConsuming(state)).toBe(CONSUMING.has(label));
    },
  );
});
