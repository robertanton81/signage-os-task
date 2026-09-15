import { describe, expect, it } from 'vitest';

import { parseComposeConfig } from './stack.js';

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

  it('rejects a host port that is not a positive integer', () => {
    for (const published of ['0', 'abc', '27018.5']) {
      const mongodb = { ...MONGODB, ports: [{ target: 27017, published }] };
      expect(() => parseComposeConfig(render({ rabbitmq: RABBITMQ, mongodb }))).toThrow(
        /^docker compose config: service mongodb publishes no host port for 27017$/,
      );
    }
  });

  it('names a missing or empty credential without printing any value', () => {
    const missing = { ...MONGODB, environment: { MONGO_INITDB_ROOT_USERNAME: 'user-m' } };
    const empty = {
      ...MONGODB,
      environment: { ...MONGODB.environment, MONGO_INITDB_ROOT_PASSWORD: '' },
    };
    for (const mongodb of [missing, empty]) {
      expect(() => parseComposeConfig(render({ rabbitmq: RABBITMQ, mongodb }))).toThrow(
        /^docker compose config: service mongodb has no MONGO_INITDB_ROOT_PASSWORD$/,
      );
    }
  });
});
