import type { Socket } from 'node:net';

import { TELEMETRY_SOCKET_PATH, encodeMessage, type TelemetryMessage } from '@telemetry/shared';
import { WebSocket } from 'ws';

/**
 * A real `ws` client in place of a device, for the socket server's tests. A real client rather than
 * a mock: pausing, the close handshake, the pong and the send buffer are protocol and kernel
 * behaviour, and a mock would only test the mock's idea of them.
 *
 * Not named `*.test.ts`: the unit project would report a file without tests as an empty suite.
 */
export type TestDevice = {
  ws: WebSocket;
  /** The device's own TCP socket, from the `'upgrade'` response: tests pause it or reset it. */
  socket: Socket;
  send(text: string): void;
  sendBinary(bytes: Buffer): void;
  sendMessage(message: TelemetryMessage): void;
  /** Pings received from the server so far. */
  pings(): number;
  /** Resolves when the connection has closed, with the code and reason the server sent (1006 when none). */
  closed: Promise<{ code: number; reason: string }>;
  close(code?: number, reason?: string): void;
  terminate(): void;
};

export function connectTestDevice({
  port,
  path = TELEMETRY_SOCKET_PATH,
  autoPong = true,
}: {
  port: number;
  path?: string;
  /** False makes a device whose software never answers pings. */
  autoPong?: boolean;
}): Promise<TestDevice> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${String(port)}${path}`, {
      perMessageDeflate: false,
      autoPong,
    });
    let socket: Socket | undefined;
    let pings = 0;
    // `ws` emits 'upgrade' and then 'open' in the same tick, so the socket is known at 'open'.
    ws.on('upgrade', (response) => {
      socket = response.socket;
    });
    ws.on('ping', () => {
      pings += 1;
    });
    const closed = new Promise<{ code: number; reason: string }>((resolveClosed) => {
      ws.once('close', (code, reason) => {
        resolveClosed({ code, reason: reason.toString() });
      });
    });
    // Before 'open' an error is a failed connection: a refused port or a rejected upgrade.
    ws.once('error', reject);
    ws.once('open', () => {
      ws.off('error', reject);
      ws.on('error', () => {
        // A reset by the server, or a destroyed socket, is part of several scenarios.
      });
      if (socket === undefined) {
        reject(new Error('unreachable: ws emits upgrade before open'));
        return;
      }
      resolve({
        ws,
        socket,
        send: (text) => {
          ws.send(text);
        },
        sendBinary: (bytes) => {
          ws.send(bytes, { binary: true });
        },
        sendMessage: (message) => {
          ws.send(encodeMessage(message));
        },
        pings: () => pings,
        closed,
        close: (code, reason) => {
          ws.close(code, reason);
        },
        terminate: () => {
          ws.terminate();
        },
      });
    });
  });
}
