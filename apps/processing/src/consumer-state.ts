import { assertNever } from '@telemetry/shared';

/**
 * The consumer's lifecycle as a pure state machine (processing spec, decisions 5, 6, 12 and 20),
 * the shape of the ingest publisher's. `generation` numbers the link (one AMQP connection and
 * channel); an event of another generation is ignored by construction. `storeReady` is a property
 * of the instance, not of one link, so the two store events carry no generation and the flag
 * survives a link recycle. `open` carries `attempt` because the reset rule of `link_closed` needs
 * the number the link was opened with; `draining` is the stopping phase between the consumer
 * cancel and the link close, in which handlers still acknowledge.
 */
type Flags = { generation: number; storeReady: boolean };

export type ConsumerState =
  | ({ name: 'backoff'; attempt: number } & Flags)
  | ({ name: 'connecting'; attempt: number } & Flags)
  | ({ name: 'open'; consumer: 'idle' | 'active'; attempt: number; openedAt: number } & Flags)
  | ({ name: 'draining' } & Flags)
  | ({ name: 'stopped' } & Flags);

export type ConsumerEvent =
  | { type: 'backoff_elapsed'; generation: number }
  | { type: 'link_opened'; generation: number; now: number }
  | { type: 'link_failed'; generation: number; reason: string }
  | { type: 'link_closed'; generation: number; reason: string; now: number }
  | { type: 'consumer_registered'; generation: number }
  | { type: 'broker_cancelled'; generation: number }
  | { type: 'drained'; generation: number }
  | { type: 'store_ready' }
  | { type: 'store_unavailable' }
  | { type: 'stop' };

export type Effect =
  | { kind: 'open_link' }
  | { kind: 'schedule_backoff'; attempt: number; reason: string }
  | { kind: 'consume' }
  | { kind: 'cancel_consumer' }
  | { kind: 'abort_handlers' }
  | { kind: 'return_held' }
  | { kind: 'watch_store' }
  | { kind: 'close_link' };

export type Transition = { state: ConsumerState; effects: Effect[] };

/** An open link resets the backoff attempt once it stayed open this long (decision 6). */
export const LINK_RESET_AFTER_MS = 10_000;

export const INITIAL_STATE: ConsumerState = {
  name: 'backoff',
  attempt: 0,
  generation: 0,
  storeReady: false,
};

type Running = Exclude<ConsumerState, { name: 'stopped' }>;
type Backoff = Extract<ConsumerState, { name: 'backoff' }>;
type Connecting = Extract<ConsumerState, { name: 'connecting' }>;
type Open = Extract<ConsumerState, { name: 'open' }>;
type Draining = Extract<ConsumerState, { name: 'draining' }>;
/** The events that carry a generation. */
type LinkEvent = Exclude<ConsumerEvent, { type: 'stop' | 'store_ready' | 'store_unavailable' }>;

/** Open, registered and the store ready: the input of the readiness report (decision 19). */
export function isConsuming(state: ConsumerState): boolean {
  return state.name === 'open' && state.consumer === 'active' && state.storeReady;
}

/**
 * The next state and the effects the shell must run, in order. Pure. A generation-carrying event
 * of another generation, and a same-generation pair without a row in the spec's table, return the
 * same state and no effects. Nothing changes a stopped consumer.
 */
export function transition(state: ConsumerState, event: ConsumerEvent): Transition {
  if (state.name === 'stopped') {
    return unchanged(state);
  }
  if (event.type === 'stop') {
    return stop(state);
  }
  if (event.type === 'store_ready') {
    return storeReady(state);
  }
  if (event.type === 'store_unavailable') {
    return storeUnavailable(state);
  }
  if (event.generation !== state.generation) {
    return unchanged(state);
  }
  return onLinkEvent(state, event);
}

function onLinkEvent(state: Running, event: LinkEvent): Transition {
  switch (state.name) {
    case 'backoff':
      return fromBackoff(state, event);
    case 'connecting':
      return fromConnecting(state, event);
    case 'open':
      return fromOpen(state, event);
    case 'draining':
      return fromDraining(state, event);
    default:
      return assertNever(state, 'consumer state');
  }
}

function unchanged(state: ConsumerState): Transition {
  return { state, effects: [] };
}

function stop(state: Running): Transition {
  switch (state.name) {
    case 'backoff':
      return { state: stopped(state), effects: [] };
    case 'connecting':
      // The attempt closes what it opened at its next check; the effect covers a link it already handed over.
      return { state: stopped(state), effects: [{ kind: 'close_link' }] };
    case 'open':
      return {
        state: { name: 'draining', generation: state.generation, storeReady: state.storeReady },
        effects: state.consumer === 'active' ? [{ kind: 'cancel_consumer' }] : [],
      };
    case 'draining':
      return unchanged(state);
    default:
      return assertNever(state, 'consumer state');
  }
}

function stopped(state: Running): ConsumerState {
  return { name: 'stopped', generation: state.generation, storeReady: state.storeReady };
}

function storeReady(state: Running): Transition {
  // Only a link that waits for the store consumes now; a second store_ready must not register a
  // second consumer on the same channel, and an active consumer already has one.
  const consume = state.name === 'open' && state.consumer === 'idle' && !state.storeReady;
  return { state: { ...state, storeReady: true }, effects: consume ? [{ kind: 'consume' }] : [] };
}

function storeUnavailable(state: Running): Transition {
  if (state.name === 'open' && state.consumer === 'active') {
    // Decision 12: cancel, abort, return what is held once the handlers settled, then watch.
    return {
      state: { ...state, consumer: 'idle', storeReady: false },
      effects: [
        { kind: 'cancel_consumer' },
        { kind: 'abort_handlers' },
        { kind: 'return_held' },
        { kind: 'watch_store' },
      ],
    };
  }
  if (state.name === 'draining') {
    return { state: { ...state, storeReady: false }, effects: [] };
  }
  // A watch runs at most once per outage: only the report that flips the flag starts it.
  return {
    state: { ...state, storeReady: false },
    effects: state.storeReady ? [{ kind: 'watch_store' }] : [],
  };
}

function fromBackoff(state: Backoff, event: LinkEvent): Transition {
  if (event.type === 'backoff_elapsed') {
    return {
      state: {
        name: 'connecting',
        attempt: state.attempt,
        generation: state.generation + 1,
        storeReady: state.storeReady,
      },
      effects: [{ kind: 'open_link' }],
    };
  }
  return unchanged(state);
}

function fromConnecting(state: Connecting, event: LinkEvent): Transition {
  switch (event.type) {
    case 'link_opened':
      return {
        state: {
          name: 'open',
          consumer: 'idle',
          attempt: state.attempt,
          openedAt: event.now,
          generation: state.generation,
          storeReady: state.storeReady,
        },
        effects: state.storeReady ? [{ kind: 'consume' }] : [],
      };
    case 'link_failed': {
      const attempt = state.attempt + 1;
      return {
        state: { ...state, name: 'backoff', attempt },
        effects: [{ kind: 'schedule_backoff', attempt, reason: event.reason }],
      };
    }
    case 'backoff_elapsed':
    case 'link_closed':
    case 'consumer_registered':
    case 'broker_cancelled':
    case 'drained':
      // A close during the attempt is reported by the attempt itself as link_failed (decision 6).
      return unchanged(state);
    default:
      return assertNever(event, 'consumer event');
  }
}

function fromOpen(state: Open, event: LinkEvent): Transition {
  switch (event.type) {
    case 'link_closed': {
      // Only a link that stayed open for the longest backoff resets the attempt.
      const attempt = event.now - state.openedAt >= LINK_RESET_AFTER_MS ? 0 : state.attempt + 1;
      return {
        state: {
          name: 'backoff',
          attempt,
          generation: state.generation,
          storeReady: state.storeReady,
        },
        effects: [
          { kind: 'abort_handlers' },
          { kind: 'schedule_backoff', attempt, reason: event.reason },
        ],
      };
    }
    case 'consumer_registered':
      return state.consumer === 'idle'
        ? { state: { ...state, consumer: 'active' }, effects: [] }
        : unchanged(state);
    case 'broker_cancelled':
      if (state.consumer !== 'active') {
        return unchanged(state);
      }
      // The broker returned the deliveries and cancelled only this consumer; the channel stays.
      return {
        state: { ...state, consumer: 'idle' },
        effects: state.storeReady
          ? [{ kind: 'abort_handlers' }, { kind: 'consume' }]
          : [{ kind: 'abort_handlers' }],
      };
    case 'backoff_elapsed':
    case 'link_opened':
    case 'link_failed':
    case 'drained':
      return unchanged(state);
    default:
      return assertNever(event, 'consumer event');
  }
}

function fromDraining(state: Draining, event: LinkEvent): Transition {
  switch (event.type) {
    case 'drained':
      return {
        state: stopped(state),
        effects: [{ kind: 'abort_handlers' }, { kind: 'close_link' }],
      };
    case 'link_closed':
      return { state: stopped(state), effects: [{ kind: 'abort_handlers' }] };
    case 'broker_cancelled':
      return { state, effects: [{ kind: 'abort_handlers' }] };
    case 'consumer_registered':
      // A registration that lands during the drain is cancelled; handlers keep acknowledging.
      return { state, effects: [{ kind: 'cancel_consumer' }] };
    case 'backoff_elapsed':
    case 'link_opened':
    case 'link_failed':
      return unchanged(state);
    default:
      return assertNever(event, 'consumer event');
  }
}
