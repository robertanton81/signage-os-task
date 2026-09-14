import { MAX_FRAME_BYTES, RECEIVED_AT_HEADER, type TelemetryMessage } from '@telemetry/shared';
import { describe, expect, it } from 'vitest';

import { decodeDelivery } from './delivery.js';
import { EXAMPLE_RECEIVED_AT, exampleMessages } from './fixtures.js';

const CLOCK_NOW = 1_700_000_009_999;
const clock = (): number => CLOCK_NOW;
/** For the cases in which the header decides: reading the clock would be the bug. */
const clockMustNotBeRead = (): number => {
  throw new Error('the clock must not be read while the header is usable');
};

function body(message: TelemetryMessage): Buffer {
  return Buffer.from(JSON.stringify(message), 'utf8');
}

const headerReceivedAt = { [RECEIVED_AT_HEADER]: EXAMPLE_RECEIVED_AT };

describe('decodeDelivery', () => {
  it.each(
    Object.values(exampleMessages).flatMap((message) => [
      { type: message.type, redelivered: false, message },
      { type: message.type, redelivered: true, message },
    ]),
  )(
    'decodes a $type body with the header and redelivered $redelivered',
    ({ message, redelivered }) => {
      const result = decodeDelivery({
        content: body(message),
        headers: headerReceivedAt,
        redelivered,
        clock: clockMustNotBeRead,
      });

      expect(result).toEqual({
        ok: true,
        delivery: {
          message,
          receivedAt: EXAMPLE_RECEIVED_AT,
          receivedAtSource: 'header',
          redelivered,
        },
      });
    },
  );

  it('rejects a body over MAX_FRAME_BYTES before parsing it, even when it is valid JSON', () => {
    // Valid JSON and schema-invalid (an unknown key): the reason must be the size, not the schema.
    const content = Buffer.from(
      JSON.stringify({ ...exampleMessages.status, junk: 'x'.repeat(MAX_FRAME_BYTES) }),
      'utf8',
    );
    expect(content.length).toBeGreaterThan(MAX_FRAME_BYTES);

    const result = decodeDelivery({
      content,
      headers: headerReceivedAt,
      redelivered: false,
      clock,
    });

    expect(result).toEqual({
      ok: false,
      rejection: {
        reason: 'body_too_large',
        detail: `${content.length} bytes exceed the limit of ${MAX_FRAME_BYTES}`,
        identity: {},
        bytes: content.length,
      },
    });
  });

  it('rejects a body with an invalid UTF-8 byte inside a string value instead of repairing it', () => {
    const text = JSON.stringify(exampleMessages.diagnostic);
    const inside = text.indexOf('temperature above') + 'temperature'.length;
    const content = Buffer.concat([
      Buffer.from(text.slice(0, inside), 'utf8'),
      Buffer.from([0xff]),
      Buffer.from(text.slice(inside), 'utf8'),
    ]);

    const result = decodeDelivery({
      content,
      headers: headerReceivedAt,
      redelivered: false,
      clock,
    });

    expect(result).toMatchObject({
      ok: false,
      rejection: { reason: 'invalid_utf8', identity: {}, bytes: content.length },
    });
    if (result.ok) throw new Error('unreachable');
    expect(result.rejection.detail.length).toBeGreaterThan(0);
  });

  it('rejects a body that is not JSON', () => {
    const content = Buffer.from('not json', 'utf8');

    const result = decodeDelivery({
      content,
      headers: headerReceivedAt,
      redelivered: false,
      clock,
    });

    expect(result).toMatchObject({
      ok: false,
      rejection: { reason: 'invalid_json', identity: {}, bytes: content.length },
    });
  });

  it('rejects a schema violation with the raw identity fields it could read', () => {
    const content = Buffer.from(
      '{"type":"bogus","deviceId":"dev-0001","sessionId":1700000000000,"seq":9}',
      'utf8',
    );

    const result = decodeDelivery({
      content,
      headers: headerReceivedAt,
      redelivered: false,
      clock,
    });

    expect(result).toMatchObject({
      ok: false,
      rejection: {
        reason: 'invalid_schema',
        identity: { deviceId: 'dev-0001', sessionId: 1_700_000_000_000, seq: 9 },
        bytes: content.length,
      },
    });
  });

  it.each([
    { label: 'no headers at all', headers: undefined },
    { label: 'a missing key', headers: {} },
    { label: 'a negative number', headers: { [RECEIVED_AT_HEADER]: -1 } },
    { label: 'a fraction', headers: { [RECEIVED_AT_HEADER]: 1.5 } },
    { label: 'a numeric string', headers: { [RECEIVED_AT_HEADER]: '1700000000600' } },
    { label: 'an unsafe integer', headers: { [RECEIVED_AT_HEADER]: 2 ** 53 } },
    { label: 'a boolean', headers: { [RECEIVED_AT_HEADER]: true } },
  ])('uses the clock for $label', ({ headers }) => {
    const result = decodeDelivery({
      content: body(exampleMessages.metrics),
      headers,
      redelivered: false,
      clock,
    });

    expect(result).toEqual({
      ok: true,
      delivery: {
        message: exampleMessages.metrics,
        receivedAt: CLOCK_NOW,
        receivedAtSource: 'clock',
        redelivered: false,
      },
    });
  });

  it('takes a header of 0 as a header value, not as missing', () => {
    const result = decodeDelivery({
      content: body(exampleMessages.counters),
      headers: { [RECEIVED_AT_HEADER]: 0 },
      redelivered: false,
      clock: clockMustNotBeRead,
    });

    expect(result).toMatchObject({
      ok: true,
      delivery: { receivedAt: 0, receivedAtSource: 'header' },
    });
  });
});
