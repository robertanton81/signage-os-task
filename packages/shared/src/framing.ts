import type { TelemetryMessage } from './message.js';

/** The request path of the device WebSocket endpoint on ingest (WebSocket transport spec, decision 1). */
export const TELEMETRY_SOCKET_PATH = '/telemetry';

/**
 * Upper bound of one message on the wire, in bytes: the server's `maxPayload`, and the AMQP body
 * bound in processing. A valid message is a few hundred bytes.
 */
export const MAX_FRAME_BYTES = 64 * 1024;

/**
 * One compact JSON message per WebSocket text message (WebSocket transport spec, decision 2). No
 * `space` argument: the text is one line and matches the AMQP body byte for byte.
 */
export function encodeMessage(message: TelemetryMessage): string {
  return JSON.stringify(message);
}

export type Utf8DecodeResult = { ok: true; text: string } | { ok: false; detail: string };

/**
 * `fatal`: a byte sequence that is not valid UTF-8 throws instead of becoming U+FFFD. `ignoreBOM`:
 * a leading byte order mark stays in the text, as `Buffer.toString` keeps it, so it still fails
 * as JSON instead of being stripped in silence (Node `util.TextDecoder`). One instance serves every
 * call: without `stream: true` a `decode()` keeps no state between calls.
 */
const STRICT_UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/**
 * Bytes to text, or a rejection. `Buffer.toString('utf8')` replaces invalid sequences with U+FFFD
 * and never says so; inside a string value the result passes JSON and the schema, so a corrupted
 * body would be stored as telemetry the device never sent. The AMQP body in processing goes
 * through this; on the device socket `ws` validates the UTF-8 of every text message itself and
 * fails the connection on a violation (RFC 6455 §8.1).
 */
export function decodeUtf8Strict(bytes: Uint8Array): Utf8DecodeResult {
  try {
    return { ok: true, text: STRICT_UTF8.decode(bytes) };
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) };
  }
}
