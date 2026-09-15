import { execFile as execFileCallback, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);

/**
 * `docker compose` on the test stack (integration spec, decisions 1, 5 and 12). The file is
 * resolved from this module, so Compose reads `.env` from the repository root whatever the working
 * directory (the pattern of `scripts/compose-check.mjs`).
 */
export const COMPOSE_FILE = fileURLToPath(
  new URL('../../docker-compose.test.yml', import.meta.url),
);

export const SERVICES = ['rabbitmq', 'mongodb'] as const;
export type Service = (typeof SERVICES)[number];

/** What the global setup provides to every test file (decision 6): host, ports, credentials. */
export type TestStack = {
  host: '127.0.0.1';
  amqpPort: number;
  managementPort: number;
  mongoPort: number;
  rabbitmq: { user: string; password: string };
  mongodb: { user: string; password: string };
};

/** Ceiling for a captured command that runs without a test signal (the setup's `ps` and `config`). */
const SETUP_COMMAND_TIMEOUT_MS = 180_000;
/** `config --format json` is a few kilobytes; the bound only keeps a runaway output from ending the child. */
const MAX_BUFFER_BYTES = 64 * 1024 * 1024;

export type ComposeOptions = {
  /** The test's own signal: an abort kills the Docker child and rejects at once (decision 12). */
  signal?: AbortSignal;
  /** A ceiling for a run without a signal, and a safety net under one. */
  timeoutMs?: number;
};

/** `docker compose -f docker-compose.test.yml <args>` with its output captured; rejects on a non-zero exit. */
export async function compose(
  args: readonly string[],
  options: ComposeOptions = {},
): Promise<string> {
  const { stdout } = await execFile('docker', ['compose', '-f', COMPOSE_FILE, ...args], {
    timeout: options.timeoutMs ?? SETUP_COMMAND_TIMEOUT_MS,
    maxBuffer: MAX_BUFFER_BYTES,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  return stdout;
}

/** The same with the terminal inherited, so an image pull on the first run shows its progress. */
export function composeInherit(args: readonly string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', ['compose', '-f', COMPOSE_FILE, ...args], { stdio: 'inherit' });
    child.once('error', reject);
    child.once('close', (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      const suffix = signal === null ? '' : ` after ${signal}`;
      reject(
        new Error(`docker compose ${args.join(' ')} ended with code ${String(code)}${suffix}`),
      );
    });
  });
}

type ComposePort = { target?: unknown; published?: unknown };
type ComposeService = { ports?: unknown; environment?: unknown };
type ComposeConfig = { services?: Record<string, ComposeService | undefined> };
type NamedService = { name: string; service: ComposeService };

/**
 * The published ports and the credentials from `docker compose config --format json` (decision 6):
 * `ports[].published` is a string there, `environment` the resolved map. A missing field is an
 * error that names the field; no message prints a map or a value.
 */
export function parseComposeConfig(json: string): TestStack {
  const config = JSON.parse(json) as ComposeConfig;
  const rabbitmq = serviceOf(config, 'rabbitmq');
  const mongodb = serviceOf(config, 'mongodb');
  return {
    host: '127.0.0.1',
    amqpPort: publishedPort(rabbitmq, 5672),
    managementPort: publishedPort(rabbitmq, 15672),
    mongoPort: publishedPort(mongodb, 27017),
    rabbitmq: {
      user: variable(rabbitmq, 'RABBITMQ_DEFAULT_USER'),
      password: variable(rabbitmq, 'RABBITMQ_DEFAULT_PASS'),
    },
    mongodb: {
      user: variable(mongodb, 'MONGO_INITDB_ROOT_USERNAME'),
      password: variable(mongodb, 'MONGO_INITDB_ROOT_PASSWORD'),
    },
  };
}

function serviceOf(config: ComposeConfig, name: string): NamedService {
  const service = config.services?.[name];
  if (service === undefined) {
    throw new Error(`docker compose config: service ${name} is missing`);
  }
  return { name, service };
}

function publishedPort({ name, service }: NamedService, target: number): number {
  const ports = Array.isArray(service.ports) ? (service.ports as ComposePort[]) : [];
  const mapping = ports.find((port) => port.target === target);
  const published = Number(mapping?.published);
  if (!Number.isInteger(published) || published <= 0) {
    throw new Error(
      `docker compose config: service ${name} publishes no host port for ${String(target)}`,
    );
  }
  return published;
}

function variable({ name, service }: NamedService, key: string): string {
  const environment = service.environment;
  const value =
    typeof environment === 'object' && environment !== null
      ? (environment as Record<string, unknown>)[key]
      : undefined;
  if (typeof value !== 'string' || value === '') {
    throw new Error(`docker compose config: service ${name} has no ${key}`);
  }
  return value;
}
