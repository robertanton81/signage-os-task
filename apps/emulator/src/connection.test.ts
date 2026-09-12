import { createLogger, encodeFrame, type Logger, type TelemetryMessage } from '@telemetry/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { DeviceConnection } from './connection.js';
import { createRandom } from './random.js';
import { startTestSink, type TestSink } from './test-sink.js';

function silentLogger(): Logger {
  return createLogger({
    service: 'test',
    level: 'silent',
    destination: { write: () => undefined },
  });
}

function frame(seq: number): Buffer {
  const message: TelemetryMessage = {
    v: 1,
    deviceId: 'dev-0001',
    sessionId: 1_700_000_000_000,
    seq,
    occurredAt: 1_700_000_000_000,
    type: 'metrics',
    payload: { temperatureC: 40, cpuPercent: 10, ramPercent: 50 },
  };
  return encodeFrame(message);
}

const open: { sinks: TestSink[]; connections: DeviceConnection[] } = { sinks: [], connections: [] };

async function sink(): Promise<TestSink> {
  const created = await startTestSink();
  open.sinks.push(created);
  return created;
}

function connect(port: number, onWritable: () => void = () => undefined): DeviceConnection {
  const connection = new DeviceConnection({
    deviceId: 'dev-0001',
    hosts: [{ host: '127.0.0.1', port }],
    random: createRandom(3),
    logger: silentLogger(),
    onWritable,
  });
  open.connections.push(connection);
  return connection;
}

afterEach(async () => {
  await Promise.all(open.connections.map((connection) => connection.stop()));
  await Promise.all(open.sinks.map((created) => created.close()));
  open.connections.length = 0;
  open.sinks.length = 0;
});

describe('DeviceConnection', () => {
  it('connects and writes complete frames in the order written', async () => {
    const target = await sink();
    const connection = connect(target.port, () => {
      for (let seq = 1; seq <= 3; seq += 1) connection.write(frame(seq));
    });
    connection.start();

    const lines = await target.waitForLines(3);
    expect(lines.map((line) => (JSON.parse(line) as TelemetryMessage).seq)).toEqual([1, 2, 3]);
  });

  it('reconnects after the peer drops the connection and keeps sending', async () => {
    const target = await sink();
    let seq = 0;
    const connection = connect(target.port, () => {
      seq += 1;
      connection.write(frame(seq));
    });
    connection.start();
    await target.waitForLines(1);

    target.dropConnections();
    // The connection re-resolves and reconnects on its own; onWritable fires again on connect.
    await target.waitForLines(2);
    expect(target.connectionCount()).toBeGreaterThanOrEqual(2);
  });

  it('refuses to write while not connected', async () => {
    const target = await sink();
    const connection = connect(target.port);
    // Nothing started yet, so there is no socket at all.
    expect(connection.write(frame(1))).toBe(false);
    expect(target.lines()).toEqual([]);
  });

  it('reports a stopped state and writes nothing after stop()', async () => {
    const target = await sink();
    const connection = connect(target.port, () => connection.write(frame(1)));
    connection.start();
    await target.waitForLines(1);

    await connection.stop();
    expect(connection.state.name).toBe('stopped');
    expect(connection.isConnected).toBe(false);
    expect(connection.write(frame(2))).toBe(false);
  });

  it('skips a host that does not resolve and connects through the one that does', async () => {
    const target = await sink();
    const connection = new DeviceConnection({
      deviceId: 'dev-0001',
      hosts: [
        { host: 'this-host-does-not-exist.invalid', port: 1 },
        { host: '127.0.0.1', port: target.port },
      ],
      random: createRandom(3),
      logger: silentLogger(),
      onWritable: () => connection.write(frame(1)),
    });
    open.connections.push(connection);
    connection.start();

    const lines = await target.waitForLines(1);
    expect((JSON.parse(lines[0] ?? '{}') as TelemetryMessage).seq).toBe(1);
  });

  it('goes to backoff when the target refuses the connection, and never throws', async () => {
    // Take a port, then release it: connecting there is refused rather than hanging.
    const temporary = await startTestSink();
    const { port } = temporary;
    await temporary.close();

    const connection = connect(port);
    connection.start();
    await vi.waitFor(() => {
      expect(['backoff', 'resolving', 'connecting']).toContain(connection.state.name);
    });
  });
});
