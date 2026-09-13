import { ConfigError } from '@telemetry/shared';
import { describe, expect, it } from 'vitest';

import { loadIngestConfig } from './config.js';

/** The only required variable; every case sets it. */
const required = { RABBITMQ_URL: 'amqp://localhost' };

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
      INGEST_SOCKET_IDLE_MS: 90_000,
    });
  });

  it.each(['0', '65536', '4000.5'])('rejects INGEST_PORT=%s, naming the variable', (value) => {
    expect(problemsOf(() => loadIngestConfig({ ...required, INGEST_PORT: value }))).toEqual([
      expect.stringMatching(/^INGEST_PORT: /),
    ]);
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

  it('compares the two ports with each other, not with a fixed number', () => {
    const moved = loadIngestConfig({ ...required, INGEST_PORT: '8080', HEALTH_PORT: '9090' });
    expect(moved.INGEST_PORT).toBe(8080);
    expect(
      problemsOf(() => loadIngestConfig({ ...required, INGEST_PORT: '9090', HEALTH_PORT: '9090' })),
    ).toEqual(['INGEST_PORT: must differ from HEALTH_PORT']);
  });

  it('names a missing RABBITMQ_URL', () => {
    expect(problemsOf(() => loadIngestConfig({}))).toEqual([
      expect.stringMatching(/^RABBITMQ_URL: /),
    ]);
  });

  it('parses the trimmed value', () => {
    expect(loadIngestConfig({ ...required, INGEST_PORT: ' 4001 ' }).INGEST_PORT).toBe(4001);
  });

  it.each(['INGEST_MAX_UNCONFIRMED', 'INGEST_MAX_UNCONFIRMED_TOTAL', 'INGEST_SOCKET_IDLE_MS'])(
    'rejects %s=0, naming the variable',
    (name) => {
      expect(problemsOf(() => loadIngestConfig({ ...required, [name]: '0' }))).toEqual([
        expect.stringMatching(new RegExp(`^${name}: `)),
      ]);
    },
  );
});
