import { setTimeout as delay } from 'node:timers/promises';

import { MAX_FRAME_BYTES, createLogger, type TelemetryMessage } from '@telemetry/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';

import { loadIngestConfig, type IngestConfig } from './config.js';
import type { DeviceConnection } from './connection.js';
import { exampleMessages } from './fixtures.js';
import { IngestServer } from './server.js';
import { connectTestDevice, type TestDevice } from './test-device.js';
import { createTestPublisher, type TestPublisher } from './test-publisher.js';

/** pino's numeric levels: the shared logger formats only the log object and the bindings. */
const DEBUG = 20;
const INFO = 30;
const WARN = 40;

/** Close codes of RFC 6455 §7.4.1 as the tests expect them. */
const NORMAL_CLOSURE = 1000;
const GOING_AWAY = 1001;
const UNSUPPORTED_DATA = 1003;
const ABNORMAL_CLOSURE = 1006;
const MESSAGE_TOO_BIG = 1009;

type LogLine = { level: number; msg: string; [field: string]: unknown };

const BASE_CONFIG: IngestConfig = {
  ...loadIngestConfig({ RABBITMQ_URL: 'amqp://127.0.0.1:1' }),
  INGEST_HOST: '127.0.0.1',
  // The kernel picks a free port. The schema's minimum of 1 guards the environment, not a test.
  INGEST_PORT: 0,
  SHUTDOWN_TIMEOUT_MS: 200,
};

/**
 * Slack for a lower bound measured across a timer: Node makes no guarantee about the exact timing
 * of a timer, and one measured by `performance.now()` can fire a fraction of a millisecond before
 * its delay (299.94 ms for a 300 ms budget on the CI runner, 2026-09-15).
 */
const TIMER_TOLERANCE_MS = 5;

type ConnectOptions = { path?: string; autoPong?: boolean };

type Harness = {
  server: IngestServer;
  publisher: TestPublisher;
  logs: LogLine[];
  port: number;
  // A function-typed property, not a method: every test destructures it (`unbound-method`).
  connect: (options?: ConnectOptions) => Promise<TestDevice>;
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
      device.socket.resume();
      device.terminate();
    }
    // A connection paused since it was accepted does not notice its peer's close, so every
    // connection reads again and nothing waits for a confirm; the drain then ends as they close.
    publisher.setReady(true);
    publisher.confirmAll();
    await server.shutdown();
  });
  return {
    server,
    publisher,
    logs,
    port,
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

function warnings(logs: readonly LogLine[]): LogLine[] {
  return logs.filter((line) => line.level === WARN);
}

/**
 * The server registers a connection in the `handleUpgrade` callback, which can run after the
 * client's `open`, so the registry is polled until it holds `count` connections.
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
  it('publishes valid messages in arrival order, each with the time it was received', async () => {
    const { publisher, connect } = await startServer();
    const device = await connect();
    const before = Date.now();
    device.sendMessage(exampleMessages.status);
    device.sendMessage(exampleMessages.metrics);

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

  it('logs an invalid message with its reason, drops it and keeps the connection open', async () => {
    const { server, publisher, logs, connect } = await startServer();
    const device = await connect();
    device.send('not json');
    device.send('{"v":1,"deviceId":"dev-0009","type":"bogus"}');
    device.sendMessage(exampleMessages.counters);

    const [request] = await publisher.waitForRequests(1);
    expect(request?.message).toEqual(exampleMessages.counters);
    expect(publisher.requests).toHaveLength(1);
    const rejected = linesWith(logs, 'message rejected');
    expect(rejected.map((line) => [line.level, line.reason])).toEqual([
      [WARN, 'invalid_json'],
      [WARN, 'invalid_schema'],
    ]);
    // The schema violation still carries the device id it claimed, for the operator.
    expect(rejected[1]?.deviceId).toBe('dev-0009');
    const connection = await onlyConnection(server);
    expect([connection.received, connection.rejected]).toEqual([1, 2]);
    expect(device.ws.readyState).toBe(WebSocket.OPEN);
  });

  it('closes a connection that sends a binary message with code 1003, after counting it', async () => {
    const { server, logs, connect } = await startServer();
    const device = await connect();
    const connection = await onlyConnection(server);
    device.sendBinary(Buffer.from([1, 2, 3]));

    expect(await device.closed).toEqual({ code: UNSUPPORTED_DATA, reason: 'text messages only' });
    await connectionsOf(server, 0);
    expect(linesWith(logs, 'binary message rejected')).toEqual([
      expect.objectContaining({ level: WARN, connectionId: connection.connectionId, bytes: 3 }),
    ]);
    expect(linesWith(logs, 'connection closed')[0]).toMatchObject({
      reason: 'binary',
      closeCode: UNSUPPORTED_DATA,
    });
    expect(server.stats()).toMatchObject({ open: 0, rejected: 1 });
  });

  it('drops a valid message that arrives in the same read as a binary one, after deciding to close', async () => {
    // A plain `ws.close()` does not stop `ws` from parsing the rest of the read, unlike a protocol
    // error, and one read can hold several messages. Sent while the connection is paused, the two
    // messages are read together once the publisher is ready.
    const { server, publisher, logs, connect } = await startServer({ ready: false });
    const device = await connect();
    const connection = await onlyConnection(server);
    device.sendBinary(Buffer.from([1, 2, 3]));
    device.sendMessage(exampleMessages.status);
    await vi.waitFor(() => {
      expect(device.ws.bufferedAmount).toBe(0);
    });

    publisher.setReady(true);

    expect((await device.closed).code).toBe(UNSUPPORTED_DATA);
    await connectionsOf(server, 0);
    expect(publisher.requests).toEqual([]);
    expect([connection.received, connection.rejected]).toEqual([0, 1]);
    expect(linesWith(logs, 'binary message rejected')).toHaveLength(1);
    expect(linesWith(logs, 'message rejected')).toEqual([]);
  });

  it('closes a connection whose message exceeds the limit, after publishing the one before it', async () => {
    const { server, publisher, logs, connect } = await startServer();
    const device = await connect();
    const connection = await onlyConnection(server);
    device.sendMessage(exampleMessages.status);
    device.send('a'.repeat(MAX_FRAME_BYTES + 1));

    expect((await device.closed).code).toBe(MESSAGE_TOO_BIG);
    const [request] = await publisher.waitForRequests(1);
    expect(request?.message).toEqual(exampleMessages.status);
    await connectionsOf(server, 0);
    expect(linesWith(logs, 'protocol violation')).toEqual([
      expect.objectContaining({
        level: WARN,
        code: 'WS_ERR_UNSUPPORTED_MESSAGE_LENGTH',
        connectionId: connection.connectionId,
        remote: connection.remote,
        lastDeviceId: 'dev-0001',
      }),
    ]);
    // `ws` ends the socket right after its own close frame, so no close frame comes back.
    expect(linesWith(logs, 'connection closed')[0]).toMatchObject({
      reason: 'protocol',
      closeCode: ABNORMAL_CLOSURE,
    });
  });

  it('reads no connection while the publisher is not ready, and every connection while it is', async () => {
    const { server, publisher, connect } = await startServer({ ready: false });
    const first = await connect();
    await connect();
    const connections = await connectionsOf(server, 2);
    first.sendMessage(exampleMessages.status);

    for (const connection of connections) {
      expect(connection.isReading).toBe(false);
      expect(connection.ws.isPaused).toBe(true);
    }
    expect(publisher.requests).toHaveLength(0);

    publisher.setReady(true);
    for (const connection of connections) {
      expect(connection.isReading).toBe(true);
      expect(connection.ws.isPaused).toBe(false);
    }
    const [request] = await publisher.waitForRequests(1);
    expect(request?.message).toEqual(exampleMessages.status);

    publisher.setReady(false);
    for (const connection of connections) {
      expect(connection.isReading).toBe(false);
      expect(connection.ws.isPaused).toBe(true);
    }
  });

  it('pauses a connection when its own window fills and resumes it at half the cap', async () => {
    const { server, publisher, connect } = await startServer({
      config: { INGEST_MAX_UNCONFIRMED: 2 },
    });
    const device = await connect();
    const connection = await onlyConnection(server);
    device.sendMessage(metrics(1));
    await publisher.waitForRequests(1);
    expect(connection.isReading).toBe(true);
    device.sendMessage(metrics(2));
    await publisher.waitForRequests(2);
    expect(connection.isReading).toBe(false);
    expect(connection.ws.isPaused).toBe(true);

    device.sendMessage(metrics(3));
    expect(publisher.requests).toHaveLength(2);
    // A cap of 2 reopens at Math.floor(2 / 2) = 1, so one confirm is enough.
    publisher.confirm(0);
    expect(connection.isReading).toBe(true);
    const requests = await publisher.waitForRequests(3);
    expect(requests.map((request) => request.message.seq)).toEqual([1, 2, 3]);
  });

  it('publishes every message of one read that fills its window, and pauses only after it', async () => {
    const { server, publisher, connect } = await startServer({
      ready: false,
      config: { INGEST_MAX_UNCONFIRMED: 1 },
    });
    const device = await connect();
    const connection = await onlyConnection(server);
    // Sent while nothing reads the connection, so the first read after readiness takes all three
    // messages as one chunk: the window closes on the first and the other two still go out.
    for (const seq of [1, 2, 3]) device.sendMessage(metrics(seq));
    await vi.waitFor(() => {
      expect(device.ws.bufferedAmount).toBe(0);
    });
    publisher.setReady(true);

    const requests = await publisher.waitForRequests(3);
    expect(requests.map((request) => request.message.seq)).toEqual([1, 2, 3]);
    expect(connection.isReading).toBe(false);
  });

  it('pauses every connection when the instance window fills, and resumes every connection when it reopens', async () => {
    const { server, publisher, connect } = await startServer({
      config: { INGEST_MAX_UNCONFIRMED_TOTAL: 2 },
    });
    const a = await connect();
    const b = await connect();
    const connections = await connectionsOf(server, 2);
    expect(connections[0]?.connectionId).not.toBe(connections[1]?.connectionId);
    a.sendMessage(metrics(1));
    await publisher.waitForRequests(1);
    expect(connections.map((connection) => connection.isReading)).toEqual([true, true]);
    b.sendMessage(metrics(2));
    await publisher.waitForRequests(2);
    expect(connections.map((connection) => connection.isReading)).toEqual([false, false]);

    publisher.confirm(0);
    expect(connections.map((connection) => connection.isReading)).toEqual([true, true]);
  });

  it('closes a reading connection that does not answer pings, within two intervals', async () => {
    const { logs, connect } = await startServer({ config: { INGEST_PING_INTERVAL_MS: 50 } });
    const started = performance.now();
    const device = await connect({ autoPong: false });

    // `terminate()` sends no close frame, so the device sees an abnormal closure.
    expect((await device.closed).code).toBe(ABNORMAL_CLOSURE);
    expect(performance.now() - started).toBeLessThan(500);
    await vi.waitFor(() => {
      expect(linesWith(logs, 'connection closed')[0]?.reason).toBe('unresponsive');
    });
  });

  it('keeps a connection that answers pings', async () => {
    const { server, connect } = await startServer({ config: { INGEST_PING_INTERVAL_MS: 50 } });
    const device = await connect();
    const connection = await onlyConnection(server);

    await vi.waitFor(() => {
      expect(device.pings()).toBeGreaterThanOrEqual(3);
    });
    expect(server.connections()).toEqual([connection]);
    expect(device.ws.readyState).toBe(WebSocket.OPEN);
  });

  it('never pings a paused connection', async () => {
    const { server, publisher, connect } = await startServer({
      config: { INGEST_PING_INTERVAL_MS: 50 },
      ready: false,
    });
    const device = await connect();
    const connection = await onlyConnection(server);

    // One of the file's two bounded absence checks: the assertion is that nothing happens. 250 ms
    // is five intervals.
    await delay(250);
    expect(device.pings()).toBe(0);
    expect(server.connections()).toEqual([connection]);

    // Pings start with reading.
    publisher.setReady(true);
    await vi.waitFor(() => {
      expect(device.pings()).toBeGreaterThanOrEqual(1);
    });
  });

  it('closes a connection with reason end and code 1006 when the device resets it, naming the device', async () => {
    const { server, publisher, logs, connect } = await startServer();
    const device = await connect();
    const connection = await onlyConnection(server);
    device.sendMessage(exampleMessages.status);
    await publisher.waitForRequests(1);

    device.socket.resetAndDestroy();

    await connectionsOf(server, 0);
    // `ws` swallows the socket error and reports a close with 1006; nothing is worth a warning.
    expect(warnings(logs)).toEqual([]);
    expect(linesWith(logs, 'connection closed')[0]).toMatchObject({
      connectionId: connection.connectionId,
      lastDeviceId: 'dev-0001',
      reason: 'end',
      closeCode: ABNORMAL_CLOSURE,
    });
  });

  it("closes with reason end and the device's code when the device closes normally", async () => {
    const { server, logs, connect } = await startServer();
    const device = await connect();
    await onlyConnection(server);

    device.close(NORMAL_CLOSURE, 'device stopping');

    await connectionsOf(server, 0);
    expect(linesWith(logs, 'connection closed')[0]).toMatchObject({
      reason: 'end',
      closeCode: NORMAL_CLOSURE,
    });
    expect(warnings(logs)).toEqual([]);
  });

  it('frees the instance window when a message of a closed connection is confirmed', async () => {
    const { server, publisher, connect } = await startServer({
      config: { INGEST_MAX_UNCONFIRMED_TOTAL: 1 },
    });
    const a = await connect();
    const b = await connect();
    await connectionsOf(server, 2);
    a.sendMessage(metrics(1));
    await publisher.waitForRequests(1);
    a.terminate();
    const [connectionB] = await connectionsOf(server, 1);
    expect(connectionB?.isReading).toBe(false);

    publisher.confirm(0);
    expect(connectionB?.isReading).toBe(true);
    b.sendMessage(metrics(2));
    const requests = await publisher.waitForRequests(2);
    expect(requests[1]?.message.seq).toBe(2);
  });

  it('sends close code 1001 to every device on shutdown and finishes once they have closed', async () => {
    const { server, logs, connect } = await startServer({ config: { SHUTDOWN_TIMEOUT_MS: 2_000 } });
    const first = await connect();
    const second = await connect();
    await connectionsOf(server, 2);

    const started = performance.now();
    expect(await server.shutdown()).toEqual({ openConnections: 0, unconfirmed: 0 });
    expect(performance.now() - started).toBeLessThan(1_000);
    const closes = await Promise.all([first.closed, second.closed]);
    expect(closes).toEqual([
      { code: GOING_AWAY, reason: 'ingest shutting down' },
      { code: GOING_AWAY, reason: 'ingest shutting down' },
    ]);
    expect(warnings(logs)).toEqual([]);
  });

  it('publishes what a paused connection holds when the publisher becomes ready during the drain, then closes it', async () => {
    const { server, publisher, connect } = await startServer({
      ready: false,
      config: { SHUTDOWN_TIMEOUT_MS: 2_000 },
    });
    const device = await connect();
    await onlyConnection(server);
    device.sendMessage(exampleMessages.status);
    await vi.waitFor(() => {
      expect(device.ws.bufferedAmount).toBe(0);
    });

    const drained = server.shutdown();
    // The close frame is written to the paused connection; nothing has been read yet.
    expect(publisher.requests).toHaveLength(0);
    // The broker comes back during the drain. Shutdown is not an input of the reading rule
    // (decision 19), so the connection reads the message, then the device's close reply.
    publisher.setReady(true);
    const [request] = await publisher.waitForRequests(1);
    expect(request?.message).toEqual(exampleMessages.status);
    publisher.confirm(0);

    expect(await drained).toEqual({ openConnections: 0, unconfirmed: 0 });
    expect(await device.closed).toEqual({ code: GOING_AWAY, reason: 'ingest shutting down' });
  });

  it('destroys the connections still open when the drain budget runs out, with one warn line', async () => {
    const { server, logs, connect } = await startServer({ config: { SHUTDOWN_TIMEOUT_MS: 100 } });
    const device = await connect();
    await onlyConnection(server);
    // A device that never reads the close frame, so it never replies and the handshake never ends.
    device.socket.pause();

    expect(await server.shutdown()).toEqual({ openConnections: 1, unconfirmed: 0 });
    expect(warnings(logs)).toEqual([
      expect.objectContaining({
        msg: 'shutdown drain ended at its budget',
        openConnections: 1,
        unconfirmed: 0,
      }),
    ]);
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
    expect(warnings(logs)).toEqual([]);
  });

  it('finishes the drain on the confirm that empties the ledger, though no window reopens', async () => {
    const { server, publisher, connect } = await startServer({
      config: { INGEST_MAX_UNCONFIRMED: 256, SHUTDOWN_TIMEOUT_MS: 2_000 },
    });
    const device = await connect();
    for (let seq = 1; seq <= 3; seq += 1) device.sendMessage(metrics(seq));
    await publisher.waitForRequests(3);
    device.close(NORMAL_CLOSURE);
    await connectionsOf(server, 0);

    const drained = server.shutdown();
    // Three messages still wait for a confirm, so the drain must not have finished yet.
    expect(await Promise.race([drained, Promise.resolve('pending')])).toBe('pending');
    const started = performance.now();
    publisher.confirmAll();
    expect(await drained).toEqual({ openConnections: 0, unconfirmed: 0 });
    expect(performance.now() - started).toBeLessThan(500);
  });

  it('answers 404 to an upgrade on another path and to a plain HTTP request', async () => {
    const { server, logs, port, connect } = await startServer();

    await expect(connect({ path: '/other' })).rejects.toThrow('Unexpected server response: 404');
    expect(linesWith(logs, 'upgrade rejected')).toEqual([
      expect.objectContaining({ level: DEBUG, path: '/other' }),
    ]);

    const response = await fetch(`http://127.0.0.1:${String(port)}/telemetry`);
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({});
    expect(server.connections()).toEqual([]);
  });

  it('logs the accept and the close of a connection, and counts it while open and after it closed', async () => {
    const { server, publisher, logs, connect } = await startServer();
    const device = await connect();
    const connection = await onlyConnection(server);
    device.sendMessage(exampleMessages.status);
    device.send('not json');
    await publisher.waitForRequests(1);
    await vi.waitFor(() => {
      expect(connection.rejected).toBe(1);
    });
    // Counted from the open connection now, and kept by the server after it has closed.
    expect(server.stats()).toEqual({ open: 1, reading: 1, received: 1, rejected: 1 });
    expect(connection.remote).toBe(`127.0.0.1:${String(device.socket.localPort)}`);
    device.close(NORMAL_CLOSURE);

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
      closeCode: NORMAL_CLOSURE,
      reason: 'end',
    });
    expect(server.stats()).toEqual({ open: 0, reading: 0, received: 1, rejected: 1 });
  });

  it('never pings a closing connection, so a device that stops answering after the close frame is ended by the budget, not as unresponsive', async () => {
    const { server, publisher, logs, connect } = await startServer({
      config: { INGEST_PING_INTERVAL_MS: 50, SHUTDOWN_TIMEOUT_MS: 300 },
      ready: false,
    });
    const device = await connect();
    await onlyConnection(server);
    // The device reads neither pings nor the close frame from here on.
    device.socket.pause();

    const started = performance.now();
    const drained = server.shutdown();
    // Reading starts, so pings would start too — but the connection is closing.
    publisher.setReady(true);

    expect(await drained).toEqual({ openConnections: 1, unconfirmed: 0 });
    // The ping would have ended the connection at about 100 ms (two intervals); the budget did.
    expect(performance.now() - started).toBeGreaterThanOrEqual(300 - TIMER_TOLERANCE_MS);
    await connectionsOf(server, 0);
    expect(linesWith(logs, 'connection closed')[0]?.reason).toBe('shutdown');
  });

  it('never pings a connection it is closing itself, so a device that stops answering after a 1003 closes with reason binary', async () => {
    const { server, logs, connect } = await startServer({
      config: { INGEST_PING_INTERVAL_MS: 50 },
    });
    const device = await connect();
    const connection = await onlyConnection(server);
    // The device reads neither pings nor the close frame until it resumes.
    device.socket.pause();
    device.sendBinary(Buffer.from([1]));
    await vi.waitFor(() => {
      expect(linesWith(logs, 'binary message rejected')).toHaveLength(1);
    });

    // The other bounded absence check: five intervals in which nothing may happen.
    await delay(250);
    expect(server.connections()).toEqual([connection]);
    expect(linesWith(logs, 'connection closed')).toEqual([]);
    expect(device.pings()).toBe(0);

    device.socket.resume();
    expect((await device.closed).code).toBe(UNSUPPORTED_DATA);
    await connectionsOf(server, 0);
    expect(linesWith(logs, 'connection closed')[0]).toMatchObject({
      reason: 'binary',
      closeCode: UNSUPPORTED_DATA,
    });
  });

  it('ends a connection that was already closing on its own at the budget, with its own reason', async () => {
    const { server, logs, connect } = await startServer({ config: { SHUTDOWN_TIMEOUT_MS: 200 } });
    const device = await connect();
    await onlyConnection(server);
    device.socket.pause();
    device.sendBinary(Buffer.from([1]));
    await vi.waitFor(() => {
      expect(linesWith(logs, 'binary message rejected')).toHaveLength(1);
    });

    expect(await server.shutdown()).toEqual({ openConnections: 1, unconfirmed: 0 });
    await connectionsOf(server, 0);
    expect(linesWith(logs, 'connection closed')[0]).toMatchObject({
      reason: 'binary',
      closeCode: ABNORMAL_CLOSURE,
    });
    // Exactly one close frame reached the device: the 1003, never a second one for the shutdown.
    device.socket.resume();
    expect((await device.closed).code).toBe(UNSUPPORTED_DATA);
  });
});
