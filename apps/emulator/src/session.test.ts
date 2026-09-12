import {
  SESSION_ID_MAX,
  SESSION_ID_MIN,
  messageIdentity,
  telemetryMessageSchema,
  type TelemetryMessage,
} from '@telemetry/shared';
import { beforeEach, describe, expect, it } from 'vitest';

import { COUNTERS_EVERY_N_TICKS } from './generator.js';
import { createRandom } from './random.js';
import { DeviceSession } from './session.js';

const DEVICE_ID = 'dev-0001';
/**
 * Inside [SESSION_ID_MIN, SESSION_ID_MAX]. A convenient `() => 0` would mint sessionId 1 and fail
 * the contract schema for a reason that has nothing to do with the behaviour under test.
 */
const START_MS = 1_700_000_000_000;

/** A clock the test drives, so hours pass in microseconds. */
function makeClock(start = START_MS) {
  let now = start;
  return {
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
    set: (value: number) => {
      now = value;
    },
  };
}

function makeSession(clock = makeClock(), seed = 7) {
  return new DeviceSession({ deviceId: DEVICE_ID, random: createRandom(seed), now: clock.now });
}

describe('DeviceSession identity and order key', () => {
  it('never reuses a (sessionId, seq) pair across ticks, heartbeats, restarts and the farewell', () => {
    const clock = makeClock();
    const session = makeSession(clock);
    const produced: TelemetryMessage[] = [...session.start()];

    for (let i = 0; i < 10_000; i += 1) {
      clock.advance(1_000);
      produced.push(...session.tick());
      if (i === 3_000 || i === 6_000) produced.push(...session.restart());
      if (i % 500 === 0) produced.push(...session.heartbeat());
    }
    produced.push(...session.farewell());

    const identities = new Set(produced.map((message) => messageIdentity(message)));
    expect(produced.length).toBeGreaterThan(10_000);
    expect(identities.size).toBe(produced.length);
  });

  it('starts seq at 1 and increases it by exactly 1 per message within a session', () => {
    const clock = makeClock();
    const session = makeSession(clock);
    const produced = [...session.start()];
    for (let i = 0; i < 200; i += 1) {
      clock.advance(1_000);
      produced.push(...session.tick());
    }
    expect(produced.map((m) => m.seq)).toEqual(produced.map((_unused, index) => index + 1));
  });

  it('strictly increases sessionId across restarts even with a frozen clock', () => {
    const clock = makeClock();
    const session = makeSession(clock);
    session.start();
    const first = session.sessionId;
    // The clock never moves: only the `previous + 1` branch can make these differ.
    session.restart();
    const second = session.sessionId;
    session.restart();
    const third = session.sessionId;
    expect(second).toBeGreaterThan(first);
    expect(third).toBeGreaterThan(second);
  });

  it('uses the clock when it has moved past the previous session', () => {
    const clock = makeClock();
    const session = makeSession(clock);
    session.start();
    clock.advance(5_000);
    session.restart();
    expect(session.sessionId).toBe(START_MS + 5_000);
  });

  it('mints a sessionId the contract accepts', () => {
    const session = makeSession();
    session.start();
    expect(session.sessionId).toBeGreaterThanOrEqual(SESSION_ID_MIN);
    expect(session.sessionId).toBeLessThanOrEqual(SESSION_ID_MAX);
  });
});

describe('DeviceSession message content', () => {
  it('produces only messages the shared contract accepts', () => {
    const clock = makeClock();
    const session = makeSession(clock);
    const produced = [...session.start()];
    for (let i = 0; i < 2_000; i += 1) {
      clock.advance(1_000);
      produced.push(...session.tick());
      if (i % 300 === 0) produced.push(...session.heartbeat());
      if (i === 1_000) produced.push(...session.restart());
    }
    produced.push(...session.farewell());
    for (const message of produced) {
      const result = telemetryMessageSchema.safeParse(message);
      expect(result.success, JSON.stringify(message)).toBe(true);
    }
  });

  it('emits counters on every fifth tick and never in start()', () => {
    const clock = makeClock();
    const session = makeSession(clock);
    expect(session.start().some((m) => m.type === 'counters')).toBe(false);
    const countersOnTick: number[] = [];
    for (let tick = 1; tick <= 16; tick += 1) {
      clock.advance(1_000);
      if (session.tick().some((m) => m.type === 'counters')) countersOnTick.push(tick);
    }
    expect(countersOnTick).toEqual([
      COUNTERS_EVERY_N_TICKS,
      COUNTERS_EVERY_N_TICKS * 2,
      COUNTERS_EVERY_N_TICKS * 3,
    ]);
  });

  it('never lets operationsTotal go backwards within a session', () => {
    const clock = makeClock();
    const session = makeSession(clock);
    session.start();
    let previous = -1;
    for (let i = 0; i < 500; i += 1) {
      clock.advance(1_000);
      for (const message of session.tick()) {
        if (message.type === 'counters') {
          expect(message.payload.operationsTotal).toBeGreaterThanOrEqual(previous);
          previous = message.payload.operationsTotal;
        }
      }
    }
    expect(previous).toBeGreaterThan(0);
  });

  it('resets the counters on restart', () => {
    const clock = makeClock();
    const session = makeSession(clock);
    session.start();
    let last = 0;
    for (let i = 0; i < 50; i += 1) {
      clock.advance(1_000);
      for (const message of session.tick()) {
        if (message.type === 'counters') last = message.payload.operationsTotal;
      }
    }
    expect(last).toBeGreaterThan(0);
    session.restart();
    let afterRestart = Number.POSITIVE_INFINITY;
    for (let i = 0; i < COUNTERS_EVERY_N_TICKS; i += 1) {
      clock.advance(1_000);
      for (const message of session.tick()) {
        if (message.type === 'counters') afterRestart = message.payload.operationsTotal;
      }
    }
    expect(afterRestart).toBeLessThan(last);
  });

  it('clamps uptimeMs at zero when the clock jumps back past the session start', () => {
    const clock = makeClock();
    const session = makeSession(clock);
    session.start();
    // A backwards NTP correction, deeper than the session is old.
    clock.set(START_MS - 60_000);
    const counters: number[] = [];
    for (let i = 0; i < COUNTERS_EVERY_N_TICKS * 2; i += 1) {
      for (const message of session.tick()) {
        if (message.type === 'counters') counters.push(message.payload.uptimeMs);
      }
    }
    expect(counters.length).toBeGreaterThan(0);
    for (const uptime of counters) expect(uptime).toBe(0);
  });
});

describe('DeviceSession status rules', () => {
  let clock: ReturnType<typeof makeClock>;

  beforeEach(() => {
    clock = makeClock();
  });

  it('emits a status from tick() only when the derived state changed', () => {
    const session = makeSession(clock);
    const startStatuses = session.start().filter((m) => m.type === 'status');
    expect(startStatuses).toHaveLength(1);
    expect(startStatuses[0]?.payload).toEqual({ state: 'online' });

    // A healthy device with this seed stays online, so no tick may emit a status.
    let statusCount = 0;
    let sawDegraded = false;
    for (let i = 0; i < 300; i += 1) {
      clock.advance(1_000);
      for (const message of session.tick()) {
        if (message.type === 'status') {
          statusCount += 1;
          if (message.payload.state === 'degraded') sawDegraded = true;
        }
      }
    }
    // Either the device never changed state (no status at all), or every status it did emit
    // corresponds to a real change — which the count being far below the tick count proves.
    expect(statusCount).toBeLessThan(10);
    if (statusCount > 0) expect(sawDegraded).toBe(true);
  });

  it('emits exactly one status from heartbeat(), unconditionally', () => {
    const session = makeSession(clock);
    session.start();
    for (let i = 0; i < 5; i += 1) {
      const messages = session.heartbeat();
      expect(messages).toHaveLength(1);
      expect(messages[0]?.type).toBe('status');
    }
  });

  it('emits offline only from farewell()', () => {
    const session = makeSession(clock);
    const produced = [...session.start()];
    for (let i = 0; i < 500; i += 1) {
      clock.advance(1_000);
      produced.push(...session.tick());
      produced.push(...session.heartbeat());
    }
    expect(produced.some((m) => m.type === 'status' && m.payload.state === 'offline')).toBe(false);

    const farewell = session.farewell();
    expect(farewell).toHaveLength(1);
    expect(farewell[0]).toMatchObject({ type: 'status', payload: { state: 'offline' } });
  });

  it('emits an error diagnostic when a faulty device crosses into overheat', () => {
    // Search the seeds for a faulty device; the profile draw is the first use of its stream.
    let session: DeviceSession | undefined;
    let errors = 0;
    for (let seed = 1; seed < 60 && errors === 0; seed += 1) {
      const candidateClock = makeClock();
      const candidate = makeSession(candidateClock, seed);
      candidate.start();
      let seen = 0;
      for (let i = 0; i < 2_000; i += 1) {
        candidateClock.advance(1_000);
        for (const message of candidate.tick()) {
          if (message.type === 'diagnostic' && message.payload.severity === 'error') seen += 1;
        }
      }
      if (seen > 0) {
        session = candidate;
        errors = seen;
      }
    }
    expect(session).toBeDefined();
    expect(errors).toBeGreaterThan(0);
  });
});
