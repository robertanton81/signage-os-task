import type { Socket } from 'node:net';

import {
  FrameDecoder,
  decodeTelemetryMessage,
  rejectedMessageLogger,
  type Logger,
} from '@telemetry/shared';

import { shouldRead, type Window } from './flow.js';
import type { PublishPort } from './publisher.js';

export type CloseReason = 'end' | 'error' | 'idle' | 'frame_too_long' | 'shutdown';

export type DeviceConnectionOptions = {
  connectionId: number;
  /** Accepted with `pauseOnConnect`: it starts paused, and only the reading rule resumes it. */
  socket: Socket;
  publisher: PublishPort;
  /** This connection's window, capped at INGEST_MAX_UNCONFIRMED. */
  window: Window;
  instanceWindow: Window;
  idleMs: number;
  logger: Logger;
  /** Called after a chunk when this connection's window closed, and by a confirm when it reopened. */
  onWindowChange: (connection: DeviceConnection) => void;
  /** Called after a chunk when the instance window closed, and by a confirm when it reopened. */
  onInstanceWindowChange: () => void;
  /**
   * Called on every confirm of this connection's messages, after the window callbacks, whether or
   * not a window reopened, and also once the connection has closed: the server re-checks its
   * shutdown drain here, because a confirm below a window's boundary crosses no edge.
   */
  onMessageConfirmed: () => void;
  onClose: (connection: DeviceConnection, reason: CloseReason) => void;
};

/**
 * One device socket (ingest spec, decisions 4, 5 and 21). It holds only what decision 21 lists: an
 * instance-local id, the remote address, its frame decoder, its window, two counters and the device
 * id of its last valid message. Nothing is keyed by device (invariant 6), and a message outlives its
 * connection only as a ledger entry.
 */
export class DeviceConnection {
  readonly connectionId: number;
  readonly remote: string;
  readonly socket: Socket;
  readonly window: Window;
  readonly #options: DeviceConnectionOptions;
  readonly #decoder = new FrameDecoder();
  #reading = false;
  #open = true;
  #closeReason: CloseReason | undefined;
  #lastDeviceId: string | undefined;
  #received = 0;
  #rejected = 0;

  constructor(options: DeviceConnectionOptions) {
    this.#options = options;
    this.connectionId = options.connectionId;
    this.socket = options.socket;
    this.window = options.window;
    this.remote = `${options.socket.remoteAddress ?? 'unknown'}:${options.socket.remotePort ?? 0}`;
    // The server accepts with `pauseOnConnect`: the handle does not read and `readableFlowing` is
    // already false (Node `lib/net.js`, `pauseOnCreate`), so the `data` listener below does not
    // resume the stream. The timeout is still undefined, so it is set to the 0 that every paused
    // socket has.
    this.socket.setTimeout(0);
    this.socket.on('data', (chunk: Buffer) => {
      this.#onData(chunk);
    });
    this.socket.on('timeout', () => {
      this.destroy('idle');
    });
    this.socket.on('end', () => {
      // `allowHalfOpen` is false, so Node ends this side too, and `close` follows.
      this.#closeReason ??= 'end';
    });
    this.socket.on('error', (error) => {
      this.#closeReason ??= 'error';
      options.logger.warn(
        { err: error, connectionId: this.connectionId, remote: this.remote },
        'connection error',
      );
    });
    this.socket.on('close', () => {
      this.#open = false;
      this.#reading = false;
      options.onClose(this, this.#closeReason ?? 'end');
    });
  }

  get isReading(): boolean {
    return this.#reading;
  }

  get lastDeviceId(): string | undefined {
    return this.#lastDeviceId;
  }

  get received(): number {
    return this.#received;
  }

  get rejected(): number {
    return this.#rejected;
  }

  /** Bytes of an unfinished frame, for the close log line. */
  get pendingBytes(): number {
    return this.#decoder.pendingBytes;
  }

  /**
   * The one reading rule (decision 2), with this connection's window. Idempotent: the socket is
   * touched only when the answer changes. Reading arms the idle timeout; a paused socket has none,
   * so a broker outage never disconnects a device (decision 4).
   */
  applyReadingRule({
    publisherReady,
    instanceWindowOpen,
  }: {
    publisherReady: boolean;
    instanceWindowOpen: boolean;
  }): void {
    if (!this.#open) {
      return;
    }
    const read = shouldRead({
      publisherReady,
      connectionWindowOpen: this.window.isOpen,
      instanceWindowOpen,
    });
    if (read === this.#reading) {
      return;
    }
    this.#reading = read;
    if (read) {
      this.socket.resume();
      this.socket.setTimeout(this.#options.idleMs);
    } else {
      this.socket.pause();
      this.socket.setTimeout(0);
    }
  }

  /** Sends FIN and keeps reading under the rule, so frames the device already wrote still arrive (decision 19). */
  halfClose(): void {
    if (this.#open) {
      this.socket.end();
    }
  }

  destroy(reason: CloseReason): void {
    if (!this.#open) {
      return;
    }
    this.#closeReason ??= reason;
    this.socket.destroy();
  }

  /** One chunk through the spec's "One frame, from socket to ledger". */
  #onData(chunk: Buffer): void {
    const { logger, publisher, instanceWindow } = this.#options;
    const result = this.#decoder.push(chunk);
    let windowClosed = false;
    let instanceWindowClosed = false;
    for (const frame of result.frames) {
      const decoded = decodeTelemetryMessage(frame);
      if (!decoded.ok) {
        this.#rejected += 1;
        rejectedMessageLogger(logger, decoded.identity).warn(
          { connectionId: this.connectionId, reason: decoded.reason, detail: decoded.detail },
          'frame rejected',
        );
        continue;
      }
      const { message } = decoded;
      this.#received += 1;
      this.#lastDeviceId = message.deviceId;
      // The rest of the chunk is processed even after a window closed: the cap is soft (decision 3).
      if (this.window.add() === 'closed') {
        windowClosed = true;
      }
      if (instanceWindow.add() === 'closed') {
        instanceWindowClosed = true;
      }
      publisher.publish({ message, receivedAt: Date.now(), onConfirmed: this.#confirmation() });
    }
    if (windowClosed) {
      this.#options.onWindowChange(this);
    }
    if (instanceWindowClosed) {
      this.#options.onInstanceWindowChange();
    }
    if (!result.ok) {
      logger.warn(
        {
          connectionId: this.connectionId,
          remote: this.remote,
          bytes: result.error.bytes,
          limit: result.error.limit,
        },
        'frame too long',
      );
      this.destroy('frame_too_long');
    }
  }

  /**
   * The `onConfirmed` handed to the publisher with one message. The instance window counts the
   * message until the broker acks it, also after this connection closed (decision 11); this
   * connection's window counts it only while the connection is open.
   */
  #confirmation(): () => void {
    return () => {
      const { instanceWindow, onInstanceWindowChange, onMessageConfirmed, onWindowChange } =
        this.#options;
      const instanceReopened = instanceWindow.remove() === 'reopened';
      const windowReopened = this.#open && this.window.remove() === 'reopened';
      if (windowReopened) {
        onWindowChange(this);
      }
      if (instanceReopened) {
        onInstanceWindowChange();
      }
      onMessageConfirmed();
    };
  }
}
