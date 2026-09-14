import {
  MAX_FRAME_BYTES,
  RECEIVED_AT_HEADER,
  decodeTelemetryMessage,
  decodeUtf8Strict,
  type RawIdentity,
  type TelemetryMessage,
} from '@telemetry/shared';

export type DecodedDelivery = {
  message: TelemetryMessage;
  /** The `x-received-at` header, or the handler's clock when the header is unusable. */
  receivedAt: number;
  receivedAtSource: 'header' | 'clock';
  redelivered: boolean;
};

export type DeliveryRejectionReason =
  'body_too_large' | 'invalid_utf8' | 'invalid_json' | 'invalid_schema';

export type DeliveryRejection = {
  reason: DeliveryRejectionReason;
  detail: string;
  /** Whatever identity fields the body had; empty when it could not be read at all. */
  identity: RawIdentity;
  bytes: number;
};

export type DeliveryInput = {
  content: Buffer;
  /** amqplib's `properties.headers`; every value is read as `unknown`. */
  headers: Record<string, unknown> | undefined;
  redelivered: boolean;
  /** Read only when the header is unusable. */
  clock: () => number;
};

export type DecodeDeliveryResult =
  { ok: true; delivery: DecodedDelivery } | { ok: false; rejection: DeliveryRejection };

/**
 * Turns one AMQP delivery into what the handler needs, without touching the broker (processing
 * spec, decision 14). The body is bounded before anything is decoded: ingest never publishes a
 * frame over MAX_FRAME_BYTES, so a bigger body comes from a foreign publisher, and RabbitMQ would
 * accept up to 16 MiB of it. Bytes that are not valid UTF-8 are rejected, never repaired to U+FFFD
 * (the frame decoder's rule). The identity comes from the validated body; the AMQP `messageId`
 * property is not read (consistency spec, decision 3).
 *
 * The header is used only when amqplib handed it over as a safe non-negative integer — a
 * millisecond timestamp round-trips through the AMQP `long` encoding as a plain number — and the
 * caller's clock stands in otherwise (consistency spec, decision 18). Pure; the caller logs.
 */
export function decodeDelivery({
  content,
  headers,
  redelivered,
  clock,
}: DeliveryInput): DecodeDeliveryResult {
  const bytes = content.length;
  if (bytes > MAX_FRAME_BYTES) {
    return rejection({
      reason: 'body_too_large',
      detail: `${bytes} bytes exceed the limit of ${MAX_FRAME_BYTES}`,
      identity: {},
      bytes,
    });
  }
  const text = decodeUtf8Strict(content);
  if (!text.ok) {
    return rejection({ reason: 'invalid_utf8', detail: text.detail, identity: {}, bytes });
  }
  const decoded = decodeTelemetryMessage(text.text);
  if (!decoded.ok) {
    return rejection({
      reason: decoded.reason,
      detail: decoded.detail,
      identity: decoded.identity,
      bytes,
    });
  }
  const header: unknown = headers?.[RECEIVED_AT_HEADER];
  const receivedAt =
    typeof header === 'number' && Number.isSafeInteger(header) && header >= 0
      ? { value: header, source: 'header' as const }
      : { value: clock(), source: 'clock' as const };
  return {
    ok: true,
    delivery: {
      message: decoded.message,
      receivedAt: receivedAt.value,
      receivedAtSource: receivedAt.source,
      redelivered,
    },
  };
}

function rejection(details: DeliveryRejection): DecodeDeliveryResult {
  return { ok: false, rejection: details };
}
