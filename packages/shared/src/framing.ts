import type { TelemetryMessage } from './message.js';

/** Upper bound of one frame in bytes, newline excluded. A valid message is a few hundred bytes. */
export const MAX_FRAME_BYTES = 64 * 1024;

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

/**
 * What one `push` produced. `frames` is on both branches so the lines decoded before an oversized
 * one cannot be dropped by accident; `error` says the decoder gave up on the stream and the caller
 * should close the connection (shared-contract spec, decision 1).
 */
export type FrameDecodeResult =
  { ok: true; frames: string[] } | { ok: false; frames: string[]; error: FrameTooLongError };

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
   * Returns every complete frame in the stream so far, without its newline. When a line or the
   * buffered tail exceeds the limit the result is `ok: false`: the buffer is cleared, the rest of
   * the chunk is not read, and the frames decoded before that point are still returned.
   */
  push(chunk: Buffer): FrameDecodeResult {
    const frames: string[] = [];
    let start = 0;
    for (;;) {
      const end = chunk.indexOf(NEWLINE, start);
      if (end === -1) {
        break;
      }
      const lineBytes = this.#tailBytes + (end - start);
      if (lineBytes > this.#maxFrameBytes) {
        this.#reset();
        return { ok: false, frames, error: new FrameTooLongError(lineBytes, this.#maxFrameBytes) };
      }
      const part = chunk.subarray(start, end);
      // Join before decoding, so a multi-byte character split across chunks is intact.
      let line: string;
      if (this.#tailBytes === 0) {
        line = part.toString('utf8');
      } else {
        this.#append(part);
        line = this.#tail.toString('utf8', 0, this.#tailBytes);
      }
      this.#reset();
      if (line.trim().length > 0) {
        frames.push(line);
      }
      start = end + 1;
    }
    const tail = chunk.subarray(start);
    const tailBytes = this.#tailBytes + tail.length;
    if (tailBytes > this.#maxFrameBytes) {
      this.#reset();
      return { ok: false, frames, error: new FrameTooLongError(tailBytes, this.#maxFrameBytes) };
    }
    if (tail.length > 0) {
      this.#append(tail);
    }
    return { ok: true, frames };
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
