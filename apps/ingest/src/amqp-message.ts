import {
  MESSAGE_CONTENT_TYPE,
  RECEIVED_AT_HEADER,
  TELEMETRY_EXCHANGE,
  TELEMETRY_ROUTING_KEY,
  messageIdentity,
  type MessageIdentity,
  type TelemetryMessage,
} from '@telemetry/shared';
import type { Options } from 'amqplib';

/** Everything `ConfirmChannel#publish` takes except its confirm callback. */
export type PublishArgs = {
  exchange: string;
  routingKey: string;
  content: Buffer;
  options: Options.Publish;
};

/**
 * The AMQP publish arguments of one validated message (ingest spec, decisions 6 and 7).
 *
 * The body is the validated message re-encoded, not the raw frame bytes. The schema bounds it, so
 * whitespace padding cannot inflate the memory the confirm windows hold, and processing gets one
 * canonical form. `JSON.stringify` escapes a newline inside a string, so the body never contains a
 * raw newline byte.
 *
 * The AMQP 0-9-1 `timestamp` property is in whole seconds (RabbitMQ, "Property conversions"), so
 * the millisecond receive time travels only in the `x-received-at` header, which processing stores
 * as `receivedAt`. amqplib writes an integer wider than 32 bits as a signed 64-bit long and reads it
 * back as a plain number (`lib/codec.js`). A re-publish reuses these arguments, so it keeps the
 * original receive time.
 */
export function toPublishArgs(message: TelemetryMessage, receivedAt: number): PublishArgs {
  return {
    exchange: TELEMETRY_EXCHANGE,
    routingKey: TELEMETRY_ROUTING_KEY,
    content: Buffer.from(JSON.stringify(message), 'utf8'),
    options: {
      persistent: true,
      mandatory: true,
      contentType: MESSAGE_CONTENT_TYPE,
      messageId: messageIdentity(message),
      timestamp: Math.floor(receivedAt / 1000),
      headers: { [RECEIVED_AT_HEADER]: receivedAt },
    },
  };
}

const DIGITS = /^\d+$/;

/**
 * The identity inside a message id that `toPublishArgs` wrote: `deviceId:sessionId:seq` (shared
 * `messageIdentity`; a device id cannot contain a colon). A returned message's id comes back from the
 * broker, so it is checked, not trusted: any other shape gives `undefined`.
 */
export function parseMessageId(messageId: unknown): MessageIdentity | undefined {
  if (typeof messageId !== 'string') {
    return undefined;
  }
  const parts = messageId.split(':');
  if (parts.length !== 3) {
    return undefined;
  }
  const [deviceId = '', sessionText = '', seqText = ''] = parts;
  if (deviceId === '' || !DIGITS.test(sessionText) || !DIGITS.test(seqText)) {
    return undefined;
  }
  const sessionId = Number(sessionText);
  const seq = Number(seqText);
  if (!Number.isSafeInteger(sessionId) || !Number.isSafeInteger(seq)) {
    return undefined;
  }
  return { deviceId, sessionId, seq };
}
