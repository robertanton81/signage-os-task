import { decodeTelemetryMessage, rejectedMessageLogger, type Logger } from '@telemetry/shared';
import { WebSocket, type RawData } from 'ws';

import { shouldRead, type Window } from './flow.js';
import type { PublishPort } from './publisher.js';

/**
 * Why a connection closed (WebSocket transport spec, decision 7). `end`: the device sent a close
 * frame, or the TCP connection ended or was reset without one — `ws` swallows socket errors and
 * reports them as a close with code 1006. `error`: an `error` event that is not a protocol
 * violation; rare on the server for that reason. `protocol`: a `WS_ERR_*` error, which `ws` closes
 * itself. `binary`: a binary message, closed with 1003. `unresponsive`: no pong. `shutdown`:
 * terminated at the drain budget.
 */
export type CloseReason = 'end' | 'error' | 'protocol' | 'binary' | 'unresponsive' | 'shutdown';

export type DeviceConnectionOptions = {
  connectionId: number;
  /** Accepted through `handleUpgrade` and paused by the server before this constructor runs. */
  ws: WebSocket;
  remote: string;
  publisher: PublishPort;
  /** This connection's window, capped at INGEST_MAX_UNCONFIRMED. */
  window: Window;
  instanceWindow: Window;
  logger: Logger;
  /** Called after a message when this connection's window closed, and by a confirm when it reopened. */
  onWindowChange: (connection: DeviceConnection) => void;
  /** Called after a message when the instance window closed, and by a confirm when it reopened. */
  onInstanceWindowChange: () => void;
  /**
   * Called on every confirm of this connection's messages, after the window callbacks, whether or
   * not a window reopened, and also once the connection has closed: the server re-checks its
   * shutdown drain here, because a confirm below a window's boundary crosses no edge.
   */
  onMessageConfirmed: () => void;
  onClose: (connection: DeviceConnection, reason: CloseReason) => void;
};

/** Close code for an endpoint going away (RFC 6455 §7.4.1): what a stopping instance sends. */
const GOING_AWAY = 1001;

/** Close code for data the endpoint cannot accept (RFC 6455 §7.4.1): a binary message. */
const UNSUPPORTED_DATA = 1003;

/** Every error `ws`'s receiver raises carries a code with this prefix (ws 8.21.3, `doc/ws.md`). */
const PROTOCOL_ERROR_CODE_PREFIX = 'WS_ERR_';

function protocolErrorCode(error: Error): string | undefined {
  if (
    'code' in error &&
    typeof error.code === 'string' &&
    error.code.startsWith(PROTOCOL_ERROR_CODE_PREFIX)
  ) {
    return error.code;
  }
  return undefined;
}

/** `ws` hands text messages over as one `Buffer` (`binaryType` `nodebuffer`); the other shapes of `RawData` are joined. */
function toBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) {
    return data;
  }
  if (Array.isArray(data)) {
    return Buffer.concat(data);
  }
  return Buffer.from(data);
}

/**
 * One device connection (ingest spec, decisions 2, 3 and 21; WebSocket transport spec, decisions
 * 3, 5, 6 and 7). It holds only an instance-local id, the remote address, its window, two counters,
 * the device id of its last valid message and the liveness flag. Nothing is keyed by device
 * (invariant 6), and a message outlives its connection only as a ledger entry.
 */
export class DeviceConnection {
  readonly connectionId: number;
  readonly remote: string;
  readonly ws: WebSocket;
  readonly window: Window;
  readonly #options: DeviceConnectionOptions;
  #reading = false;
  /** False once the `'close'` event has fired. A `CLOSING` connection still reads and can be terminated. */
  #open = true;
  #closeReason: CloseReason | undefined;
  #closeCode: number | undefined;
  #awaitingPong = false;
  #lastDeviceId: string | undefined;
  #received = 0;
  #rejected = 0;

  constructor(options: DeviceConnectionOptions) {
    this.#options = options;
    this.connectionId = options.connectionId;
    this.ws = options.ws;
    this.window = options.window;
    this.remote = options.remote;
    this.ws.on('message', (data, isBinary) => {
      this.#onMessage(data, isBinary);
    });
    this.ws.on('pong', () => {
      this.#awaitingPong = false;
    });
    this.ws.on('error', (error) => {
      this.#onError(error);
    });
    this.ws.on('close', (code) => {
      this.#open = false;
      this.#reading = false;
      this.#closeCode = code;
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

  /** The close code of the peer's close frame, 1005 for an empty one, 1006 when there was none (RFC 6455 §7.1.5); undefined while open. */
  get closeCode(): number | undefined {
    return this.#closeCode;
  }

  /**
   * The one reading rule (ingest spec, decision 2), with this connection's window. Idempotent: the
   * connection is touched only when the answer changes. `ws.pause()` pauses the underlying socket,
   * so a paused connection applies TCP backpressure to the device (transport spec, decision 5).
   * Reading on starts a fresh liveness interval, so a device gets a full interval after an outage.
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
      this.ws.resume();
      this.#awaitingPong = false;
    } else {
      this.ws.pause();
    }
  }

  /**
   * One tick of the liveness check (transport spec, decision 6): a reading connection that did not
   * answer the previous ping is destroyed; otherwise it is pinged. A paused connection cannot read
   * the pong, and a closing one need not answer (RFC 6455 §5.5.2), so neither is pinged.
   */
  checkLiveness(): void {
    if (!this.#reading || this.ws.readyState !== WebSocket.OPEN) {
      return;
    }
    if (this.#awaitingPong) {
      this.destroy('unresponsive');
      return;
    }
    this.#awaitingPong = true;
    this.ws.ping();
  }

  /**
   * Starts the closing handshake with code 1001 and keeps reading under the rule, so what the
   * device already sent still arrives (transport spec, decision 8). A connection already closing on
   * its own is left to finish that close and keeps its own reason.
   */
  beginClose(): void {
    if (this.ws.readyState === WebSocket.OPEN) {
      this.ws.close(GOING_AWAY, 'ingest shutting down');
    }
  }

  destroy(reason: CloseReason): void {
    if (!this.#open) {
      return;
    }
    this.#closeReason ??= reason;
    this.ws.terminate();
  }

  /** One message through the spec's "One message, from socket to ledger". */
  #onMessage(data: RawData, isBinary: boolean): void {
    // A connection that is being closed for a violation processes nothing more, the same way `ws`
    // stops reading after a protocol error.
    if (this.#closeReason !== undefined) {
      return;
    }
    const { logger, publisher, instanceWindow } = this.#options;
    if (isBinary) {
      this.#rejected += 1;
      this.#closeReason = 'binary';
      logger.warn(
        {
          connectionId: this.connectionId,
          remote: this.remote,
          lastDeviceId: this.#lastDeviceId,
          bytes: toBuffer(data).length,
        },
        'binary message rejected',
      );
      this.ws.close(UNSUPPORTED_DATA, 'text messages only');
      return;
    }
    // `ws` validated the UTF-8 (`skipUTF8Validation` is off), so `toString` substitutes nothing.
    const decoded = decodeTelemetryMessage(toBuffer(data).toString('utf8'));
    if (!decoded.ok) {
      this.#rejected += 1;
      rejectedMessageLogger(logger, decoded.identity).warn(
        { connectionId: this.connectionId, reason: decoded.reason, detail: decoded.detail },
        'message rejected',
      );
      return;
    }
    const { message } = decoded;
    this.#received += 1;
    this.#lastDeviceId = message.deviceId;
    // The caps are soft (decision 3): `ws` emits every message of one socket read in the same
    // tick, and a pause takes effect only for the next read.
    const windowClosed = this.window.add() === 'closed';
    const instanceWindowClosed = instanceWindow.add() === 'closed';
    publisher.publish({ message, receivedAt: Date.now(), onConfirmed: this.#confirmation() });
    if (windowClosed) {
      this.#options.onWindowChange(this);
    }
    if (instanceWindowClosed) {
      this.#options.onInstanceWindowChange();
    }
  }

  /**
   * A `WS_ERR_*` error is a protocol violation `ws` has already closed the connection for
   * (`receiverOnError` sends the close frame before it emits the error). Anything else is logged
   * as a connection error; `ws` swallows socket errors, so this branch is rare, and the listener
   * exists because an emitter without one throws.
   */
  #onError(error: Error): void {
    const fields = {
      err: error,
      connectionId: this.connectionId,
      remote: this.remote,
      lastDeviceId: this.#lastDeviceId,
    };
    const code = protocolErrorCode(error);
    if (code !== undefined) {
      this.#closeReason ??= 'protocol';
      this.#options.logger.warn({ ...fields, code }, 'protocol violation');
      return;
    }
    this.#closeReason ??= 'error';
    this.#options.logger.warn(fields, 'connection error');
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
