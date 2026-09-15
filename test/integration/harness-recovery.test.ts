import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  bindEnvironment,
  createEnvironment,
  type Recover,
  type TestEnvironment,
} from '../harness/environment.js';
import { SERVICES, pause, raiseMemoryAlarm, servicesWithStatus, stop } from '../harness/stack.js';

let created: TestEnvironment | undefined;

beforeEach(async () => {
  created = await createEnvironment();
});

afterEach(async () => {
  const current = created;
  created = undefined;
  await current?.dispose();
});

const environment = (signal: AbortSignal): TestEnvironment => bindEnvironment(created, signal);

/**
 * `dispose()` runs inside the test body here, not in `afterEach`, so the test's own budget must
 * hold the recoveries' bound (50 s) and the in-flight settlement: the hook budget, 60 s.
 */
const DISPOSE_IN_BODY_TIMEOUT_MS = 60_000;

type StackState = { paused: string[]; running: string[]; alarms: number };

/** Both services running, nothing paused, no alarm: what every test here starts from and must leave. */
const WHOLE: StackState = { paused: [], running: [...SERVICES].sort(), alarms: 200 };

const paused = (env: TestEnvironment): Promise<string[]> =>
  servicesWithStatus('paused', { signal: env.signal });
const running = async (env: TestEnvironment): Promise<string[]> =>
  (await servicesWithStatus('running', { signal: env.signal })).sort();

async function stackState(env: TestEnvironment): Promise<StackState> {
  return {
    paused: await paused(env),
    running: await running(env),
    alarms: await env.management.alarms(),
  };
}

/**
 * A second environment in the role of the failing test: bound to a controller the test aborts
 * where a timeout would abort the test's own signal, and disposed by the test itself, as
 * `afterEach` would do. It holds one document, so "its database is gone" is a real observation.
 */
async function failingTest(): Promise<{ inner: TestEnvironment; abort: () => void }> {
  const inner = await createEnvironment();
  const controller = new AbortController();
  inner.bind(controller.signal);
  await inner.db.collection<{ _id: string }>('probe').insertOne({ _id: 'probe' });
  return { inner, abort: () => controller.abort() };
}

type Fault = {
  id: string;
  label: string;
  inject: (inner: TestEnvironment) => Promise<Recover>;
  /** The observation that proves the fault is in effect, and its expected reading. */
  observe: (env: TestEnvironment) => Promise<unknown>;
  inEffect: unknown;
};

const FAULTS: Fault[] = [
  {
    id: 'H1',
    label: 'RabbitMQ paused',
    inject: (inner) => pause(inner, 'rabbitmq'),
    observe: paused,
    inEffect: ['rabbitmq'],
  },
  {
    id: 'H2',
    label: 'MongoDB paused',
    inject: (inner) => pause(inner, 'mongodb'),
    observe: paused,
    inEffect: ['mongodb'],
  },
  {
    id: 'H3',
    label: 'MongoDB stopped',
    inject: (inner) => stop(inner, 'mongodb'),
    // A stopped container is neither `paused` nor `running`: its absence from `running` is the check.
    observe: running,
    inEffect: ['rabbitmq'],
  },
  {
    id: 'H4',
    label: 'the memory alarm raised',
    inject: (inner) => raiseMemoryAlarm(inner),
    observe: (env) => env.management.alarms(),
    inEffect: 503,
  },
];

describe('the harness: recovery after a failed test (integration spec, decision 12)', () => {
  // `it.for` passes each row whole as the first argument and the test context as the second, and
  // takes its options before the body (Vitest 4.1 API reference, `test.for`, read 2026-09-15).
  it.for(FAULTS)(
    '$id a test that times out with $label: dispose restores the stack and removes the vhost and the database',
    { timeout: DISPOSE_IN_BODY_TIMEOUT_MS },
    async ({ inject, observe, inEffect }, { signal }) => {
      const env = environment(signal);
      expect(await stackState(env)).toEqual(WHOLE);
      const { inner, abort } = await failingTest();
      try {
        expect(await env.leftoversOf(inner.name)).toEqual(['vhost', 'database']);
        await inject(inner);
        expect(await observe(env)).toEqual(inEffect);
        // The timeout: the failing test's signal aborts with the fault in effect and its
        // `recover()` never called.
        abort();
      } finally {
        // What `afterEach` does for a failed test: the subject here, and the cleanup should a step
        // above have failed.
        await inner.dispose();
      }
      expect(await stackState(env)).toEqual(WHOLE);
      expect(await env.leftoversOf(inner.name)).toEqual([]);
    },
  );

  it(
    'H5 a pause command killed by the timeout before it took effect: the recovery finds nothing to undo',
    async ({ signal }) => {
      const env = environment(signal);
      expect(await stackState(env)).toEqual(WHOLE);
      const { inner, abort } = await failingTest();
      try {
        // The abort in the same tick kills `docker compose pause` before it reaches the daemon (it
        // could, rarely, get through; then this is H1 again). Verified here: the aborted command
        // rejects, and the recovery registered before it (decision 12) checks the state first — an
        // unconditional `unpause` exits 1 on a running container (measured) and fails the disposal.
        // What a skipped recovery would leave behind is H1's and H6's concern, not this test's.
        const pausing = pause(inner, 'rabbitmq');
        abort();
        await expect(pausing).rejects.toThrow(/aborted/);
      } finally {
        await inner.dispose();
      }
      expect(await stackState(env)).toEqual(WHOLE);
      expect(await env.leftoversOf(inner.name)).toEqual([]);
    },
    DISPOSE_IN_BODY_TIMEOUT_MS,
  );

  it(
    'H6 a recovery cut off by the timeout is run again by dispose',
    async ({ signal }) => {
      const env = environment(signal);
      expect(await stackState(env)).toEqual(WHOLE);
      const { inner, abort } = await failingTest();
      try {
        const recover = await pause(inner, 'rabbitmq');
        // The timeout hits before the test's own `recover()`: the attempt starts under an aborted
        // signal, its first command is killed, and it rejects with the service still paused.
        abort();
        await expect(recover()).rejects.toThrow(/aborted/);
        expect(await paused(env)).toEqual(['rabbitmq']);
      } finally {
        await inner.dispose();
      }
      expect(await stackState(env)).toEqual(WHOLE);
      expect(await env.leftoversOf(inner.name)).toEqual([]);
    },
    DISPOSE_IN_BODY_TIMEOUT_MS,
  );

  it('H7 a recovery that keeps failing is reported by its step name, and every other step still runs', async ({
    signal,
  }) => {
    const env = environment(signal);
    const { inner } = await failingTest();
    inner.undo(() => Promise.reject(new Error('cannot undo')), 'the failing step');
    await expect(inner.dispose()).rejects.toThrow(
      /^dispose of it-[0-9a-f]{8}: the failing step: cannot undo$/,
    );
    expect(await env.leftoversOf(inner.name)).toEqual([]);
  });
});
