import net from 'node:net';

/**
 * A real TCP server that collects newline-delimited frames, for the socket-facing tests.
 *
 * Deliberately a real server on an ephemeral port rather than a mocked socket: backpressure and
 * reconnect are the only things worth testing in `DeviceConnection`, and a mock would only test
 * the mock's idea of them. Each test starts its own sink on port 0, so the kernel picks a free
 * port and parallel test files cannot collide.
 *
 * Not named `*.test.ts`: the unit project collects `src/**\/*.test.ts`, and a helper with no
 * `test()` call in it would be reported as an empty suite.
 */
export type TestSink = {
  port: number;
  /** Every complete line received, across all connections, in arrival order. */
  lines(): string[];
  /** Resolves once `lines().length >= count`. Rejects nothing — the vitest timeout bounds it. */
  waitForLines(count: number): Promise<string[]>;
  /** Connections accepted since the sink started, including ones since closed. */
  connectionCount(): number;
  /** Destroys every open connection but keeps listening, so the client must reconnect. */
  dropConnections(): void;
  close(): Promise<void>;
};

export async function startTestSink(): Promise<TestSink> {
  const lines: string[] = [];
  const sockets = new Set<net.Socket>();
  let accepted = 0;
  let notify: (() => void) | null = null;

  const server = net.createServer((socket) => {
    accepted += 1;
    sockets.add(socket);
    let buffer = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      let index = buffer.indexOf('\n');
      while (index !== -1) {
        lines.push(buffer.slice(0, index));
        buffer = buffer.slice(index + 1);
        index = buffer.indexOf('\n');
      }
      notify?.();
    });
    socket.on('error', () => {
      // A client destroying its socket surfaces here as ECONNRESET; it is the scenario, not a fault.
    });
    socket.on('close', () => sockets.delete(socket));
  });
  server.on('error', () => {
    // Nothing to do: a listen failure surfaces through the listen promise below.
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;

  return {
    port,
    lines: () => [...lines],
    connectionCount: () => accepted,
    waitForLines: (count) =>
      new Promise<string[]>((resolve) => {
        const check = () => {
          if (lines.length >= count) {
            notify = null;
            resolve([...lines]);
          }
        };
        // Event-driven, never a sleep: this resolves on the data event that crosses the threshold.
        notify = check;
        check();
      }),
    dropConnections: () => {
      for (const socket of sockets) socket.destroy();
      sockets.clear();
    },
    close: async () => {
      // `server.close()` stops accepting but waits for existing connections to end on their own,
      // and `net.Server` has no `closeAllConnections()` (that is `http.Server`). Measured: with
      // one live connection the close callback never fired. So the sockets go first.
      for (const socket of sockets) socket.destroy();
      sockets.clear();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
