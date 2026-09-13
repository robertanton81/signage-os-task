import { assertNever } from '@telemetry/shared';

/**
 * The state of the publisher (ingest spec, decisions 12–14, section "The publisher").
 *
 * `connecting` comes in two variants. Once a recycle trigger arrives during an attempt, the attempt
 * counts as failed and the state keeps that first trigger's reason, the root cause, for the backoff
 * line. The spec's table says the reason is kept; its type had only a `failed` flag, which cannot
 * carry it.
 */
export type PublisherState =
  | { name: 'connecting'; generation: number; attempt: number; blocked: boolean; failed: false }
  | {
      name: 'connecting';
      generation: number;
      attempt: number;
      blocked: boolean;
      failed: true;
      reason: string;
    }
  | { name: 'ready'; generation: number; attempt: number; blocked: boolean; readySince: number }
  | { name: 'recycling'; generation: number; attempt: number; reason: string }
  | { name: 'backoff'; generation: number; attempt: number; reason: string }
  | { name: 'stopped'; generation: number };

/** `trigger` is any recycle trigger of decision 12: a close, a nack, a return, a stall, a throw. */
export type PublisherEvent =
  | { type: 'backoff_elapsed'; generation: number }
  | { type: 'attempt_succeeded'; generation: number; now: number }
  | { type: 'attempt_failed'; generation: number; reason: string }
  | { type: 'trigger'; generation: number; reason: string; now: number }
  | { type: 'close_finished'; generation: number }
  | { type: 'blocked'; generation: number; reason: string }
  | { type: 'unblocked'; generation: number }
  | { type: 'stop' };

export type LogEffectLevel = 'debug' | 'info' | 'warn' | 'error';

export type Effect =
  | { type: 'start_attempt' }
  | { type: 'lose' }
  | { type: 'send_pending' }
  | { type: 'restart_stall_clock' }
  | { type: 'close_model' }
  | { type: 'start_backoff'; attempt: number; reason: string }
  | { type: 'log'; level: LogEffectLevel; message: string; fields: Record<string, unknown> };

export type Transition = { state: PublisherState; effects: Effect[] };

/** A connection ready for at least this long resets the backoff attempt (decision 13). */
export const BACKOFF_RESET_AFTER_MS = 10_000;

export const INITIAL_STATE: PublisherState = {
  name: 'backoff',
  generation: 0,
  attempt: 0,
  reason: 'start',
};

type Active = Exclude<PublisherState, { name: 'stopped' }>;
type Backoff = Extract<PublisherState, { name: 'backoff' }>;
type Connecting = Extract<PublisherState, { name: 'connecting' }>;
type Ready = Extract<PublisherState, { name: 'ready' }>;
type Recycling = Extract<PublisherState, { name: 'recycling' }>;
type Live = Exclude<PublisherEvent, { type: 'stop' }>;
type Trigger = Extract<PublisherEvent, { type: 'trigger' }>;

/** True only in `ready` without a block: the input of the reading rule (decision 17). */
export function isReady(state: PublisherState): boolean {
  return state.name === 'ready' && !state.blocked;
}

/**
 * Decision 15's guard: a confirm stall recycles only a `ready` connection that is not blocked and has
 * sent entries still waiting for their ack. A blocked connection's wait is suspended, and the stall
 * clock itself does not know the sent count, so the guard checks both.
 */
export function isConfirmStall({
  state,
  sentCount,
  stalled,
}: {
  state: PublisherState;
  sentCount: number;
  stalled: boolean;
}): boolean {
  return state.name === 'ready' && !state.blocked && sentCount > 0 && stalled;
}

/**
 * The next state and the effects the shell must run, in order. Pure. An event of another
 * generation, and a current-generation pair of state and event that has no row in the spec's
 * table, return the same state and no effects. Nothing changes a stopped publisher.
 */
export function transition(state: PublisherState, event: PublisherEvent): Transition {
  if (state.name === 'stopped') {
    return unchanged(state);
  }
  if (event.type === 'stop') {
    return stop(state);
  }
  if (event.generation !== state.generation) {
    return unchanged(state);
  }
  switch (state.name) {
    case 'backoff':
      return fromBackoff(state, event);
    case 'connecting':
      return fromConnecting(state, event);
    case 'ready':
      return fromReady(state, event);
    case 'recycling':
      return fromRecycling(state, event);
    default:
      return assertNever(state, 'publisher state');
  }
}

function unchanged(state: PublisherState): Transition {
  return { state, effects: [] };
}

function log(entry: {
  level: LogEffectLevel;
  message: string;
  fields: Record<string, unknown>;
}): Effect {
  return { type: 'log', ...entry };
}

function stop(state: Active): Transition {
  // A backoff has no model open; every other state may have one to close.
  const effects: Effect[] = state.name === 'backoff' ? [] : [{ type: 'close_model' }];
  effects.push(log({ level: 'info', message: 'publisher stopping', fields: { from: state.name } }));
  return { state: { name: 'stopped', generation: state.generation + 1 }, effects };
}

function ignoredTrigger(state: Backoff | Recycling, event: Trigger): Transition {
  return {
    state,
    effects: [
      log({
        level: 'debug',
        message: 'ignored a recycle trigger while not ready',
        fields: { reason: event.reason, state: state.name },
      }),
    ],
  };
}

function fromBackoff(state: Backoff, event: Live): Transition {
  switch (event.type) {
    case 'backoff_elapsed':
      return {
        state: {
          name: 'connecting',
          generation: state.generation + 1,
          attempt: state.attempt,
          blocked: false,
          failed: false,
        },
        // A new generation: whatever was sent on the old one is pending again (decision 12).
        effects: [{ type: 'lose' }, { type: 'start_attempt' }],
      };
    case 'trigger':
      return ignoredTrigger(state, event);
    case 'attempt_succeeded':
    case 'attempt_failed':
    case 'close_finished':
    case 'blocked':
    case 'unblocked':
      return unchanged(state);
    default:
      return assertNever(event, 'publisher event');
  }
}

function fromConnecting(state: Connecting, event: Live): Transition {
  switch (event.type) {
    case 'attempt_succeeded':
      if (state.failed) {
        // A trigger arrived during the attempt: the model it opened never serves as ready.
        return {
          state: {
            name: 'backoff',
            generation: state.generation,
            attempt: state.attempt + 1,
            reason: state.reason,
          },
          effects: [
            { type: 'close_model' },
            { type: 'start_backoff', attempt: state.attempt + 1, reason: state.reason },
          ],
        };
      }
      return {
        state: {
          name: 'ready',
          generation: state.generation,
          attempt: state.attempt,
          blocked: state.blocked,
          readySince: event.now,
        },
        effects: [
          { type: 'send_pending' },
          { type: 'restart_stall_clock' },
          log({
            level: 'info',
            message: 'publisher connected',
            fields: { generation: state.generation, attempt: state.attempt },
          }),
        ],
      };
    case 'attempt_failed': {
      // The first trigger's reason is the root cause; the attempt's own error is its consequence.
      const reason = state.failed ? state.reason : event.reason;
      const attempt = state.attempt + 1;
      return {
        state: { name: 'backoff', generation: state.generation, attempt, reason },
        effects: [{ type: 'start_backoff', attempt, reason }],
      };
    }
    case 'trigger': {
      const debug = log({
        level: 'debug',
        message: 'recycle trigger during a connect attempt',
        fields: { reason: event.reason },
      });
      if (state.failed) {
        return { state, effects: [debug] };
      }
      return {
        state: {
          name: 'connecting',
          generation: state.generation,
          attempt: state.attempt,
          blocked: state.blocked,
          failed: true,
          reason: event.reason,
        },
        effects: [debug],
      };
    }
    case 'blocked':
      return {
        state: { ...state, blocked: true },
        effects: [
          log({ level: 'warn', message: 'connection blocked', fields: { reason: event.reason } }),
        ],
      };
    case 'unblocked':
      return {
        state: { ...state, blocked: false },
        effects: [log({ level: 'info', message: 'connection unblocked', fields: {} })],
      };
    case 'backoff_elapsed':
    case 'close_finished':
      return unchanged(state);
    default:
      return assertNever(event, 'publisher event');
  }
}

function fromReady(state: Ready, event: Live): Transition {
  switch (event.type) {
    case 'trigger': {
      // Only a connection that stayed ready for the longest backoff resets the attempt.
      const attempt =
        event.now - state.readySince >= BACKOFF_RESET_AFTER_MS ? 0 : state.attempt + 1;
      return {
        state: {
          name: 'recycling',
          generation: state.generation + 1,
          attempt,
          reason: event.reason,
        },
        effects: [{ type: 'lose' }, { type: 'close_model' }],
      };
    }
    case 'blocked':
      if (state.blocked) {
        return unchanged(state);
      }
      return {
        state: { ...state, blocked: true },
        effects: [
          log({ level: 'warn', message: 'connection blocked', fields: { reason: event.reason } }),
        ],
      };
    case 'unblocked':
      if (!state.blocked) {
        return unchanged(state);
      }
      return {
        state: { ...state, blocked: false },
        effects: [
          { type: 'restart_stall_clock' },
          log({ level: 'info', message: 'connection unblocked', fields: {} }),
        ],
      };
    case 'backoff_elapsed':
    case 'attempt_succeeded':
    case 'attempt_failed':
    case 'close_finished':
      return unchanged(state);
    default:
      return assertNever(event, 'publisher event');
  }
}

function fromRecycling(state: Recycling, event: Live): Transition {
  switch (event.type) {
    case 'close_finished':
      // The only way out of recycling: every close path ends in this event.
      return {
        state: {
          name: 'backoff',
          generation: state.generation,
          attempt: state.attempt,
          reason: state.reason,
        },
        effects: [{ type: 'start_backoff', attempt: state.attempt, reason: state.reason }],
      };
    case 'trigger':
      return ignoredTrigger(state, event);
    case 'backoff_elapsed':
    case 'attempt_succeeded':
    case 'attempt_failed':
    case 'blocked':
    case 'unblocked':
      return unchanged(state);
    default:
      return assertNever(event, 'publisher event');
  }
}
