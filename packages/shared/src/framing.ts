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

const NEWLINE = 0x0a;

/** First capacity of the tail buffer; a whole valid message is normally smaller. */
const INITIAL_TAIL_BYTES = 1024;

export class FrameTooLongError extends Error {
  override readonly name = 'FrameTooLongError';

  constructor(
    readonly bytes: number,
    readonly limit: number,
  ) {
    super(`frame of ${bytes} bytes exceeds the limit of ${limit} bytes`);
  }
}

/** A completed line that is not valid UTF-8. The line is dropped; the stream stays usable. */
export type FrameRejection = { reason: 'invalid_utf8'; bytes: number; detail: string };

/**
 * What one `push` produced. `frames` and `rejected` are on both branches so the lines decoded
 * before an oversized one cannot be dropped by accident; `error` says the decoder gave up on the
 * stream and the caller should close the connection (shared-contract spec, decision 1). The order
 * between accepted and rejected lines is not kept: a rejected line has no effect, so it has no place
 * in the order.
 */
export type FrameDecodeResult =
  | { ok: true; frames: string[]; rejected: readonly FrameRejection[] }
  | { ok: false; frames: string[]; rejected: readonly FrameRejection[]; error: FrameTooLongError };

/**
 * Shared by every result without a rejection. A fresh array per `push` is one more object per
 * call, and a device that sends one byte at a time makes 65 536 calls per line; the memory test
 * on that drip measures raw heap growth and would count them.
 */
const NO_REJECTIONS: readonly FrameRejection[] = Object.freeze([]);

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
 * frame would be published as telemetry the device never sent. Both places that turn received bytes
 * into a message — the frame decoder here and the AMQP body in processing — go through this.
 */
export function decodeUtf8Strict(bytes: Uint8Array): Utf8DecodeResult {
  try {
    return { ok: true, text: STRICT_UTF8.decode(bytes) };
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) };
  }
}

/** One message per line: UTF-8 JSON followed by `\n` (shared-contract spec, decision 1). */
export function encodeFrame(message: TelemetryMessage): Buffer {
  return Buffer.from(`${JSON.stringify(message)}\n`, 'utf8');
}

/**
 * Splits a byte stream into complete lines. Keeps the unfinished tail between calls, so one
 * instance belongs to one connection. Whitespace-only lines are ignored. Never throws.
 *
 * The unfinished tail is kept in one buffer that grows by doubling. Each `push` scans and copies
 * the chunk it was given, plus the old tail on the few calls that have to grow the buffer, which
 * is amortised O(1) per byte. A tail above `INITIAL_TAIL_BYTES` costs at most twice its own bytes;
 * below it, the 1 KiB floor. Rebuilding one buffer per push would re-copy the whole tail every
 * time, which a device sending one byte at a time turns into seconds of blocked event loop per
 * connection (65 536 single-byte pushes: 283 ms before, about 9 ms now).
 * Keeping the chunks in a list instead would also be linear, but it costs one JS Buffer object per
 * chunk: the same drip held 9.4 MB of heap for 64 KiB of data (measured, against about 0.6 MB
 * now), which is a cheaper denial of service than the quadratic copying it replaced.
 */
export class FrameDecoder {
  #tail: Buffer = Buffer.alloc(0);
  #tailBytes = 0;
  readonly #maxFrameBytes: number;

  constructor(maxFrameBytes: number = MAX_FRAME_BYTES) {
    this.#maxFrameBytes = maxFrameBytes;
  }

  /** Bytes of the unfinished line currently buffered (logged when a connection closes). */
  get pendingBytes(): number {
    return this.#tailBytes;
  }

  /**
   * Returns every complete frame in the stream so far, without its newline. A completed line that
   * is not valid UTF-8 is reported in `rejected` and skipped. When a line or the buffered tail
   * exceeds the limit the result is `ok: false`: the buffer is cleared, the rest of the chunk is
   * not read, and the frames decoded before that point are still returned.
   */
  push(chunk: Buffer): FrameDecodeResult {
    const frames: string[] = [];
    let rejected: FrameRejection[] | undefined;
    let start = 0;
    for (;;) {
      const end = chunk.indexOf(NEWLINE, start);
      if (end === -1) {
        break;
      }
      const lineBytes = this.#tailBytes + (end - start);
      if (lineBytes > this.#maxFrameBytes) {
        this.#reset();
        return {
          ok: false,
          frames,
          rejected: rejected ?? NO_REJECTIONS,
          error: new FrameTooLongError(lineBytes, this.#maxFrameBytes),
        };
      }
      const part = chunk.subarray(start, end);
      // Join before decoding, so a multi-byte character split across chunks is intact.
      let decoded: Utf8DecodeResult;
      if (this.#tailBytes === 0) {
        decoded = decodeUtf8Strict(part);
      } else {
        this.#append(part);
        decoded = decodeUtf8Strict(this.#tail.subarray(0, this.#tailBytes));
      }
      this.#reset();
      start = end + 1;
      if (!decoded.ok) {
        (rejected ??= []).push({
          reason: 'invalid_utf8',
          bytes: lineBytes,
          detail: decoded.detail,
        });
        continue;
      }
      if (decoded.text.trim().length > 0) {
        frames.push(decoded.text);
      }
    }
    const tail = chunk.subarray(start);
    const tailBytes = this.#tailBytes + tail.length;
    if (tailBytes > this.#maxFrameBytes) {
      this.#reset();
      return {
        ok: false,
        frames,
        rejected: rejected ?? NO_REJECTIONS,
        error: new FrameTooLongError(tailBytes, this.#maxFrameBytes),
      };
    }
    if (tail.length > 0) {
      this.#append(tail);
    }
    return { ok: true, frames, rejected: rejected ?? NO_REJECTIONS };
  }

  /** Copies `part` onto the tail, doubling the buffer when it no longer fits. */
  #append(part: Buffer): void {
    const needed = this.#tailBytes + part.length;
    if (needed > this.#tail.length) {
      // `Math.max`, not a doubling loop: `Buffer.copy` silently copies only what fits when the
      // target is too small, and `#tailBytes` would still claim the full length, so a capacity
      // that is ever short truncates the line with no error anywhere. This form cannot be short.
      const doubled = this.#tail.length === 0 ? INITIAL_TAIL_BYTES : this.#tail.length * 2;
      const capacity = Math.max(needed, doubled);
      // `alloc`, not `allocUnsafe`: nothing here is hot enough to be worth reading uninitialised
      // memory, and only the first `#tailBytes` bytes are ever decoded anyway.
      const grown = Buffer.alloc(capacity);
      this.#tail.copy(grown, 0, 0, this.#tailBytes);
      this.#tail = grown;
    }
    // A copy, never a view: `subarray` would keep the caller's chunk alive, and a socket reuses it.
    part.copy(this.#tail, this.#tailBytes);
    this.#tailBytes = needed;
  }

  #reset(): void {
    this.#tail = Buffer.alloc(0);
    this.#tailBytes = 0;
  }
}
