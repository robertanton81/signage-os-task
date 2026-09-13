import net from 'node:net';

import { encodeFrame, type TelemetryMessage } from '@telemetry/shared';

/**
 * A real TCP client in place of a device, for the socket server's tests. A real socket rather than a
 * mock: pausing, half-closing and the idle timeout are stream and kernel behaviour, and a mock would
 * only test the mock's idea of them.
 *
 * Not named `*.test.ts`: the unit project would report a file without tests as an empty suite.
 */
export type TestDevice = {
  socket: net.Socket;
  write(frame: string | Buffer): boolean;
  writeMessage(message: TelemetryMessage): boolean;
  /** Resolves when the server's FIN has been received (`'end'`). */
  ended: Promise<void>;
  /** Resolves when the socket has closed, whichever side closed it. */
  closed: Promise<void>;
  end(): void;
  destroy(): void;
};

export async function connectTestDevice({
  port,
  allowHalfOpen = false,
}: {
  port: number;
  /** True keeps the device's side open after the server's FIN: a device that never closes. */
  allowHalfOpen?: boolean;
}): Promise<TestDevice> {
  const socket = net.connect({ host: '127.0.0.1', port, allowHalfOpen });
  socket.on('error', () => {
    // A reset by the server is part of several scenarios (an oversized frame, the shutdown budget).
  });
  const ended = new Promise<void>((resolve) => {
    socket.once('end', () => {
      resolve();
    });
  });
  const closed = new Promise<void>((resolve) => {
    socket.once('close', () => {
      resolve();
    });
  });
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', () => {
      resolve();
    });
    socket.once('error', reject);
  });
  return {
    socket,
    write: (frame) => socket.write(frame),
    writeMessage: (message) => socket.write(encodeFrame(message)),
    ended,
    closed,
    end: () => {
      socket.end();
    },
    destroy: () => {
      socket.destroy();
    },
  };
}
