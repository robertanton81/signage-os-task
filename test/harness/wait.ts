import { setTimeout as sleep } from 'node:timers/promises';

import {
  ALERTS_COLLECTION,
  DEVICE_STATE_COLLECTION,
  EVENTS_COLLECTION,
  messageIdentity,
  type AlertDocument,
  type DeviceStateDocument,
  type EventDocument,
} from '@telemetry/shared';
import type { Db } from 'mongodb';

import type { Expected } from './load.js';

export type WaitOptions = {
  /** Default 20 s; the test's `testTimeout` is the outer bound. */
  timeoutMs?: number;
  /** Default 50 ms. */
  intervalMs?: number;
  /** The failure text: counts and state names, never a URL. */
  describe?: () => string;
};

export type BoundWaitOptions = WaitOptions & { signal: AbortSignal };

export type Truthy<T> = Exclude<T, false | 0 | '' | null | undefined>;

const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_INTERVAL_MS = 50;
const LOG_WAIT_TIMEOUT_MS = 20_000;

/**
 * Polls `predicate` until it resolves truthy and returns that value (integration spec, decision
 * 13: every wait is bounded, and the bound is the test's own). Rejects with `describe()`'s text
 * after `timeoutMs`, and at once when `signal` aborts, so a test that timed out stops polling. A
 * predicate that throws propagates: a reader that fails is a failure, not "not yet".
 */
export async function waitFor<T>(
  predicate: () => T | Promise<T>,
  {
    signal,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    intervalMs = DEFAULT_INTERVAL_MS,
    describe = () => 'condition not met',
  }: BoundWaitOptions,
): Promise<Truthy<T>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (signal.aborted) {
      throw new Error(`wait aborted: ${describe()}`);
    }
    const value = await predicate();
    if (value) {
      return value as Truthy<T>;
    }
    if (Date.now() >= deadline) {
      throw new Error(`wait timed out after ${String(timeoutMs)} ms: ${describe()}`);
    }
    try {
      await sleep(intervalMs, undefined, { signal });
    } catch {
      throw new Error(`wait aborted: ${describe()}`);
    }
  }
}

export type AckCounter = { stats(): { acked: number; inFlight: number } };

/** The completion signal of decision 13: every delivery the test made is acknowledged and no handler runs. */
export function awaitAcked(
  instance: AckCounter,
  options: BoundWaitOptions & { count: number },
): Promise<void> {
  const { count, ...wait } = options;
  return waitFor(
    () => {
      const { acked, inFlight } = instance.stats();
      return acked === count && inFlight === 0;
    },
    {
      ...wait,
      describe: () => {
        const { acked, inFlight } = instance.stats();
        return `acked ${String(acked)} of ${String(count)}, inFlight ${String(inFlight)}`;
      },
    },
  ).then(() => undefined);
}

/**
 * What the database still lacks of `expected`: every identity as an event document, every section
 * at its key, every alert present; '' when it holds everything. A state that cannot regress, so it
 * is a sound completion signal where a redelivery could add deliveries the test did not make (C10).
 */
export async function missingFromEndState(db: Db, expected: Expected): Promise<string> {
  const events = await db
    .collection<EventDocument>(EVENTS_COLLECTION)
    .find({}, { projection: { deviceId: 1, sessionId: 1, seq: 1 } })
    .toArray();
  const stored = new Set(events.map((event) => messageIdentity(event)));
  let identities = 0;
  for (const identity of expected.identities) {
    if (!stored.has(identity)) {
      identities += 1;
    }
  }
  const states = await db
    .collection<DeviceStateDocument>(DEVICE_STATE_COLLECTION)
    .find({})
    .toArray();
  const byDevice = new Map(states.map((state) => [state._id, state]));
  let sections = 0;
  for (const [deviceId, keys] of expected.sections) {
    const state = byDevice.get(deviceId);
    for (const [type, key] of keys) {
      const section = state?.[type];
      if (section === undefined || section.sessionId !== key.sessionId || section.seq !== key.seq) {
        sections += 1;
      }
    }
  }
  const alertDocuments = await db
    .collection<AlertDocument>(ALERTS_COLLECTION)
    .find({}, { projection: { _id: 1 } })
    .toArray();
  const alertIds = new Set(alertDocuments.map((alert) => alert._id));
  let alerts = 0;
  for (const identity of expected.alerts) {
    if (!alertIds.has(identity)) {
      alerts += 1;
    }
  }
  if (identities === 0 && sections === 0 && alerts === 0) {
    return '';
  }
  return `${String(identities)} identities missing, ${String(sections)} sections not at their key, ${String(alerts)} alerts missing`;
}

export function awaitEndState({
  db,
  expected,
  signal,
  timeoutMs,
}: {
  db: Db;
  expected: Expected;
  signal: AbortSignal;
  timeoutMs?: number;
}): Promise<void> {
  let last = 'not read yet';
  return waitFor(
    async () => {
      last = await missingFromEndState(db, expected);
      return last === '';
    },
    {
      signal,
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
      describe: () => `end state incomplete: ${last}`,
    },
  ).then(() => undefined);
}

export type LogLine = { level: number; msg: string; [field: string]: unknown };
export type LineMatch = (line: LogLine) => boolean;

/** pino's numeric levels, as the captured lines carry them in `level`. */
export const WARN_LEVEL = 40;
export const ERROR_LEVEL = 50;

export const byMsg =
  (msg: string): LineMatch =>
  (line) =>
    line.msg === msg;

/**
 * The parsed JSON lines of one service (decision 19), fed by a pino destination or a child's
 * stdout. `waitForLine` resolves on the push that matches — no polling — and rejects at once when
 * the test's signal aborts, so no wait outlives its test.
 */
export class LogCapture {
  readonly #lines: LogLine[] = [];
  readonly #listeners = new Set<() => void>();
  readonly #signal: AbortSignal;
  #diagnostics = '';

  constructor(signal: AbortSignal) {
    this.#signal = signal;
  }

  /** A pino destination: every line the logger writes lands here, synchronously. */
  destination(): { write(line: string): void } {
    return {
      write: (line) => {
        this.pushText(line);
      },
    };
  }

  /** One raw line: JSON goes into `lines`, anything else into `diagnostics`. */
  pushText(raw: string): void {
    const text = raw.trim();
    if (text === '') {
      return;
    }
    try {
      this.push(JSON.parse(text) as LogLine);
    } catch {
      this.#diagnostics += `[not JSON] ${text}\n`;
    }
  }

  push(line: LogLine): void {
    this.#lines.push(line);
    for (const listener of [...this.#listeners]) {
      listener();
    }
  }

  lines(): LogLine[] {
    return [...this.#lines];
  }

  find(match: LineMatch): LogLine | undefined {
    return this.#lines.find(match);
  }

  filter(match: LineMatch): LogLine[] {
    return this.#lines.filter(match);
  }

  /** The `msg` of every line, in order: for order assertions and failure texts. */
  messages(): string[] {
    return this.#lines.map((line) => line.msg);
  }

  diagnostics(): string {
    return this.#diagnostics;
  }

  waitForLine(match: LineMatch, timeoutMs = LOG_WAIT_TIMEOUT_MS): Promise<LogLine> {
    return new Promise((resolve, reject) => {
      const found = this.#lines.find(match);
      if (found !== undefined) {
        resolve(found);
        return;
      }
      if (this.#signal.aborted) {
        reject(new Error(`log wait aborted; last lines: ${this.#tail()}`));
        return;
      }
      const finish = (): void => {
        this.#listeners.delete(check);
        clearTimeout(timer);
        this.#signal.removeEventListener('abort', onAbort);
      };
      const check = (): void => {
        const line = this.#lines.find(match);
        if (line !== undefined) {
          finish();
          resolve(line);
        }
      };
      const onAbort = (): void => {
        finish();
        reject(new Error(`log wait aborted; last lines: ${this.#tail()}`));
      };
      const timer = setTimeout(() => {
        finish();
        reject(
          new Error(
            `log line not seen within ${String(timeoutMs)} ms; last lines: ${this.#tail()}`,
          ),
        );
      }, timeoutMs);
      this.#listeners.add(check);
      this.#signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  #tail(): string {
    return this.#lines
      .slice(-8)
      .map((line) => line.msg)
      .join(' | ');
  }
}
