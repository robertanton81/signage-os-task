import { ConfigError } from '@telemetry/shared';
import { describe, expect, it } from 'vitest';

import { loadIngestConfig } from './config.js';

/** The only required variable; every case except the missing-URL one sets it. */
const required = { RABBITMQ_URL: 'amqp://localhost' };

const COUNTS = [
  'INGEST_MAX_UNCONFIRMED',
  'INGEST_MAX_UNCONFIRMED_TOTAL',
  'INGEST_PING_INTERVAL_MS',
  'INGEST_SOCKET_IDLE_MS',
] as const;

/** The variables that become a timer delay and are bounded by the limit Node timers accept. */
const TIMERS = ['INGEST_PING_INTERVAL_MS', 'INGEST_SOCKET_IDLE_MS'] as const;

function problemsOf(fn: () => unknown): string[] {
  try {
    fn();
  } catch (error) {
    if (error instanceof ConfigError) {
      return [...error.problems];
    }
    throw error;
  }
  throw new Error('expected a ConfigError');
}

/** The variable each `NAME: message` problem names. */
function namesIn(problems: readonly string[]): string[] {
  return problems.map((problem) => problem.slice(0, problem.indexOf(':')));
}

describe('loadIngestConfig', () => {
  it('applies the documented default to every optional variable', () => {
    expect(loadIngestConfig({ ...required })).toEqual({
      LOG_LEVEL: 'info',
      SHUTDOWN_TIMEOUT_MS: 10_000,
      RABBITMQ_URL: 'amqp://localhost',
      AMQP_HEARTBEAT_S: 10,
      HEALTH_PORT: 8080,
      INGEST_HOST: '0.0.0.0',
      INGEST_PORT: 4000,
      INGEST_MAX_UNCONFIRMED: 256,
      INGEST_MAX_UNCONFIRMED_TOTAL: 20_000,
      INGEST_PING_INTERVAL_MS: 30_000,
      INGEST_SOCKET_IDLE_MS: 90_000,
    });
  });

  it.each(['0', '65536', '4000.5'])('rejects INGEST_PORT=%s, naming the variable', (value) => {
    const problems = problemsOf(() => loadIngestConfig({ ...required, INGEST_PORT: value }));
    expect(namesIn(problems)).toEqual(['INGEST_PORT']);
  });

  it.each([
    { value: '1', port: 1 },
    { value: '65535', port: 65_535 },
  ])('accepts the boundary INGEST_PORT $value', ({ value, port }) => {
    expect(loadIngestConfig({ ...required, INGEST_PORT: value }).INGEST_PORT).toBe(port);
  });

  // Equal ports make the second `listen` fail with EADDRINUSE, which names a port, not a variable.
  it('rejects an INGEST_PORT equal to the default HEALTH_PORT, naming both variables', () => {
    expect(problemsOf(() => loadIngestConfig({ ...required, INGEST_PORT: '8080' }))).toEqual([
      'INGEST_PORT: must differ from HEALTH_PORT',
    ]);
  });

  it('accepts INGEST_PORT 8080 once HEALTH_PORT has moved away from it', () => {
    expect(
      loadIngestConfig({ ...required, INGEST_PORT: '8080', HEALTH_PORT: '9090' }),
    ).toMatchObject({ INGEST_PORT: 8080, HEALTH_PORT: 9090 });
  });

  it('rejects the ports once both point at the same moved value', () => {
    expect(
      problemsOf(() => loadIngestConfig({ ...required, INGEST_PORT: '9090', HEALTH_PORT: '9090' })),
    ).toEqual(['INGEST_PORT: must differ from HEALTH_PORT']);
  });

  it.each(['0', '70000'])(
    'reports two equal out-of-range ports (%s) as range errors only, not also as a clash',
    (value) => {
      const problems = problemsOf(() =>
        loadIngestConfig({ ...required, INGEST_PORT: value, HEALTH_PORT: value }),
      );
      expect(namesIn(problems).sort()).toEqual(['HEALTH_PORT', 'INGEST_PORT']);
    },
  );

  it.each([...TIMERS])(
    'rejects %s above the limit Node timers accept, naming the variable',
    (name) => {
      expect(
        namesIn(problemsOf(() => loadIngestConfig({ ...required, [name]: '2147483648' }))),
      ).toEqual([name]);
    },
  );

  it.each([...TIMERS])('accepts %s at the limit Node timers accept', (name) => {
    expect(loadIngestConfig({ ...required, [name]: '2147483647' })).toMatchObject({
      [name]: 2_147_483_647,
    });
  });

  it.each(['abc', '50.5', ''])(
    'reads INGEST_PING_INTERVAL_MS=%j as the default or a rejection',
    (value) => {
      if (value === '') {
        // An empty value counts as unset: the default applies (.env.example).
        expect(loadIngestConfig({ ...required, INGEST_PING_INTERVAL_MS: value })).toMatchObject({
          INGEST_PING_INTERVAL_MS: 30_000,
        });
      } else {
        expect(
          namesIn(
            problemsOf(() => loadIngestConfig({ ...required, INGEST_PING_INTERVAL_MS: value })),
          ),
        ).toEqual(['INGEST_PING_INTERVAL_MS']);
      }
    },
  );

  it('reads a short ping interval, as the tests set it', () => {
    expect(loadIngestConfig({ ...required, INGEST_PING_INTERVAL_MS: '50' })).toMatchObject({
      INGEST_PING_INTERVAL_MS: 50,
    });
  });

  it('names a missing RABBITMQ_URL', () => {
    expect(namesIn(problemsOf(() => loadIngestConfig({})))).toEqual(['RABBITMQ_URL']);
  });

  it('reads the environment through the shared loader, so a string value arrives trimmed', () => {
    // Coercion already trims a number, so only a string shows whether `loadConfig` ran: a direct
    // `ingestEnvSchema.parse(env)` would keep the spaces.
    expect(loadIngestConfig({ ...required, INGEST_HOST: ' 10.0.0.5 ' }).INGEST_HOST).toBe(
      '10.0.0.5',
    );
  });

  it.each([...COUNTS])('rejects %s=0, naming the variable', (name) => {
    expect(namesIn(problemsOf(() => loadIngestConfig({ ...required, [name]: '0' })))).toEqual([
      name,
    ]);
  });

  it.each([...COUNTS])('accepts %s=1, the documented minimum', (name) => {
    expect(loadIngestConfig({ ...required, [name]: '1' })).toMatchObject({ [name]: 1 });
  });
});
