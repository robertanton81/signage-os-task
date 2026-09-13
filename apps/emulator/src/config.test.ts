import { ConfigError, DEVICE_ID_MAX_LENGTH } from '@telemetry/shared';
import { describe, expect, it } from 'vitest';

import { formatDeviceId, loadEmulatorConfig, parseIngestHosts } from './config.js';

/** `loadConfig` reads whatever object it is given, so a test never touches process.env. */
function load(env: Record<string, string>) {
  return loadEmulatorConfig(env);
}

describe('loadEmulatorConfig defaults', () => {
  it('applies every documented default to an empty environment', () => {
    expect(load({})).toEqual({
      LOG_LEVEL: 'info',
      SHUTDOWN_TIMEOUT_MS: 10_000,
      EMULATOR_DEVICE_COUNT: 10,
      EMULATOR_DEVICE_ID_PREFIX: 'dev',
      EMULATOR_EVENT_INTERVAL_MS: 1_000,
      EMULATOR_HEARTBEAT_MS: 30_000,
      EMULATOR_OUTBOX_MAX: 1_000,
      EMULATOR_SEED: 1,
      EMULATOR_CHAOS: [],
      EMULATOR_CHAOS_PERCENT: 5,
      EMULATOR_CHAOS_INTERVAL_MS: 60_000,
      INGEST_HOSTS: [{ host: 'ingest', port: 4_000 }],
    });
  });

  it('treats a whitespace-only value as unset', () => {
    expect(load({ EMULATOR_DEVICE_COUNT: '   ' }).EMULATOR_DEVICE_COUNT).toBe(10);
  });
});

describe('device id cross-check', () => {
  it('formats ids zero-padded to four digits', () => {
    expect(formatDeviceId('dev', 1)).toBe('dev-0001');
    expect(formatDeviceId('dev', 12_345)).toBe('dev-12345');
  });

  it('rejects a prefix that would overflow the contract at the configured count', () => {
    const prefix = 'p'.repeat(DEVICE_ID_MAX_LENGTH - 4);
    expect(() => load({ EMULATOR_DEVICE_ID_PREFIX: prefix, EMULATOR_DEVICE_COUNT: '10' })).toThrow(
      ConfigError,
    );
    try {
      load({ EMULATOR_DEVICE_ID_PREFIX: prefix, EMULATOR_DEVICE_COUNT: '10' });
      expect.unreachable('expected a ConfigError');
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      expect((error as ConfigError).problems.join('; ')).toContain('EMULATOR_DEVICE_ID_PREFIX');
    }
  });

  it('accepts a prefix that still fits the longest generated id', () => {
    const prefix = 'p'.repeat(DEVICE_ID_MAX_LENGTH - 10);
    expect(() =>
      load({ EMULATOR_DEVICE_ID_PREFIX: prefix, EMULATOR_DEVICE_COUNT: '10' }),
    ).not.toThrow();
  });

  it('rejects a prefix containing a character the contract forbids', () => {
    expect(() => load({ EMULATOR_DEVICE_ID_PREFIX: 'my-dev' })).toThrow(ConfigError);
    expect(() => load({ EMULATOR_DEVICE_ID_PREFIX: 'my dev' })).toThrow(ConfigError);
  });
});

describe('parseIngestHosts', () => {
  it('trims each entry, not only the whole string', () => {
    expect(parseIngestHosts(' a:1 , b:2 ')).toEqual({
      ok: true,
      value: [
        { host: 'a', port: 1 },
        { host: 'b', port: 2 },
      ],
    });
  });

  it('strips the brackets from an IPv6 literal', () => {
    expect(parseIngestHosts('[::1]:4000')).toEqual({
      ok: true,
      value: [{ host: '::1', port: 4_000 }],
    });
  });

  it('rejects a port outside 1-65535', () => {
    expect(parseIngestHosts('a:0').ok).toBe(false);
    expect(parseIngestHosts('a:65536').ok).toBe(false);
    expect(parseIngestHosts('a:65535').ok).toBe(true);
  });

  it('rejects an entry that is not host:port', () => {
    expect(parseIngestHosts('nohost').ok).toBe(false);
    expect(parseIngestHosts('a:b').ok).toBe(false);
  });

  it('rejects an empty list, which would leave a device with nowhere to connect', () => {
    expect(parseIngestHosts('  ,  ').ok).toBe(false);
  });
});

describe('invalid configuration surfaces as ConfigError naming the variable', () => {
  const cases: Array<[string, Record<string, string>]> = [
    ['INGEST_HOSTS', { INGEST_HOSTS: 'a:0' }],
    ['EMULATOR_CHAOS', { EMULATOR_CHAOS: 'out_of_order' }],
    ['EMULATOR_CHAOS_PERCENT', { EMULATOR_CHAOS_PERCENT: '101' }],
    ['EMULATOR_DEVICE_COUNT', { EMULATOR_DEVICE_COUNT: '0' }],
    ['EMULATOR_SEED', { EMULATOR_SEED: 'abc' }],
    // One millisecond above what a Node timer holds: the interval would fire after 1 ms instead.
    ['EMULATOR_EVENT_INTERVAL_MS', { EMULATOR_EVENT_INTERVAL_MS: '2147483648' }],
    ['EMULATOR_HEARTBEAT_MS', { EMULATOR_HEARTBEAT_MS: '2147483648' }],
    // The chaos delay is drawn up to 1.5× the interval, so the bound is the limit divided by 1.5.
    ['EMULATOR_CHAOS_INTERVAL_MS', { EMULATOR_CHAOS_INTERVAL_MS: '1431655765' }],
  ];

  for (const [variable, env] of cases) {
    it(`names ${variable}`, () => {
      // The type matters, not just that it threw: a raw Error escaping a zod transform would
      // also satisfy a bare toThrow(), and that is precisely the bug this shape avoids.
      try {
        load(env);
        expect.unreachable(`expected ${variable} to fail`);
      } catch (error) {
        expect(error).toBeInstanceOf(ConfigError);
        expect((error as ConfigError).problems.join('; ')).toContain(variable);
      }
    });
  }

  it('accepts the boundary values', () => {
    expect(load({ EMULATOR_CHAOS_PERCENT: '100' }).EMULATOR_CHAOS_PERCENT).toBe(100);
    expect(load({ EMULATOR_CHAOS_PERCENT: '0' }).EMULATOR_CHAOS_PERCENT).toBe(0);
  });

  it('never repeats the rejected value in the error', () => {
    const secret = 'zzz_not_a_mode_zzz';
    try {
      load({ EMULATOR_CHAOS: secret });
      expect.unreachable('expected a ConfigError');
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      expect((error as ConfigError).message).not.toContain(secret);
    }
  });

  it('parses a valid chaos list', () => {
    expect(load({ EMULATOR_CHAOS: 'duplicate, restart' }).EMULATOR_CHAOS).toEqual([
      'duplicate',
      'restart',
    ]);
  });
});

describe('timer bounds', () => {
  it('accepts the largest chaos interval whose 1.5× spread still fits a timer', () => {
    expect(load({ EMULATOR_CHAOS_INTERVAL_MS: '1431655764' }).EMULATOR_CHAOS_INTERVAL_MS).toBe(
      1_431_655_764,
    );
  });

  it('accepts the largest event interval a timer can hold', () => {
    expect(load({ EMULATOR_EVENT_INTERVAL_MS: '2147483647' }).EMULATOR_EVENT_INTERVAL_MS).toBe(
      2_147_483_647,
    );
  });
});
