import { setTimeout as delay } from 'node:timers/promises';

import {
  MAX_FRAME_BYTES,
  createLogger,
  encodeFrame,
  type TelemetryMessage,
} from '@telemetry/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { loadIngestConfig, type IngestConfig } from './config.js';
import type { DeviceConnection } from './connection.js';
import { exampleMessages } from './fixtures.js';
import { IngestServer } from './server.js';
import { connectTestDevice, type TestDevice } from './test-device.js';
import { createTestPublisher, type TestPublisher } from './test-publisher.js';

/** pino's numeric levels: the shared logger formats only the log object and the bindings. */
const INFO = 30;
const WARN = 40;

type LogLine = { level: number; msg: string; [field: string]: unknown };

const BASE_CONFIG: IngestConfig = {
  ...loadIngestConfig({ RABBITMQ_URL: 'amqp://127.0.0.1:1' }),
  INGEST_HOST: '127.0.0.1',
  // The kernel picks a free port. The schema's minimum of 1 guards the environment, not a test.
  INGEST_PORT: 0,
  SHUTDOWN_TIMEOUT_MS: 200,
};

type Harness = {
  server: IngestServer;
  publisher: TestPublisher;
  logs: LogLine[];
  // A function-typed property, not a method: every test destructures it (`unbound-method`).
  connect: (options?: { allowHalfOpen?: boolean }) => Promise<TestDevice>;
};

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

/** A server on its own port with its own in-memory publisher and a log that records every line. */
async function startServer({
  config = {},
  ready = true,
}: { config?: Partial<IngestConfig>; ready?: boolean } = {}): Promise<Harness> {
  const logs: LogLine[] = [];
  const logger = createLogger({
    service: 'test',
    level: 'debug',
    destination: {
      write: (line: string) => {
        logs.push(JSON.parse(line) as LogLine);
      },
    },
  });
  const publisher = createTestPublisher({ ready });
  const server = new IngestServer({
    config: { ...BASE_CONFIG, ...config },
    publisher: publisher.port,
    logger,
  });
  const { port } = await server.listen();
  const devices: TestDevice[] = [];
  cleanups.push(async () => {
    for (const device of devices) {
      device.destroy();
    }
    // A socket paused since it was accepted does not notice its peer's close, so every socket
    // reads again and nothing waits for a confirm; the drain then ends as the sockets close.
    publisher.setReady(true);
    publisher.confirmAll();
    await server.shutdown();
  });
  return {
    server,
    publisher,
    logs,
    connect: async (options = {}) => {
      const device = await connectTestDevice({ port, ...options });
      devices.push(device);
      return device;
    },
  };
}

function metrics(seq: number): TelemetryMessage {
  return { ...exampleMessages.metrics, seq };
}

function linesWith(logs: readonly LogLine[], msg: string): LogLine[] {
  return logs.filter((line) => line.msg === msg);
}

/**
 * The server registers a connection on its own `connection` event, which can run after the
 * client's `connect`, so the registry is polled until it holds `count` connections.
 */
async function connectionsOf(
  server: IngestServer,
  count: number,
): Promise<readonly DeviceConnection[]> {
  await vi.waitFor(() => {
    expect(server.connections()).toHaveLength(count);
  });
  return server.connections();
}

async function onlyConnection(server: IngestServer): Promise<DeviceConnection> {
  const [connection] = await connectionsOf(server, 1);
  if (connection === undefined) {
    throw new Error('unreachable: connectionsOf checked the length');
  }
  return connection;
}

describe('IngestServer', () => {
  it('publishes valid frames in arrival order, each with the time it was received', async () => {
    const { publisher, connect } = await startServer();
    const device = await connect();
    const before = Date.now();
    device.writeMessage(exampleMessages.status);
    device.writeMessage(exampleMessages.metrics);

    const requests = await publisher.waitForRequests(2);
    expect(requests.map((request) => request.message)).toEqual([
      exampleMessages.status,
      exampleMessages.metrics,
    ]);
    for (const request of requests) {
      expect(request.receivedAt).toBeGreaterThanOrEqual(before);
      expect(request.receivedAt).toBeLessThanOrEqual(Date.now());
    }
  });

  it('logs an invalid frame with its reason, drops it and keeps the connection open', async () => {
    const { server, publisher, logs, connect } = await startServer();
    const device = await connect();
    device.write('not json\n');
    device.write('{"v":1,"deviceId":"dev-0009","type":"bogus"}\n');
    device.writeMessage(exampleMessages.counters);

    const [request] = await publisher.waitForRequests(1);
    expect(request?.message).toEqual(exampleMessages.counters);
    expect(publisher.requests).toHaveLength(1);
    const rejected = linesWith(logs, 'frame rejected');
    expect(rejected.map((line) => [line.level, line.reason])).toEqual([
      [WARN, 'invalid_json'],
      [WARN, 'invalid_schema'],
    ]);
    // The schema violation still carries the device id it claimed, for the operator.
    expect(rejected[1]?.deviceId).toBe('dev-0009');
    const connection = await onlyConnection(server);
    expect([connection.received, connection.rejected]).toEqual([1, 2]);
  });

  it('closes a connection whose line exceeds the frame limit, after publishing the frame before it', async () => {
    const { server, publisher, logs, connect } = await startServer();
    const device = await connect();
    const connection = await onlyConnection(server);
    device.write(
      Buffer.concat([
        encodeFrame(exampleMessages.status),
        Buffer.alloc(MAX_FRAME_BYTES + 1, 0x61),
        Buffer.from('\n'),
      ]),
    );

    await device.closed;
    const [request] = await publisher.waitForRequests(1);
    expect(request?.message).toEqual(exampleMessages.status);
    await vi.waitFor(() => {
      expect(linesWith(logs, 'connection closed')[0]?.reason).toBe('frame_too_long');
    });
    const [tooLong] = linesWith(logs, 'frame too long');
    expect(tooLong).toMatchObject({
      level: WARN,
      connectionId: connection.connectionId,
      remote: connection.remote,
      limit: MAX_FRAME_BYTES,
    });
    expect(Number(tooLong?.bytes)).toBeGreaterThan(MAX_FRAME_BYTES);
  });

  it('publishes a frame split across two chunks once', async () => {
    const { server, publisher, connect } = await startServer();
    const device = await connect();
    const connection = await onlyConnection(server);
    const bytes = encodeFrame(exampleMessages.diagnostic);
    device.write(bytes.subarray(0, 20));
    // The first part has been read before the rest is written, so the frame spans two chunks.
    await vi.waitFor(() => {
      expect(connection.pendingBytes).toBe(20);
    });
    device.write(bytes.subarray(20));
    device.writeMessage(exampleMessages.status);

    const requests = await publisher.waitForRequests(2);
    expect(requests.map((request) => request.message)).toEqual([
      exampleMessages.diagnostic,
      exampleMessages.status,
    ]);
  });

  it('reads no socket while the publisher is not ready, and every socket while it is', async () => {
    const { server, publisher, connect } = await startServer({ ready: false });
    const first = await connect();
    await connect();
    const connections = await connectionsOf(server, 2);
    first.writeMessage(exampleMessages.status);

    for (const connection of connections) {
      expect(connection.isReading).toBe(false);
      expect(connection.socket.readableFlowing).toBe(false);
      // No idle timer while paused: a broker outage must not disconnect devices (decision 4).
      expect(connection.socket.timeout).toBe(0);
    }

    publisher.setReady(true);
    for (const connection of connections) {
      expect(connection.isReading).toBe(true);
      expect(connection.socket.timeout).toBe(BASE_CONFIG.INGEST_SOCKET_IDLE_MS);
    }
    const [request] = await publisher.waitForRequests(1);
    expect(request?.message).toEqual(exampleMessages.status);

    publisher.setReady(false);
    for (const connection of connections) {
      expect(connection.isReading).toBe(false);
      expect(connection.socket.readableFlowing).toBe(false);
      expect(connection.socket.timeout).toBe(0);
    }
  });

  it('pauses a socket when its own window fills and resumes it at half the cap', async () => {
    const { server, publisher, connect } = await startServer({
      config: { INGEST_MAX_UNCONFIRMED: 2 },
    });
    const device = await connect();
    const connection = await onlyConnection(server);
    device.writeMessage(metrics(1));
    await publisher.waitForRequests(1);
    expect(connection.isReading).toBe(true);
    device.writeMessage(metrics(2));
    await publisher.waitForRequests(2);
    expect(connection.isReading).toBe(false);
    expect(connection.socket.readableFlowing).toBe(false);

    device.writeMessage(metrics(3));
    expect(publisher.requests).toHaveLength(2);
    // A cap of 2 reopens at Math.floor(2 / 2) = 1, so one confirm is enough.
    publisher.confirm(0);
    expect(connection.isReading).toBe(true);
    const requests = await publisher.waitForRequests(3);
    expect(requests.map((request) => request.message.seq)).toEqual([1, 2, 3]);
  });

  it('publishes every frame of a chunk that fills its window, and pauses only after it', async () => {
    const { server, publisher, connect } = await startServer({
      ready: false,
      config: { INGEST_MAX_UNCONFIRMED: 1 },
    });
    const device = await connect();
    const connection = await onlyConnection(server);
    // Written while nothing reads the socket, so the first read after readiness takes all three
    // frames as one chunk: the window closes on the first frame and the other two still go out.
    await new Promise<void>((resolve) => {
      const frames = [metrics(1), metrics(2), metrics(3)].map((message) => encodeFrame(message));
      device.socket.write(Buffer.concat(frames), () => {
        resolve();
      });
    });
    publisher.setReady(true);

    const requests = await publisher.waitForRequests(3);
    expect(requests.map((request) => request.message.seq)).toEqual([1, 2, 3]);
    expect(connection.isReading).toBe(false);
  });

  it('pauses every socket when the instance window fills, and resumes every socket when it reopens', async () => {
    const { server, publisher, connect } = await startServer({
      config: { INGEST_MAX_UNCONFIRMED_TOTAL: 2 },
    });
    const a = await connect();
    const b = await connect();
    const connections = await connectionsOf(server, 2);
    expect(connections[0]?.connectionId).not.toBe(connections[1]?.connectionId);
    a.writeMessage(metrics(1));
    await publisher.waitForRequests(1);
    expect(connections.map((connection) => connection.isReading)).toEqual([true, true]);
    b.writeMessage(metrics(2));
    await publisher.waitForRequests(2);
    expect(connections.map((connection) => connection.isReading)).toEqual([false, false]);

    publisher.confirm(0);
    expect(connections.map((connection) => connection.isReading)).toEqual([true, true]);
  });

  it('closes a silent reading socket after the idle timeout', async () => {
    const { logs, connect } = await startServer({ config: { INGEST_SOCKET_IDLE_MS: 50 } });
    const device = await connect();

    await device.closed;
    await vi.waitFor(() => {
      expect(linesWith(logs, 'connection closed')[0]?.reason).toBe('idle');
    });
  });

  it('never closes a paused socket for being idle', async () => {
    const { server, connect } = await startServer({
      config: { INGEST_SOCKET_IDLE_MS: 50 },
      ready: false,
    });
    const device = await connect();
    const connection = await onlyConnection(server);

    // The one timed wait in this file: the assertion is that nothing happens. 200 ms is four idle
    // timeouts.
    await delay(200);
    expect(server.connections()).toEqual([connection]);
    expect(device.socket.destroyed).toBe(false);
  });

  it('closes a connection with reason error when the device resets it, naming the device', async () => {
    const { server, publisher, logs, connect } = await startServer();
    const device = await connect();
    const connection = await onlyConnection(server);
    device.writeMessage(exampleMessages.status);
    await publisher.waitForRequests(1);

    device.socket.resetAndDestroy();

    await connectionsOf(server, 0);
    expect(linesWith(logs, 'connection error')).toEqual([
      expect.objectContaining({
        level: WARN,
        connectionId: connection.connectionId,
        lastDeviceId: 'dev-0001',
      }),
    ]);
    expect(linesWith(logs, 'connection closed')[0]?.reason).toBe('error');
  });

  it('frees the instance window when a message of a closed connection is confirmed', async () => {
    const { server, publisher, connect } = await startServer({
      config: { INGEST_MAX_UNCONFIRMED_TOTAL: 1 },
    });
    const a = await connect();
    const b = await connect();
    await connectionsOf(server, 2);
    a.writeMessage(metrics(1));
    await publisher.waitForRequests(1);
    a.destroy();
    const [connectionB] = await connectionsOf(server, 1);
    expect(connectionB?.isReading).toBe(false);

    publisher.confirm(0);
    expect(connectionB?.isReading).toBe(true);
    b.writeMessage(metrics(2));
    const requests = await publisher.waitForRequests(2);
    expect(requests[1]?.message.seq).toBe(2);
  });

  it('half-closes every connection on shutdown and finishes once the devices have closed', async () => {
    const { server, logs, connect } = await startServer({ config: { SHUTDOWN_TIMEOUT_MS: 2_000 } });
    const first = await connect();
    const second = await connect();
    await connectionsOf(server, 2);

    const started = performance.now();
    expect(await server.shutdown()).toEqual({ openConnections: 0, unconfirmed: 0 });
    expect(performance.now() - started).toBeLessThan(1_000);
    await Promise.all([first.ended, second.ended]);
    expect(logs.filter((line) => line.level === WARN)).toEqual([]);
  });

  it('keeps reading a half-closed connection during the drain', async () => {
    const { server, publisher, connect } = await startServer({
      config: { SHUTDOWN_TIMEOUT_MS: 2_000 },
    });
    const device = await connect({ allowHalfOpen: true });
    await onlyConnection(server);

    const drained = server.shutdown();
    await device.ended;
    // Written after the server's FIN: decision 19 half-closes so that a frame like this is still read.
    device.writeMessage(exampleMessages.status);
    const [request] = await publisher.waitForRequests(1);
    expect(request?.message).toEqual(exampleMessages.status);
    publisher.confirm(0);
    device.end();

    expect(await drained).toEqual({ openConnections: 0, unconfirmed: 0 });
  });

  it('reads what a paused socket holds when the publisher becomes ready during the drain', async () => {
    const { server, publisher, connect } = await startServer({
      ready: false,
      config: { SHUTDOWN_TIMEOUT_MS: 2_000 },
    });
    const device = await connect();
    await onlyConnection(server);
    await new Promise<void>((resolve) => {
      device.socket.write(encodeFrame(exampleMessages.status), () => {
        resolve();
      });
    });

    const drained = server.shutdown();
    // The device got the FIN and closed its side; the paused socket has read nothing yet.
    await device.ended;
    expect(publisher.requests).toHaveLength(0);
    // The broker comes back during the drain. Shutdown is not an input of the reading rule
    // (decision 19), so the socket reads the frame, then the device's close.
    publisher.setReady(true);
    const [request] = await publisher.waitForRequests(1);
    expect(request?.message).toEqual(exampleMessages.status);
    publisher.confirm(0);

    expect(await drained).toEqual({ openConnections: 0, unconfirmed: 0 });
  });

  it('destroys the connections still open when the drain budget runs out, with one warn line', async () => {
    const { server, logs, connect } = await startServer({ config: { SHUTDOWN_TIMEOUT_MS: 100 } });
    const device = await connect({ allowHalfOpen: true });
    await onlyConnection(server);

    expect(await server.shutdown()).toEqual({ openConnections: 1, unconfirmed: 0 });
    // The device got the server's FIN and kept its own side open, so only the budget ended the wait.
    // Its own `closed` is not awaited: destroying a half-closed socket with nothing unread sends no
    // RST, so such a device learns of it only when it writes again.
    await device.ended;
    const warnings = logs.filter((line) => line.level === WARN);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({ openConnections: 1, unconfirmed: 0 });
    await connectionsOf(server, 0);
    expect(linesWith(logs, 'connection closed')[0]?.reason).toBe('shutdown');
  });

  it('finishes a shutdown at once when no device is connected and nothing waits for a confirm', async () => {
    const { server, logs } = await startServer({ config: { SHUTDOWN_TIMEOUT_MS: 2_000 } });

    const started = performance.now();
    const drained = server.shutdown();
    expect(server.shutdown()).toBe(drained);
    expect(await drained).toEqual({ openConnections: 0, unconfirmed: 0 });
    expect(performance.now() - started).toBeLessThan(50);
    expect(logs.filter((line) => line.level === WARN)).toEqual([]);
  });

  it('finishes the drain on the confirm that empties the ledger, though no window reopens', async () => {
    const { server, publisher, connect } = await startServer({
      config: { INGEST_MAX_UNCONFIRMED: 256, SHUTDOWN_TIMEOUT_MS: 2_000 },
    });
    const device = await connect();
    for (let seq = 1; seq <= 3; seq += 1) device.writeMessage(metrics(seq));
    await publisher.waitForRequests(3);
    device.end();
    await connectionsOf(server, 0);

    const drained = server.shutdown();
    // Three messages still wait for a confirm, so the drain must not have finished yet.
    expect(await Promise.race([drained, Promise.resolve('pending')])).toBe('pending');
    const started = performance.now();
    publisher.confirmAll();
    expect(await drained).toEqual({ openConnections: 0, unconfirmed: 0 });
    expect(performance.now() - started).toBeLessThan(500);
  });

  it('logs the accept and the close of a connection, and counts it while open and after it closed', async () => {
    const { server, publisher, logs, connect } = await startServer();
    const device = await connect();
    const connection = await onlyConnection(server);
    device.writeMessage(exampleMessages.status);
    device.write('not json\n');
    const partial = '{"partial';
    device.write(partial);
    await publisher.waitForRequests(1);
    await vi.waitFor(() => {
      expect(connection.pendingBytes).toBe(partial.length);
    });
    // Counted from the open connection now, and kept by the server after it has closed.
    expect(server.stats()).toEqual({ open: 1, reading: 1, received: 1, rejected: 1 });
    expect(connection.remote).toBe(`127.0.0.1:${String(device.socket.localPort)}`);
    device.end();

    await connectionsOf(server, 0);
    expect(linesWith(logs, 'connection accepted')).toEqual([
      expect.objectContaining({
        level: INFO,
        connectionId: connection.connectionId,
        remote: connection.remote,
      }),
    ]);
    expect(linesWith(logs, 'connection closed')[0]).toMatchObject({
      level: INFO,
      connectionId: connection.connectionId,
      remote: connection.remote,
      lastDeviceId: 'dev-0001',
      received: 1,
      rejected: 1,
      pendingBytes: partial.length,
      reason: 'end',
    });
    expect(server.stats()).toEqual({ open: 0, reading: 0, received: 1, rejected: 1 });
  });
});
