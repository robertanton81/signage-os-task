import { describe, expect, it } from 'vitest';

import { parseComposeConfig, runInherited } from './stack.js';

/** The shape `docker compose config --format json` prints: published ports as strings, the environment resolved. */
const RABBITMQ = {
  ports: [
    { target: 5672, published: '5673' },
    { target: 15672, published: '15673' },
  ],
  environment: { RABBITMQ_DEFAULT_USER: 'user-r', RABBITMQ_DEFAULT_PASS: 'pass-r' },
};
const MONGODB = {
  ports: [{ target: 27017, published: '27018' }],
  environment: { MONGO_INITDB_ROOT_USERNAME: 'user-m', MONGO_INITDB_ROOT_PASSWORD: 'pass-m' },
};

function render(services: Record<string, unknown>): string {
  return JSON.stringify({ name: 'telemetry-test', services });
}

describe('parseComposeConfig', () => {
  it('reads the published ports and the credentials of both services', () => {
    expect(parseComposeConfig(render({ rabbitmq: RABBITMQ, mongodb: MONGODB }))).toEqual({
      host: '127.0.0.1',
      amqpPort: 5673,
      managementPort: 15673,
      mongoPort: 27018,
      rabbitmq: { user: 'user-r', password: 'pass-r' },
      mongodb: { user: 'user-m', password: 'pass-m' },
    });
  });

  it('names a missing service', () => {
    expect(() => parseComposeConfig(render({ rabbitmq: RABBITMQ }))).toThrow(
      /^docker compose config: service mongodb is missing$/,
    );
  });

  it('names a container port without a host port', () => {
    const rabbitmq = { ...RABBITMQ, ports: [{ target: 5672, published: '5673' }] };
    expect(() => parseComposeConfig(render({ rabbitmq, mongodb: MONGODB }))).toThrow(
      /^docker compose config: service rabbitmq publishes no host port for 15672$/,
    );
  });

  it.each(['0', 'abc', '27018.5'])('rejects the host port %s', (published) => {
    const mongodb = { ...MONGODB, ports: [{ target: 27017, published }] };
    expect(() => parseComposeConfig(render({ rabbitmq: RABBITMQ, mongodb }))).toThrow(
      /^docker compose config: service mongodb publishes no host port for 27017$/,
    );
  });

  it.each([
    { label: 'missing', environment: { MONGO_INITDB_ROOT_USERNAME: 'user-m' } },
    { label: 'empty', environment: { ...MONGODB.environment, MONGO_INITDB_ROOT_PASSWORD: '' } },
  ])('names a $label credential without printing any value', ({ environment }) => {
    const mongodb = { ...MONGODB, environment };
    expect(() => parseComposeConfig(render({ rabbitmq: RABBITMQ, mongodb }))).toThrow(
      /^docker compose config: service mongodb has no MONGO_INITDB_ROOT_PASSWORD$/,
    );
  });
});

describe('runInherited', () => {
  /** A `node -e` child with the terminal inherited, as `docker compose` runs in the global setup. */
  const node = (
    script: string,
    options: { timeoutMs?: number; killGraceMs?: number } = {},
  ): Promise<void> =>
    runInherited({
      command: process.execPath,
      args: ['-e', script],
      label: 'probe',
      timeoutMs: 5_000,
      ...options,
    });

  it('resolves on exit 0', async () => {
    await expect(node('')).resolves.toBeUndefined();
  });

  it('rejects naming the exit code', async () => {
    await expect(node('process.exit(3)')).rejects.toThrow(/^probe ended with code 3$/);
  });

  it('ends a child that outlives its deadline with SIGTERM and names the deadline', async () => {
    await expect(node('setInterval(() => {}, 1000)', { timeoutMs: 200 })).rejects.toThrow(
      /^probe did not end within 200 ms; it was sent SIGTERM and ended with SIGTERM$/,
    );
  });

  it('sends SIGKILL after the grace when the child ignores SIGTERM', async () => {
    // The child must have installed its handler before the SIGTERM: `node -e` starts in about
    // 30 ms here, and 1 s leaves room for a loaded machine.
    await expect(
      node("process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)", {
        timeoutMs: 1_000,
        killGraceMs: 200,
      }),
    ).rejects.toThrow(
      /^probe did not end within 1000 ms; it was sent SIGTERM, then SIGKILL and ended with SIGKILL$/,
    );
  });

  it('rejects with the spawn error of a command that does not exist', async () => {
    await expect(
      runInherited({
        command: 'telemetry-no-such-command',
        args: [],
        label: 'probe',
        timeoutMs: 1_000,
      }),
    ).rejects.toThrow(/ENOENT/);
  });
});
