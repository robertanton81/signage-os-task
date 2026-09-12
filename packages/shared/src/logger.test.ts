import { describe, expect, it } from 'vitest';

import {
  LOG_LEVELS,
  createLogger,
  messageLogger,
  redactUserinfo,
  rejectedMessageLogger,
} from './logger.js';

function capture(): { lines: string[]; write(msg: string): void } {
  const lines: string[] = [];
  return {
    lines,
    write(msg: string) {
      lines.push(msg);
    },
  };
}

function parseLine(line: string | undefined): Record<string, unknown> {
  return JSON.parse(line ?? '{}') as Record<string, unknown>;
}

describe('createLogger', () => {
  it('writes one JSON line with service, hostname, ISO time, level and message', () => {
    const destination = capture();
    const logger = createLogger({ service: 'ingest', level: 'info', destination });
    logger.info({ outcome: 'applied' }, 'stored');
    expect(destination.lines).toHaveLength(1);
    const line = parseLine(destination.lines[0]);
    expect(line).toMatchObject({
      level: 30,
      service: 'ingest',
      msg: 'stored',
      outcome: 'applied',
    });
    expect(typeof line['hostname']).toBe('string');
    expect(line['time']).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(line).not.toHaveProperty('pid');
  });

  it('drops lines below the configured level', () => {
    const destination = capture();
    const logger = createLogger({ service: 'test', level: 'warn', destination });
    logger.info('hidden');
    logger.debug('hidden');
    logger.warn('shown');
    expect(destination.lines).toHaveLength(1);
    expect(parseLine(destination.lines[0])).toMatchObject({ level: 40, msg: 'shown' });
  });

  it('writes nothing when silent', () => {
    const destination = capture();
    const logger = createLogger({ service: 'test', level: 'silent', destination });
    logger.error('hidden');
    logger.fatal('hidden');
    expect(destination.lines).toHaveLength(0);
  });

  it.each(LOG_LEVELS)('accepts %s as a level and reports what it enables', (level) => {
    const logger = createLogger({ service: 'test', level, destination: capture() });
    expect(logger.level).toBe(level);
    // `silent` enables nothing; every other level enables at least `fatal`.
    expect(logger.isLevelEnabled('fatal')).toBe(level !== 'silent');
  });
});

describe('redactUserinfo', () => {
  it('replaces the userinfo of every URL and keeps the rest of the text', () => {
    expect(
      redactUserinfo(
        'connect ECONNREFUSED amqp://user:p%40ss@rabbitmq:5672/vhost and mongodb+srv://u:p@a.example,b.example/db?x=1',
      ),
    ).toBe(
      'connect ECONNREFUSED amqp://[redacted]@rabbitmq:5672/vhost and mongodb+srv://[redacted]@a.example,b.example/db?x=1',
    );
  });

  it('leaves a URL without userinfo unchanged', () => {
    expect(redactUserinfo('amqp://rabbitmq:5672 mongodb://mongodb:27017/telemetry')).toBe(
      'amqp://rabbitmq:5672 mongodb://mongodb:27017/telemetry',
    );
  });
});

describe('createLogger password redaction beyond the canonical keys', () => {
  // amqplib and the MongoDB driver embed the connection string in their error messages, so this
  // is the first thing every service will log against a broker or database that is down.
  const secret = 'SECRETPASS';
  const url = `amqp://user:${secret}@rabbitmq:5672`;

  function lines(log: (logger: ReturnType<typeof createLogger>) => void): string[] {
    const destination = capture();
    log(createLogger({ service: 'ingest', level: 'info', destination }));
    return destination.lines;
  }

  it.each([
    {
      name: 'a bare error',
      log: (l: ReturnType<typeof createLogger>) =>
        l.error(new Error(`connect ECONNREFUSED ${url}`)),
    },
    {
      name: 'an error under err without a message',
      log: (l: ReturnType<typeof createLogger>) => l.error({ err: new Error(`connect ${url}`) }),
    },
    {
      name: 'an error under err with a message',
      log: (l: ReturnType<typeof createLogger>) =>
        l.error({ err: new Error(`connect ${url}`) }, 'connect failed'),
    },
    {
      name: 'a string message',
      log: (l: ReturnType<typeof createLogger>) => l.warn(`retrying ${url}`),
    },
    {
      name: 'a format argument',
      log: (l: ReturnType<typeof createLogger>) => l.warn('retrying %s', url),
    },
    {
      name: 'a string under a non-canonical key',
      log: (l: ReturnType<typeof createLogger>) => l.info({ target: url }, 'connecting'),
    },
    {
      name: 'a nested string under a non-canonical key',
      log: (l: ReturnType<typeof createLogger>) => l.info({ amqp: { url } }, 'connecting'),
    },
    {
      name: 'an error logged through a message child logger',
      log: (l: ReturnType<typeof createLogger>) =>
        messageLogger(l, { deviceId: 'dev-1', sessionId: 1, seq: 1 }).error(
          new Error(`connect ${url}`),
        ),
    },
  ])('never prints the password for $name', ({ log }) => {
    const output = lines(log);
    expect(output).toHaveLength(1);
    expect(output[0]).not.toContain(secret);
    expect(output[0]).toContain('rabbitmq:5672');
  });

  it('keeps the error type, message and stack, only stripped', () => {
    const [line] = lines((l) => l.error(new Error(`connect ${url}`), 'connect failed'));
    const parsed = parseLine(line);
    expect(parsed).toMatchObject({ msg: 'connect failed' });
    expect(parsed['err']).toMatchObject({
      type: 'Error',
      message: 'connect amqp://[redacted]@rabbitmq:5672',
    });
    expect(String((parsed['err'] as Record<string, unknown>)['stack'])).toContain('[redacted]@');
  });

  it('gives a bare error its stripped message as msg, as pino would have done unstripped', () => {
    const [line] = lines((l) => l.error(new Error(`connect ${url}`)));
    expect(parseLine(line)).toMatchObject({ msg: 'connect amqp://[redacted]@rabbitmq:5672' });
  });

  it('walks the properties of a value whose toJSON throws', () => {
    const broken = {
      target: url,
      toJSON: () => {
        throw new Error('not serialisable');
      },
    };
    const [line] = lines((l) => l.info({ broken }, 'shape'));
    expect(line).not.toContain(secret);
    expect(parseLine(line)).toMatchObject({
      broken: { target: 'amqp://[redacted]@rabbitmq:5672' },
    });
  });

  it('redacts inside the object a toJSON returns', () => {
    const wrapped = { toJSON: () => ({ nested: { target: url } }) };
    const [line] = lines((l) => l.info({ wrapped }, 'shape'));
    expect(line).not.toContain(secret);
    expect(parseLine(line)).toMatchObject({
      wrapped: { nested: { target: 'amqp://[redacted]@rabbitmq:5672' } },
    });
  });

  it('serialises a value through its own toJSON and redacts the result', () => {
    // `URL#toJSON` returns the whole href, userinfo included; a Date its ISO string.
    const when = new Date('2026-09-12T10:00:00.000Z');
    const custom = { secret: `x ${url}`, toJSON: () => 'custom' };
    const [line] = lines((l) => l.info({ when, custom, target: new URL(`${url}/vhost`) }, 'shape'));
    expect(line).not.toContain(secret);
    expect(parseLine(line)).toMatchObject({
      when: '2026-09-12T10:00:00.000Z',
      custom: 'custom',
      target: 'amqp://[redacted]@rabbitmq:5672/vhost',
    });
  });
});

describe('createLogger redaction', () => {
  it('redacts connection strings, which carry a password', () => {
    const destination = capture();
    const logger = createLogger({ service: 'ingest', level: 'info', destination });
    logger.info({ RABBITMQ_URL: 'amqp://u:p@rabbitmq:5672' }, 'connecting');
    logger.info({ config: { MONGODB_URL: 'mongodb://u:p@mongodb:27017' } }, 'connecting');
    const [first, second] = destination.lines.map(parseLine);
    expect(first?.['RABBITMQ_URL']).toBe('[redacted]');
    expect(second?.['config']).toEqual({ MONGODB_URL: '[redacted]' });
    expect(destination.lines.join('\n')).not.toContain('u:p@');
  });
});

describe('messageLogger', () => {
  it('carries deviceId, sessionId and seq as separate fields on every line', () => {
    const destination = capture();
    const logger = createLogger({ service: 'processing', level: 'debug', destination });
    const scoped = messageLogger(logger, {
      deviceId: 'dev-0001',
      sessionId: 1_700_000_000_000,
      seq: 42,
    });
    scoped.warn('older than stored');
    scoped.debug({ outcome: 'stale' }, 'done');
    expect(destination.lines).toHaveLength(2);
    for (const raw of destination.lines) {
      expect(parseLine(raw)).toMatchObject({
        deviceId: 'dev-0001',
        sessionId: 1_700_000_000_000,
        seq: 42,
      });
    }
  });

  it('logs only the three identity fields, never the rest of a wider object', () => {
    const destination = capture();
    const logger = createLogger({ service: 'processing', level: 'info', destination });
    const wide = { deviceId: 'dev-1', sessionId: 2, seq: 3, payload: { secretish: 'x' } };
    messageLogger(logger, wide).info('stored');
    const line = parseLine(destination.lines[0]);
    expect(line).toMatchObject({ deviceId: 'dev-1', sessionId: 2, seq: 3 });
    expect(line).not.toHaveProperty('payload');
  });

  it('is unaffected by later mutation of the identity object', () => {
    const destination = capture();
    const logger = createLogger({ service: 'processing', level: 'info', destination });
    const identity = { deviceId: 'dev-1', sessionId: 2, seq: 3 };
    const scoped = messageLogger(logger, identity);
    scoped.info('first');
    identity.seq = 999;
    scoped.info('second');
    for (const raw of destination.lines) {
      expect(parseLine(raw)).toMatchObject({ seq: 3 });
    }
  });

  it('keeps two children of one parent independent', () => {
    const destination = capture();
    const logger = createLogger({ service: 'processing', level: 'info', destination });
    messageLogger(logger, { deviceId: 'dev-a', sessionId: 1, seq: 1 }).info('a');
    messageLogger(logger, { deviceId: 'dev-b', sessionId: 2, seq: 2 }).info('b');
    expect(parseLine(destination.lines[0])).toMatchObject({ deviceId: 'dev-a', seq: 1 });
    expect(parseLine(destination.lines[1])).toMatchObject({ deviceId: 'dev-b', seq: 2 });
  });
});

describe('rejectedMessageLogger', () => {
  it('accepts a partial identity for rejected input', () => {
    const destination = capture();
    const logger = createLogger({ service: 'ingest', level: 'info', destination });
    rejectedMessageLogger(logger, { deviceId: 'dev-0002' }).warn('rejected');
    const line = parseLine(destination.lines[0]);
    expect(line).toMatchObject({ deviceId: 'dev-0002', msg: 'rejected' });
    expect(line).not.toHaveProperty('sessionId');
    expect(line).not.toHaveProperty('seq');
  });
});

// Three holes the 2026-09-12 review found in the redaction above, each reproduced here first.
describe('createLogger redaction, review follow-up', () => {
  const url = 'amqp://user:p4ssw0rd@rabbitmq:5672';

  // `extractRawIdentity` hands `rejectedMessageLogger` whatever string the device sent as its
  // deviceId — the schema has rejected the message, so nothing bounded that field.
  it('redacts a device-supplied identity field bound on a rejected-message child logger', () => {
    const destination = capture();
    const logger = createLogger({ service: 'ingest', level: 'info', destination });
    rejectedMessageLogger(logger, { deviceId: url }).warn('rejected');
    expect(parseLine(destination.lines[0])['deviceId']).toBe('amqp://[redacted]@rabbitmq:5672');
    expect(destination.lines.join('\n')).not.toContain('p4ssw0rd');
  });

  it('redacts a connection string five levels deep', () => {
    const destination = capture();
    const logger = createLogger({ service: 'ingest', level: 'info', destination });
    logger.info({ a: { b: { c: { d: { e: url } } } } }, 'deep');
    // Not just "the password is absent" — that also holds if the whole subtree were dropped.
    expect(parseLine(destination.lines[0])).toMatchObject({
      a: { b: { c: { d: { e: 'amqp://[redacted]@rabbitmq:5672' } } } },
    });
  });

  it('drops a subtree below the depth bound rather than printing it unwalked', () => {
    const destination = capture();
    const logger = createLogger({ service: 'ingest', level: 'info', destination });
    logger.info({ a: { b: { c: { d: { e: { f: { g: { h: { i: url } } } } } } } } }, 'deeper');
    // The object at depth 8 is replaced by the marker, so the bound provably fired.
    expect(parseLine(destination.lines[0])).toMatchObject({
      a: { b: { c: { d: { e: { f: { g: { h: '[not redacted: depth limit]' } } } } } } },
    });
    expect(destination.lines.join('\n')).not.toContain('p4ssw0rd');
  });

  it('redacts a connection string inside an array', () => {
    const destination = capture();
    const logger = createLogger({ service: 'ingest', level: 'info', destination });
    logger.info({ endpoints: [url] }, 'connecting');
    expect(parseLine(destination.lines[0])['endpoints']).toEqual([
      'amqp://[redacted]@rabbitmq:5672',
    ]);
  });

  it('does not let a throwing getter escape the log call', () => {
    const destination = capture();
    const logger = createLogger({ service: 'ingest', level: 'info', destination });
    const value = {
      safe: 'kept',
      get exploding(): string {
        throw new Error('getter');
      },
    };
    expect(() => logger.error({ value }, 'boom')).not.toThrow();
    expect(destination.lines).toHaveLength(1);
    expect(parseLine(destination.lines[0])['msg']).toBe('boom');
    // The sibling key must survive: without the per-key catch the outer one would swallow the
    // whole object and this would be a single `redaction` key instead.
    expect(parseLine(destination.lines[0])['value']).toEqual({
      safe: 'kept',
      exploding: '[unloggable value]',
    });
  });

  it('ends a cycle instead of recursing forever', () => {
    const destination = capture();
    const logger = createLogger({ service: 'ingest', level: 'info', destination });
    const circular: Record<string, unknown> = { url };
    circular['self'] = circular;
    expect(() => logger.info({ circular }, 'cycle')).not.toThrow();
    expect(destination.lines).toHaveLength(1);
    expect(destination.lines.join('\n')).not.toContain('p4ssw0rd');
  });

  it('survives a value whose own keys cannot be listed', () => {
    const destination = capture();
    const logger = createLogger({ service: 'ingest', level: 'info', destination });
    const hostile = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error('no keys for you');
        },
      },
    );
    expect(() => logger.info({ hostile }, 'boom')).not.toThrow();
    expect(parseLine(destination.lines[0])['redaction']).toBe('[unloggable value]');
  });

  it('survives an error whose stack cannot be read', () => {
    const destination = capture();
    const logger = createLogger({ service: 'ingest', level: 'info', destination });
    const error = new Error('connect failed');
    Object.defineProperty(error, 'stack', {
      get() {
        throw new Error('no stack for you');
      },
    });
    expect(() => logger.error({ err: error }, 'failed')).not.toThrow();
    expect(destination.lines).toHaveLength(1);
  });

  it('survives an error whose message cannot be read', () => {
    const destination = capture();
    const logger = createLogger({ service: 'ingest', level: 'info', destination });
    class ThrowingMessage extends Error {
      override get message(): string {
        throw new Error('no message for you');
      }
    }
    expect(() => logger.error(new ThrowingMessage())).not.toThrow();
    expect(destination.lines).toHaveLength(1);
  });

  it('keeps a null value', () => {
    const destination = capture();
    const logger = createLogger({ service: 'ingest', level: 'info', destination });
    logger.info({ previous: null }, 'no previous state');
    expect(parseLine(destination.lines[0])['previous']).toBeNull();
  });
});
