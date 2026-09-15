import { execFile as execFileCallback, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import type { Recover, TestEnvironment } from './environment.js';

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

/** Ceilings for the sub-second fault commands; the test's own signal is the real bound (decision 12). */
const FAULT_COMMAND_TIMEOUT_MS = 10_000;
/** A container stop waits for its process (Docker's 10 s grace); `restart` plus its `up --wait` ran in 4 s. */
const STOP_OR_RESTART_TIMEOUT_MS = 20_000;
/** A recovery's own bound inside `dispose()`, under the 60 s hook budget. */
const RECOVERY_COMMAND_TIMEOUT_MS = 50_000;
const RECOVERY_WAIT_TIMEOUT_S = '40';

/**
 * The fault helpers of decision 12. Each registers its recovery on `env.undo` BEFORE it issues the
 * mutation, so a command aborted or killed mid-way is still recovered; each runs the mutation
 * under the test's signal and returns `recover()`, which runs the recovery until it has succeeded
 * once. Every recovery checks the service's state first, because it may follow a partly
 * successful attempt.
 */

/**
 * `docker compose pause <service>`. The recovery unpauses only a service that is still paused
 * (`unpause` of a running container exits 1, measured) and is never followed by `up --wait`: a
 * container reads `unhealthy` for about 10 s after an unpause, and `up --wait` fails fast then.
 */
export async function pause(env: TestEnvironment, service: Service): Promise<Recover> {
  const recover = env.undo(async (signal) => {
    const paused = await compose(['ps', '--services', '--status', 'paused'], {
      signal,
      timeoutMs: RECOVERY_COMMAND_TIMEOUT_MS,
    });
    if (paused.split('\n').includes(service)) {
      await compose(['unpause', service], { signal, timeoutMs: RECOVERY_COMMAND_TIMEOUT_MS });
    }
  }, `unpause ${service}`);
  await env.track(
    compose(['pause', service], { signal: env.signal, timeoutMs: FAULT_COMMAND_TIMEOUT_MS }),
  );
  return recover;
}

/** `docker compose stop <service>`; the recovery is `start` (exit 0 on a running service) and `up -d --wait`, which is its own state check. */
export async function stop(env: TestEnvironment, service: Service): Promise<Recover> {
  const recover = env.undo(async (signal) => {
    await compose(['start', service], { signal, timeoutMs: RECOVERY_COMMAND_TIMEOUT_MS });
    await compose(['up', '-d', '--wait', '--wait-timeout', RECOVERY_WAIT_TIMEOUT_S, service], {
      signal,
      timeoutMs: RECOVERY_COMMAND_TIMEOUT_MS,
    });
  }, `start ${service}`);
  await env.track(
    compose(['stop', service], { signal: env.signal, timeoutMs: STOP_OR_RESTART_TIMEOUT_MS }),
  );
  return recover;
}

/**
 * `docker compose restart <service>` and then `up -d --wait` until it is healthy again (2.6 s after
 * a restart, measured); the recovery is another `up -d --wait`, which also completes a restart that
 * was cut off mid-way and returns in 0.6 s on a healthy stack.
 */
export async function restart(env: TestEnvironment, service: Service): Promise<Recover> {
  const recover = env.undo(async (signal) => {
    await compose(['up', '-d', '--wait', '--wait-timeout', RECOVERY_WAIT_TIMEOUT_S, service], {
      signal,
      timeoutMs: RECOVERY_COMMAND_TIMEOUT_MS,
    });
  }, `up ${service}`);
  await env.track(
    compose(['restart', service], { signal: env.signal, timeoutMs: STOP_OR_RESTART_TIMEOUT_MS }),
  );
  await env.track(
    compose(['up', '-d', '--wait', '--wait-timeout', '15', service], {
      signal: env.signal,
      timeoutMs: STOP_OR_RESTART_TIMEOUT_MS,
    }),
  );
  return recover;
}

function rabbitmqctl(args: readonly string[], options: ComposeOptions): Promise<string> {
  return compose(['exec', '-T', 'rabbitmq', 'rabbitmqctl', ...args], options);
}

/**
 * The memory alarm of the RabbitMQ publishers documentation (`set_vm_memory_high_watermark 0`,
 * 358 ms measured); the recovery restores the default of 0.6, unconditionally and idempotently.
 * 0.6 is the documented default of the relative threshold
 * (https://www.rabbitmq.com/docs/memory#relative-threshold, read 2026-09-15) and what a fresh
 * `rabbitmq:4.3-management` container (4.3.5) reports for
 * `rabbitmqctl eval 'application:get_env(rabbit, vm_memory_high_watermark).'`: `{ok,0.6}`,
 * measured 2026-09-15.
 */
export async function raiseMemoryAlarm(env: TestEnvironment): Promise<Recover> {
  const recover = env.undo(async (signal) => {
    await rabbitmqctl(['set_vm_memory_high_watermark', '0.6'], {
      signal,
      timeoutMs: RECOVERY_COMMAND_TIMEOUT_MS,
    });
  }, 'reset memory alarm');
  await env.track(
    rabbitmqctl(['set_vm_memory_high_watermark', '0'], {
      signal: env.signal,
      timeoutMs: FAULT_COMMAND_TIMEOUT_MS,
    }),
  );
  return recover;
}
