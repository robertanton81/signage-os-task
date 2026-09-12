import type { TelemetryMessage } from './message.js';

/** Upper bound of one frame in bytes, newline excluded. A valid message is a few hundred bytes. */
export const MAX_FRAME_BYTES = 64 * 1024;

const NEWLINE = 0x0a;

export class FrameTooLongError extends Error {
  override readonly name = 'FrameTooLongError';

  constructor(
    readonly bytes: number,
    readonly limit: number,
    /**
     * Complete frames already decoded from the same chunk, before the oversized one was reached.
     * They are valid telemetry and are not in the decoder any more, so a caller that keeps the
     * connection open must take them from here or lose them.
     */
    readonly frames: readonly string[] = [],
  ) {
    super(`frame of ${bytes} bytes exceeds the limit of ${limit} bytes`);
  }
}

/** One message per line: UTF-8 JSON followed by `\n` (shared-contract spec, decision 1). */
export function encodeFrame(message: TelemetryMessage): Buffer {
  return Buffer.from(`${JSON.stringify(message)}\n`, 'utf8');
}

/**
 * Splits a byte stream into complete lines. Keeps the unfinished tail between calls, so one
 * instance belongs to one connection. Whitespace-only lines are ignored.
 */
export class FrameDecoder {
  #pending: Buffer = Buffer.alloc(0);
  readonly #maxFrameBytes: number;

  constructor(maxFrameBytes: number = MAX_FRAME_BYTES) {
    this.#maxFrameBytes = maxFrameBytes;
  }

  /** Bytes of the unfinished line currently buffered (logged when a connection closes). */
  get pendingBytes(): number {
    return this.#pending.length;
  }

  /**
   * Returns every complete frame in the stream so far, without its newline.
   * Throws FrameTooLongError when a line or the buffered tail exceeds the limit; the buffer is
   * cleared first so the caller may close the connection or keep reading.
   */
  push(chunk: Buffer): string[] {
    const data = this.#pending.length === 0 ? chunk : Buffer.concat([this.#pending, chunk]);
    const frames: string[] = [];
    let start = 0;
    for (;;) {
      const end = data.indexOf(NEWLINE, start);
      if (end === -1) {
        break;
      }
      if (end - start > this.#maxFrameBytes) {
        this.#pending = Buffer.alloc(0);
        throw new FrameTooLongError(end - start, this.#maxFrameBytes, frames);
      }
      const line = data.toString('utf8', start, end);
      if (line.trim().length > 0) {
        frames.push(line);
      }
      start = end + 1;
    }
    const tail = data.subarray(start);
    if (tail.length > this.#maxFrameBytes) {
      this.#pending = Buffer.alloc(0);
      throw new FrameTooLongError(tail.length, this.#maxFrameBytes, frames);
    }
    // Copy, not a view: `subarray` would keep the whole backing buffer alive (the concatenated
    // `data`, or the socket read buffer `chunk` came from), and the caller may reuse its chunk.
    this.#pending = Buffer.from(tail);
    return frames;
  }
}
