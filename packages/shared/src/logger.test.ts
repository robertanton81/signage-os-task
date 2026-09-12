import { describe, expect, it } from 'vitest';

import { LOG_LEVELS, createLogger, messageLogger, rejectedMessageLogger } from './logger.js';

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

  it('lists the accepted levels', () => {
    expect(LOG_LEVELS).toEqual(['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent']);
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
