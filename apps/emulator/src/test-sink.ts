import http from 'node:http';

import { TELEMETRY_SOCKET_PATH } from '@telemetry/shared';
import { WebSocketServer, type RawData, type WebSocket } from 'ws';

/**
 * A real WebSocket server that collects text messages, for the socket-facing tests.
 *
 * Deliberately a real server on an ephemeral port rather than a mocked socket: backpressure,
 * the close handshake and reconnect are the only things worth testing in `DeviceConnection`, and a
 * mock would only test the mock's idea of them. Each test starts its own sink on port 0, so the
 * kernel picks a free port and parallel test files cannot collide.
 *
 * Not named `*.test.ts`: the unit project collects `src/**\/*.test.ts`, and a helper with no
 * `test()` call in it would be reported as an empty suite.
 */
export type TestSink = {
  port: number;
  /** Every text message received, across all connections, in arrival order. */
  messages(): string[];
  /** Resolves once `messages().length >= count`. Rejects nothing — the vitest timeout bounds it. */
  waitForMessages(count: number): Promise<string[]>;
  /** Connections accepted since the sink started, including ones since closed. */
  connectionCount(): number;
  /** Destroys every open connection but keeps listening, so the client must reconnect. */
  dropConnections(): void;
  /** Stops reading, so the client's buffers fill and its send gate closes. */
  pauseConnections(): void;
  /** Resumes reading, which lets the client's buffers drain and its send callbacks fire. */
  resumeConnections(): void;
  close(): Promise<void>;
};

function toText(data: RawData): string {
  if (Buffer.isBuffer(data)) {
    return data.toString('utf8');
  }
  if (Array.isArray(data)) {
    return Buffer.concat(data).toString('utf8');
  }
  return Buffer.from(data).toString('utf8');
}

export async function startTestSink(): Promise<TestSink> {
  const messages: string[] = [];
  const clients = new Set<WebSocket>();
  let accepted = 0;
  let paused = false;
  const waiters = new Set<() => void>();

  const server = http.createServer((_request, response) => {
    response.writeHead(404).end();
  });
  const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false });
  // eslint-disable-next-line max-params -- Node emits 'upgrade' with exactly these three positional arguments
  server.on('upgrade', (request, socket, head) => {
    socket.on('error', () => {
      // A client terminating mid-handshake is the scenario, not a fault.
    });
    if (new URL(request.url ?? '', 'http://sink').pathname !== TELEMETRY_SOCKET_PATH) {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
      accepted += 1;
      clients.add(ws);
      // A connection accepted while the sink is paused must start paused too, or a reconnecting
      // client would drain into it and the backpressure under test would disappear.
      if (paused) ws.pause();
      ws.on('message', (data) => {
        messages.push(toText(data));
        for (const waiter of [...waiters]) waiter();
      });
      ws.on('error', () => {
        // A client destroying its socket surfaces here; it is the scenario, not a fault.
      });
      ws.on('close', () => clients.delete(ws));
    });
  });
  server.on('error', () => {
    // Nothing to do: a listen failure surfaces through the listen promise below.
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;

  return {
    port,
    messages: () => [...messages],
    connectionCount: () => accepted,
    waitForMessages: (count) =>
      new Promise<string[]>((resolve) => {
        // A set of waiters rather than one slot: two concurrent waits on the same sink would
        // otherwise overwrite each other and the first would hang until the test timed out.
        const check = () => {
          if (messages.length >= count) {
            waiters.delete(check);
            resolve([...messages]);
          }
        };
        // Event-driven, never a sleep: this resolves on the message event that crosses the threshold.
        waiters.add(check);
        check();
      }),
    dropConnections: () => {
      for (const ws of clients) ws.terminate();
      clients.clear();
    },
    pauseConnections: () => {
      paused = true;
      for (const ws of clients) ws.pause();
    },
    resumeConnections: () => {
      paused = false;
      for (const ws of clients) ws.resume();
    },
    close: async () => {
      // `server.close()` waits for the upgraded sockets too (Node http docs), so they go first.
      for (const ws of clients) ws.terminate();
      clients.clear();
      wss.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
