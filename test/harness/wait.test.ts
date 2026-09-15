import { messageIdentity, type OrderKey, type TelemetryEventType } from '@telemetry/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Expected } from './load.js';
import { LogCapture, byMsg, missingFromReadout, type EndStateReadout } from './wait.js';

const SESSION = 1_700_000_000_000;

function key(seq: number): OrderKey {
  return { sessionId: SESSION, seq };
}

function event(
  deviceId: string,
  seq: number,
): { deviceId: string; sessionId: number; seq: number } {
  return { deviceId, sessionId: SESSION, seq };
}

function identity(deviceId: string, seq: number): string {
  return messageIdentity(event(deviceId, seq));
}

/** Two devices: d-1 with a status and an error diagnostic (the alert), d-2 with one metrics message. */
function expectedFixture(): Expected {
  return {
    identities: new Set([identity('d-1', 1), identity('d-1', 2), identity('d-2', 1)]),
    sections: new Map<string, Map<TelemetryEventType, OrderKey>>([
      [
        'd-1',
        new Map<TelemetryEventType, OrderKey>([
          ['status', key(1)],
          ['diagnostic', key(2)],
        ]),
      ],
      ['d-2', new Map<TelemetryEventType, OrderKey>([['metrics', key(1)]])],
    ]),
    lastEvent: new Map([
      ['d-1', key(2)],
      ['d-2', key(1)],
    ]),
    duplicates: 0,
    alerts: new Set([identity('d-1', 2)]),
  };
}

function completeReadout(): EndStateReadout {
  return {
    events: [event('d-1', 1), event('d-1', 2), event('d-2', 1)],
    states: [
      { _id: 'd-1', status: key(1), diagnostic: key(2) },
      { _id: 'd-2', metrics: key(1) },
    ],
    alertIds: [identity('d-1', 2)],
  };
}

describe('missingFromReadout', () => {
  it('is empty when every identity, section key and alert is present', () => {
    expect(missingFromReadout(completeReadout(), expectedFixture())).toBe('');
  });

  it('counts an identity that was never stored', () => {
    const readout = { ...completeReadout(), events: [event('d-1', 1), event('d-2', 1)] };
    expect(missingFromReadout(readout, expectedFixture())).toBe(
      '1 identities missing, 0 sections not at their key, 0 alerts missing',
    );
  });

  it('counts a section below its key, one of another session, and one without a document', () => {
    const below: EndStateReadout = {
      ...completeReadout(),
      states: [
        { _id: 'd-1', status: key(1), diagnostic: key(1) },
        { _id: 'd-2', metrics: key(1) },
      ],
    };
    expect(missingFromReadout(below, expectedFixture())).toBe(
      '0 identities missing, 1 sections not at their key, 0 alerts missing',
    );
    const otherSession: EndStateReadout = {
      ...completeReadout(),
      states: [
        { _id: 'd-1', status: key(1), diagnostic: { sessionId: SESSION + 1, seq: 2 } },
        { _id: 'd-2', metrics: key(1) },
      ],
    };
    expect(missingFromReadout(otherSession, expectedFixture())).toBe(
      '0 identities missing, 1 sections not at their key, 0 alerts missing',
    );
    const noDocument: EndStateReadout = {
      ...completeReadout(),
      states: [{ _id: 'd-2', metrics: key(1) }],
    };
    expect(missingFromReadout(noDocument, expectedFixture())).toBe(
      '0 identities missing, 2 sections not at their key, 0 alerts missing',
    );
  });

  it('counts a missing alert', () => {
    const readout = { ...completeReadout(), alertIds: [] };
    expect(missingFromReadout(readout, expectedFixture())).toBe(
      '0 identities missing, 0 sections not at their key, 1 alerts missing',
    );
  });

  it('ignores stored data the expectation does not name', () => {
    const complete = completeReadout();
    const readout: EndStateReadout = {
      events: [...complete.events, event('d-3', 1)],
      states: [...complete.states, { _id: 'd-3', counters: key(1) }],
      alertIds: [...complete.alertIds, identity('d-3', 1)],
    };
    expect(missingFromReadout(readout, expectedFixture())).toBe('');
  });

  it('reports every count of an empty database', () => {
    expect(missingFromReadout({ events: [], states: [], alertIds: [] }, expectedFixture())).toBe(
      '3 identities missing, 3 sections not at their key, 1 alerts missing',
    );
  });
});

describe('LogCapture', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('keeps JSON lines and puts anything else into the diagnostics', () => {
    const capture = new LogCapture(new AbortController().signal);
    capture.pushText('{"level":30,"msg":"a"}\n');
    capture.pushText('   ');
    capture.pushText('not json');
    capture.destination().write('{"level":40,"msg":"b","reason":"x"}');
    expect(capture.messages()).toEqual(['a', 'b']);
    expect(capture.find(byMsg('b'))).toMatchObject({ level: 40, reason: 'x' });
    expect(capture.filter((line) => line.level >= 40)).toHaveLength(1);
    expect(capture.diagnostics()).toBe('[not JSON] not json\n');
    expect(capture.lines()).toEqual(capture.lines());
    expect(capture.lines()).not.toBe(capture.lines());
  });

  it('resolves at once on a line already captured', async () => {
    const capture = new LogCapture(new AbortController().signal);
    capture.push({ level: 30, msg: 'ready' });
    await expect(capture.waitForLine(byMsg('ready'))).resolves.toMatchObject({ msg: 'ready' });
  });

  it('resolves on the push that matches, not on an earlier one', async () => {
    const capture = new LogCapture(new AbortController().signal);
    const waiting = capture.waitForLine(byMsg('later'));
    capture.push({ level: 30, msg: 'other' });
    capture.push({ level: 30, msg: 'later', attempt: 2 });
    await expect(waiting).resolves.toMatchObject({ msg: 'later', attempt: 2 });
  });

  it('rejects with the last lines when the bound passes', async () => {
    vi.useFakeTimers();
    const capture = new LogCapture(new AbortController().signal);
    capture.push({ level: 30, msg: 'seen' });
    const waiting = capture.waitForLine(byMsg('never'), 1_000);
    const assertion = expect(waiting).rejects.toThrow(
      'log line not seen within 1000 ms; last lines: seen',
    );
    await vi.advanceTimersByTimeAsync(1_000);
    await assertion;
  });

  it('rejects at once when the signal aborts, and when it is aborted already', async () => {
    const controller = new AbortController();
    const capture = new LogCapture(controller.signal);
    capture.push({ level: 30, msg: 'seen' });
    const waiting = capture.waitForLine(byMsg('never'));
    const assertion = expect(waiting).rejects.toThrow('log wait aborted; last lines: seen');
    controller.abort();
    await assertion;
    await expect(capture.waitForLine(byMsg('never'))).rejects.toThrow('log wait aborted');
  });
});
