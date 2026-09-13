import { decodeTelemetryMessage, type TelemetryMessageOf } from '@telemetry/shared';
import { describe, expect, it } from 'vitest';

import { parseMessageId, toPublishArgs } from './amqp-message.js';
import { exampleMessages } from './fixtures.js';

const RECEIVED_AT = 1_757_800_000_123;

describe('toPublishArgs', () => {
  // Literal values, not the shared constants: this table is the wire contract processing reads
  // (consistency spec, "Queue topology" and the ingest section), so a changed constant must fail here.
  it.each([
    { type: 'status', messageId: 'dev-0001:1700000000000:1' },
    { type: 'metrics', messageId: 'dev-0001:1700000000000:2' },
    { type: 'counters', messageId: 'dev-0001:1700000000000:3' },
    { type: 'diagnostic', messageId: 'dev-0001:1700000000000:4' },
  ] as const)('builds every publish argument for a $type message', ({ type, messageId }) => {
    const message = exampleMessages[type];
    const args = toPublishArgs(message, RECEIVED_AT);

    // The content is compared on its own: `expect.any(Buffer)` inside the object would be an `any`.
    const { content, ...properties } = args;
    expect(properties).toEqual({
      exchange: 'telemetry',
      routingKey: 'event',
      options: {
        persistent: true,
        mandatory: true,
        contentType: 'application/json',
        messageId,
        timestamp: 1_757_800_000,
        headers: { 'x-received-at': RECEIVED_AT },
      },
    });
    // The body is the validated message re-encoded (decision 6), and it decodes back unchanged.
    expect(content.toString('utf8')).toBe(JSON.stringify(message));
    expect(decodeTelemetryMessage(content.toString('utf8'))).toEqual({ ok: true, message });
  });

  it('writes no newline byte, even when a text field contains one', () => {
    const message: TelemetryMessageOf<'diagnostic'> = {
      ...exampleMessages.diagnostic,
      payload: { severity: 'warning', code: 'E_MULTILINE', message: 'line one\nline two' },
    };
    const { content } = toPublishArgs(message, RECEIVED_AT);

    expect(content.includes(0x0a)).toBe(false);
    expect(decodeTelemetryMessage(content.toString('utf8'))).toEqual({ ok: true, message });
  });

  it('keeps a multi-byte UTF-8 character in a text field intact', () => {
    // 'ř' is two bytes in UTF-8 and one in latin1, so a changed encoding argument fails here. Every
    // other fixture in this file is ASCII, where the two encodings agree (as in framing.test.ts).
    const message: TelemetryMessageOf<'diagnostic'> = {
      ...exampleMessages.diagnostic,
      payload: { severity: 'warning', code: 'E_OVERHEAT', message: 'p\u0159eh\u0159\u00e1t\u00ed' },
    };
    const { content } = toPublishArgs(message, RECEIVED_AT);

    expect(content.includes(Buffer.from([0xc5, 0x99]))).toBe(true);
    expect(decodeTelemetryMessage(content.toString('utf8'))).toEqual({ ok: true, message });
  });

  // 999 ms past the second: rounding would give the next second, flooring must not.
  const LATE_IN_THE_SECOND = 1_757_800_000_999;

  it('floors the AMQP timestamp to whole seconds', () => {
    expect(toPublishArgs(exampleMessages.metrics, LATE_IN_THE_SECOND).options.timestamp).toBe(
      1_757_800_000,
    );
  });

  it('keeps the exact milliseconds in the x-received-at header', () => {
    expect(toPublishArgs(exampleMessages.metrics, LATE_IN_THE_SECOND).options.headers).toEqual({
      'x-received-at': 1_757_800_000_999,
    });
  });
});

describe('parseMessageId', () => {
  it.each(Object.values(exampleMessages))(
    'reads back the identity toPublishArgs wrote for the $type message',
    (message) => {
      const { messageId } = toPublishArgs(message, RECEIVED_AT).options;
      expect(parseMessageId(messageId)).toEqual({
        deviceId: message.deviceId,
        sessionId: message.sessionId,
        seq: message.seq,
      });
    },
  );

  it.each([
    { name: 'a number', messageId: 42 },
    { name: 'no message id', messageId: undefined },
    { name: 'two parts', messageId: 'dev-1:2' },
    { name: 'four parts', messageId: 'dev-1:2:5:6' },
    { name: 'an empty device id', messageId: ':2:5' },
    { name: 'an empty session id', messageId: 'dev-1::5' },
    { name: 'an empty seq', messageId: 'dev-1:2:' },
    { name: 'a session id that is not a number', messageId: 'dev-1:x:5' },
    { name: 'a seq with a fraction', messageId: 'dev-1:2:5.5' },
    { name: 'a hexadecimal session id', messageId: 'dev-1:0x10:5' },
    { name: 'a seq with a leading space', messageId: 'dev-1:2: 5' },
    { name: 'a session id past the safe integer range', messageId: 'dev-1:9007199254740993:5' },
  ])('gives undefined for $name', ({ messageId }) => {
    expect(parseMessageId(messageId)).toBeUndefined();
  });
});
