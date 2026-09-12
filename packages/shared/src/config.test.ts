import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  ConfigError,
  envInt,
  loadConfig,
  logLevelEnv,
  mongodbEnv,
  rabbitmqEnv,
  shutdownEnv,
} from './config.js';

const schema = z.object({ ...logLevelEnv, ...shutdownEnv, ...rabbitmqEnv, ...mongodbEnv });
const required = { RABBITMQ_URL: 'amqp://rabbitmq:5672', MONGODB_URL: 'mongodb://mongodb:27017' };

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

describe('loadConfig', () => {
  // CLAUDE.md makes "no secrets in logs" a hard rule, and a ConfigError is the first thing a
  // service logs on a bad deploy. Every failure shape here is invalid but non-empty.
  it.each([
    { name: 'an unknown log level', env: { LOG_LEVEL: 'PLACEHOLDER_SECRET' } },
    { name: 'a non-numeric timeout', env: { MONGODB_TIMEOUT_MS: 'PLACEHOLDER_SECRET' } },
    { name: 'an unusable write concern', env: { MONGODB_WRITE_W: 'PLACEHOLDER_SECRET' } },
  ])('names the variable but never echoes its value for $name', ({ env }) => {
    const problems = problemsOf(() => loadConfig(schema, { ...required, ...env }));
    expect(problems.join(' ')).not.toContain('PLACEHOLDER_SECRET');
    expect(problems).toHaveLength(1);
  });

  // A service runs with hundreds of unrelated variables set. If the schema were ever made strict,
  // every one of them would be an unrecognised key and no service would start.
  it('ignores environment variables outside the schema instead of rejecting them', () => {
    expect(() =>
      loadConfig(schema, { ...required, PATH: '/usr/bin', npm_package_name: 'telemetry' }),
    ).not.toThrow();
  });

  it('reports a required variable set to only whitespace as missing', () => {
    const problems = problemsOf(() => loadConfig(schema, { ...required, RABBITMQ_URL: '   ' }));
    expect(problems).toEqual([expect.stringMatching(/^RABBITMQ_URL: /)]);
  });

  it('rejects a MONGODB_WRITE_W below the minimum of 1', () => {
    const problems = problemsOf(() => loadConfig(schema, { ...required, MONGODB_WRITE_W: '0' }));
    expect(problems).toEqual([expect.stringMatching(/^MONGODB_WRITE_W: /)]);
  });

  it('throws a ConfigError whose name survives error serialisation', () => {
    expect.assertions(2);
    try {
      loadConfig(schema, {});
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      expect((error as ConfigError).name).toBe('ConfigError');
    }
  });

  it('applies defaults to unset and empty variables', () => {
    const config = loadConfig(schema, { ...required, LOG_LEVEL: '', AMQP_HEARTBEAT_S: '' });
    expect(config).toEqual({
      LOG_LEVEL: 'info',
      SHUTDOWN_TIMEOUT_MS: 10_000,
      RABBITMQ_URL: required.RABBITMQ_URL,
      AMQP_HEARTBEAT_S: 10,
      MONGODB_URL: required.MONGODB_URL,
      MONGODB_DB: 'telemetry',
      MONGODB_WRITE_W: 1,
      MONGODB_TIMEOUT_MS: 5_000,
    });
  });

  it('treats a whitespace-only value as unset', () => {
    // Number(' ') is 0, which would pass SHUTDOWN_TIMEOUT_MS's min of 0 and leave a service with
    // no drain window at all instead of the documented default.
    const config = loadConfig(schema, { ...required, SHUTDOWN_TIMEOUT_MS: ' ', LOG_LEVEL: '  ' });
    expect(config.SHUTDOWN_TIMEOUT_MS).toBe(10_000);
    expect(config.LOG_LEVEL).toBe('info');
  });

  it('parses the trimmed value, so a trailing newline from a secret file never reaches a driver', () => {
    const config = loadConfig(schema, { ...required, RABBITMQ_URL: ' amqp://rabbitmq:5672\n' });
    expect(config.RABBITMQ_URL).toBe('amqp://rabbitmq:5672');
  });

  it('still honours an explicit zero rather than treating it as unset', () => {
    expect(loadConfig(schema, { ...required, SHUTDOWN_TIMEOUT_MS: '0' }).SHUTDOWN_TIMEOUT_MS).toBe(
      0,
    );
  });

  it('parses integers and the write concern from strings', () => {
    const config = loadConfig(schema, {
      ...required,
      LOG_LEVEL: 'debug',
      AMQP_HEARTBEAT_S: '20',
      MONGODB_WRITE_W: 'majority',
      MONGODB_TIMEOUT_MS: '250',
    });
    expect(config).toMatchObject({
      LOG_LEVEL: 'debug',
      AMQP_HEARTBEAT_S: 20,
      MONGODB_WRITE_W: 'majority',
      MONGODB_TIMEOUT_MS: 250,
    });
  });

  it('coerces a numeric MONGODB_WRITE_W from a string', () => {
    expect(loadConfig(schema, { ...required, MONGODB_WRITE_W: '2' }).MONGODB_WRITE_W).toBe(2);
  });

  it('names a missing required variable', () => {
    const problems = problemsOf(() => loadConfig(schema, { MONGODB_URL: required.MONGODB_URL }));
    expect(problems).toEqual([expect.stringMatching(/^RABBITMQ_URL: /)]);
    expect(() => loadConfig(schema, { MONGODB_URL: required.MONGODB_URL })).toThrow(/RABBITMQ_URL/);
  });

  it('rejects a non-numeric AMQP_HEARTBEAT_S', () => {
    expect(problemsOf(() => loadConfig(schema, { ...required, AMQP_HEARTBEAT_S: 'abc' }))).toEqual([
      expect.stringMatching(/^AMQP_HEARTBEAT_S: /),
    ]);
  });

  it('rejects an AMQP_HEARTBEAT_S below the minimum', () => {
    expect(problemsOf(() => loadConfig(schema, { ...required, AMQP_HEARTBEAT_S: '0' }))).toEqual([
      expect.stringMatching(/^AMQP_HEARTBEAT_S: /),
    ]);
  });

  it('rejects a MONGODB_WRITE_W that is neither "majority" nor a number', () => {
    expect(problemsOf(() => loadConfig(schema, { ...required, MONGODB_WRITE_W: 'abc' }))).toEqual([
      expect.stringMatching(/^MONGODB_WRITE_W: /),
    ]);
  });

  it('rejects an undeclared LOG_LEVEL value', () => {
    expect(problemsOf(() => loadConfig(schema, { ...required, LOG_LEVEL: 'loud' }))).toEqual([
      expect.stringMatching(/^LOG_LEVEL: /),
    ]);
  });

  it('reports every problem at once', () => {
    const problems = problemsOf(() => loadConfig(schema, { AMQP_HEARTBEAT_S: 'x' }));
    expect(problems).toHaveLength(3);
    expect(problems.join('\n')).toMatch(/RABBITMQ_URL/);
    expect(problems.join('\n')).toMatch(/MONGODB_URL/);
    expect(problems.join('\n')).toMatch(/AMQP_HEARTBEAT_S/);
  });
});

describe('envInt', () => {
  it('rejects a default below its own minimum when the schema is built', () => {
    expect(() => envInt(100, 50)).toThrow(/default 50 is below the minimum 100/);
  });

  it('accepts a default equal to its own minimum', () => {
    expect(() => envInt(5, 5)).not.toThrow();
  });

  const fragment = z.object({ N: envInt(2, 7) });

  it('applies the default when the variable is unset', () => {
    expect(loadConfig(fragment, {}).N).toBe(7);
  });

  it('accepts a value at the minimum', () => {
    expect(loadConfig(fragment, { N: '2' }).N).toBe(2);
  });

  it('rejects a value below the minimum', () => {
    expect(problemsOf(() => loadConfig(fragment, { N: '1' }))).toEqual([
      expect.stringMatching(/^N: /),
    ]);
  });

  it('rejects a non-integer value', () => {
    expect(problemsOf(() => loadConfig(fragment, { N: '2.5' }))).toEqual([
      expect.stringMatching(/^N: /),
    ]);
  });
});
