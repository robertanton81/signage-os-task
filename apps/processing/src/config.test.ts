import { ConfigError } from '@telemetry/shared';
import { describe, expect, it } from 'vitest';

import { loadProcessingConfig } from './config.js';

/** Both connection strings are required, so every case sets them. */
const REQUIRED = { RABBITMQ_URL: 'amqp://localhost', MONGODB_URL: 'mongodb://localhost' };

function problemsOf(env: Record<string, string>): string[] {
  try {
    loadProcessingConfig(env);
  } catch (error) {
    if (error instanceof ConfigError) {
      return [...error.problems];
    }
    throw error;
  }
  throw new Error('expected a ConfigError');
}

describe('loadProcessingConfig', () => {
  it('applies the documented default to every optional variable', () => {
    expect(loadProcessingConfig(REQUIRED)).toEqual({
      ...REQUIRED,
      LOG_LEVEL: 'info',
      SHUTDOWN_TIMEOUT_MS: 10_000,
      AMQP_HEARTBEAT_S: 10,
      HEALTH_PORT: 8080,
      MONGODB_DB: 'telemetry',
      MONGODB_WRITE_W: 1,
      MONGODB_TIMEOUT_MS: 5_000,
      PROCESSING_PREFETCH: 50,
      PROCESSING_TRANSIENT_ATTEMPTS: 5,
    });
  });

  it('names a missing RABBITMQ_URL', () => {
    expect(problemsOf({ MONGODB_URL: REQUIRED.MONGODB_URL })).toEqual([
      expect.stringMatching(/^RABBITMQ_URL: /),
    ]);
  });

  it('names a missing MONGODB_URL and never echoes the value of another variable', () => {
    const problems = problemsOf({ RABBITMQ_URL: REQUIRED.RABBITMQ_URL });

    expect(problems).toEqual([expect.stringMatching(/^MONGODB_URL: /)]);
    expect(problems.join(' ')).not.toContain(REQUIRED.RABBITMQ_URL);
  });

  it.each(['0', '2001'])('rejects PROCESSING_PREFETCH=%s naming the variable', (value) => {
    expect(problemsOf({ ...REQUIRED, PROCESSING_PREFETCH: value })).toEqual([
      expect.stringMatching(/^PROCESSING_PREFETCH: /),
    ]);
  });

  it.each([
    ['1', 1],
    ['2000', 2000],
  ])('accepts PROCESSING_PREFETCH=%s, a bound of the quorum-queue range', (value, expected) => {
    expect(
      loadProcessingConfig({ ...REQUIRED, PROCESSING_PREFETCH: value }).PROCESSING_PREFETCH,
    ).toBe(expected);
  });

  it('rejects PROCESSING_TRANSIENT_ATTEMPTS=0 naming the variable and accepts 1', () => {
    expect(problemsOf({ ...REQUIRED, PROCESSING_TRANSIENT_ATTEMPTS: '0' })).toEqual([
      expect.stringMatching(/^PROCESSING_TRANSIENT_ATTEMPTS: /),
    ]);
    expect(
      loadProcessingConfig({ ...REQUIRED, PROCESSING_TRANSIENT_ATTEMPTS: '1' })
        .PROCESSING_TRANSIENT_ATTEMPTS,
    ).toBe(1);
  });

  it('reads MONGODB_WRITE_W as the string majority or as a number', () => {
    expect(loadProcessingConfig({ ...REQUIRED, MONGODB_WRITE_W: 'majority' }).MONGODB_WRITE_W).toBe(
      'majority',
    );
    expect(loadProcessingConfig({ ...REQUIRED, MONGODB_WRITE_W: '3' }).MONGODB_WRITE_W).toBe(3);
  });

  it('trims values before parsing them', () => {
    expect(
      loadProcessingConfig({ ...REQUIRED, PROCESSING_PREFETCH: ' 7 ' }).PROCESSING_PREFETCH,
    ).toBe(7);
  });
});
