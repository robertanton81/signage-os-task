import { randomBytes } from 'node:crypto';

import { redactUserinfo, settleWithin } from '@telemetry/shared';
import { connect as amqpConnect, type ChannelModel } from 'amqplib';
import { MongoClient, type Db } from 'mongodb';
import { inject } from 'vitest';

import type { Expected } from './load.js';
import { createManagementClient, type ManagementApi, type ManagementClient } from './management.js';
import type { TestStack } from './stack.js';
import {
  awaitAcked,
  awaitEndState,
  waitFor,
  type AckCounter,
  type Truthy,
  type WaitOptions,
} from './wait.js';

export type RecoveryAction = (signal: AbortSignal) => Promise<void>;
/** Runs a registered recovery until it has succeeded once (see `TestEnvironment.undo`). */
export type Recover = () => Promise<void>;

/**
 * One test's virtual host and database (integration spec, decision 7), its undo stack, its
 * in-flight fault commands, and the waits bound to its signal (decisions 12 and 13). Created in
 * `beforeEach`, bound to the test's own signal by `bindEnvironment` as the first line of the test
 * body, disposed in `afterEach`.
 */
export type TestEnvironment = {
  /** `it-` and 8 hex characters: the virtual host and the database name. */
  readonly name: string;
  readonly amqpUrl: string;
  readonly mongoUrl: string;
  /** `mongoUrl` with a wrong password, for the wrong-credentials scenario (C12); never logged. */
  readonly wrongMongoUrl: string;
  readonly dbName: string;
  /** The harness's own client: reads for assertions, the deletions of C13 and C14. */
  readonly db: Db;
  /** The management API scoped to this virtual host. */
  readonly management: ManagementApi;
  /** The running test's own signal once `bind` ran; every in-body fault command and wait reads it. */
  readonly signal: AbortSignal;
  bind(signal: AbortSignal): void;
  /** The harness's own amqplib connection: opened on first use, opened again after its `close` event. */
  amqp(): Promise<ChannelModel>;
  /** Registers an in-flight fault command; `dispose()` awaits its settlement before it recovers. */
  track<T>(command: Promise<T>): Promise<T>;
  /**
   * Registers a recovery and returns `recover()`, which runs the action until it has succeeded
   * once: a call while an attempt runs joins it, a call after a success resolves at once, a call
   * after a failure or an abort starts a new attempt. `dispose()` runs every recovery that has not
   * succeeded yet, in reverse order of registration, under its own timeout.
   */
  undo(action: RecoveryAction, label?: string): Recover;
  waitFor<T>(predicate: () => T | Promise<T>, options?: WaitOptions): Promise<Truthy<T>>;
  awaitAcked(instance: AckCounter, count: number): Promise<void>;
  awaitEndState(expected: Expected, timeoutMs?: number): Promise<void>;
  dispose(): Promise<void>;
};

type Recovery = {
  action: RecoveryAction;
  label: string;
  attempt: Promise<void> | undefined;
  done: boolean;
};

/** The harness's own connects and closes: the AMQP connect and close, the MongoDB server selection and close. */
export const HARNESS_TIMEOUT_MS = 5_000;
/** How long `dispose()` waits for an in-flight fault command; an aborted command settles at once. */
const IN_FLIGHT_SETTLE_MS = 5_000;
/** One recovery's bound inside `dispose()`, under the 60 s hook budget. */
const RECOVERY_TIMEOUT_MS = 50_000;

function userinfo({ user, password }: { user: string; password: string }): string {
  return `${encodeURIComponent(user)}:${encodeURIComponent(password)}`;
}

function mongoUrlFor(stack: TestStack, password: string): string {
  return `mongodb://${userinfo({ user: stack.mongodb.user, password })}@${stack.host}:${String(stack.mongoPort)}/?authSource=admin`;
}

/** An error's message with any `user:password@` removed: what reaches the reporter. */
export function describeError(error: unknown): string {
  return redactUserinfo(error instanceof Error ? error.message : String(error));
}

class Environment implements TestEnvironment {
  readonly name: string;
  readonly amqpUrl: string;
  readonly mongoUrl: string;
  readonly wrongMongoUrl: string;
  readonly dbName: string;
  readonly db: Db;
  readonly management: ManagementApi;
  readonly #mongo: MongoClient;
  readonly #client: ManagementClient;
  /** Aborted first thing in `dispose()`: stray waits and in-flight commands of this test end there. */
  readonly #disposal = new AbortController();
  readonly #recoveries: Recovery[] = [];
  readonly #inFlight = new Set<Promise<unknown>>();
  #signal: AbortSignal;
  #model: Promise<ChannelModel> | undefined;

  constructor({
    name,
    stack,
    mongo,
    client,
  }: {
    name: string;
    stack: TestStack;
    mongo: MongoClient;
    client: ManagementClient;
  }) {
    this.name = name;
    this.dbName = name;
    this.amqpUrl = `amqp://${userinfo(stack.rabbitmq)}@${stack.host}:${String(stack.amqpPort)}/${encodeURIComponent(name)}`;
    this.mongoUrl = mongoUrlFor(stack, stack.mongodb.password);
    this.wrongMongoUrl = mongoUrlFor(stack, `${stack.mongodb.password}-wrong`);
    this.db = mongo.db(name);
    this.management = client.vhost(name);
    this.#mongo = mongo;
    this.#client = client;
    this.#signal = this.#disposal.signal;
  }

  get signal(): AbortSignal {
    return this.#signal;
  }

  bind(signal: AbortSignal): void {
    this.#signal = AbortSignal.any([this.#disposal.signal, signal]);
  }

  amqp(): Promise<ChannelModel> {
    if (this.#model === undefined) {
      const opening = amqpConnect(this.amqpUrl, { timeout: HARNESS_TIMEOUT_MS }).then(
        (model) => {
          model.on('error', () => {
            // The `close` that follows drops the connection; the listener keeps the error from throwing.
          });
          model.once('close', () => {
            if (this.#model === opening) {
              this.#model = undefined;
            }
          });
          return model;
        },
        (error: unknown) => {
          // A driver's message may quote the URL; the userinfo never reaches the reporter.
          throw new Error(`amqp connect: ${describeError(error)}`);
        },
      );
      opening.catch(() => {
        if (this.#model === opening) {
          this.#model = undefined;
        }
      });
      this.#model = opening;
    }
    return this.#model;
  }

  track<T>(command: Promise<T>): Promise<T> {
    this.#inFlight.add(command);
    command.finally(() => this.#inFlight.delete(command)).catch(() => undefined);
    return command;
  }

  undo(action: RecoveryAction, label = 'recovery'): Recover {
    const entry: Recovery = { action, label, attempt: undefined, done: false };
    this.#recoveries.push(entry);
    return () => this.#recover(entry, this.#signal);
  }

  waitFor<T>(predicate: () => T | Promise<T>, options: WaitOptions = {}): Promise<Truthy<T>> {
    return waitFor(predicate, { ...options, signal: this.#signal });
  }

  awaitAcked(instance: AckCounter, count: number): Promise<void> {
    return awaitAcked(instance, { count, signal: this.#signal });
  }

  awaitEndState(expected: Expected, timeoutMs?: number): Promise<void> {
    return awaitEndState({
      db: this.db,
      expected,
      signal: this.#signal,
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
    });
  }

  /**
   * Reverse-order recovery, then the harness's own connections, then the database and the virtual
   * host. Every step is bounded; a failure in one step is collected and the others still run; the
   * collected failures are thrown at the end with their step names.
   */
  async dispose(): Promise<void> {
    const failures: string[] = [];
    const step = async (label: string, run: () => Promise<unknown>): Promise<void> => {
      try {
        await run();
      } catch (error) {
        failures.push(`${label}: ${describeError(error)}`);
      }
    };
    // Whatever the test left running ends now: a stray wait rejects, an in-flight command is killed.
    this.#disposal.abort();
    await step('in-flight commands', () =>
      settleWithin(Promise.allSettled([...this.#inFlight]), IN_FLIGHT_SETTLE_MS),
    );
    for (const entry of [...this.#recoveries].reverse()) {
      await step(entry.label, async () => {
        // An attempt the test started under its own signal settles first; a failed or aborted one
        // is then run again under a fresh bound of its own.
        await entry.attempt?.catch(() => undefined);
        await this.#recover(entry, AbortSignal.timeout(RECOVERY_TIMEOUT_MS));
      });
    }
    await step('amqp close', () => this.#closeAmqp());
    await step('drop database', () => this.db.dropDatabase());
    await step('mongo close', () => this.#mongo.close());
    await step('delete vhost', () => this.#client.deleteVhost(this.name));
    if (failures.length > 0) {
      throw new Error(`dispose of ${this.name}: ${failures.join('; ')}`);
    }
  }

  #recover(entry: Recovery, signal: AbortSignal): Promise<void> {
    if (entry.done) {
      return Promise.resolve();
    }
    if (entry.attempt === undefined) {
      const attempt = entry
        .action(signal)
        .then(() => {
          entry.done = true;
        })
        .finally(() => {
          if (entry.attempt === attempt) {
            entry.attempt = undefined;
          }
        });
      entry.attempt = attempt;
    }
    return entry.attempt;
  }

  async #closeAmqp(): Promise<void> {
    const opening = this.#model;
    this.#model = undefined;
    if (opening === undefined) {
      return;
    }
    const model = await opening.catch(() => undefined);
    if (model === undefined) {
      return;
    }
    // A `close()` after the broker closed the connection rejects (measured after a restart); the
    // connection is gone either way, so the outcome is not checked.
    await settleWithin(model.close(), HARNESS_TIMEOUT_MS);
  }
}

/**
 * The virtual host, its permissions and the harness's database client, in that order; a failure
 * after the vhost was created deletes it before the error propagates, so a failed `beforeEach`
 * leaves nothing behind.
 */
export async function createEnvironment(): Promise<TestEnvironment> {
  const stack = inject('stack');
  const name = `it-${randomBytes(4).toString('hex')}`;
  const client = createManagementClient({
    host: stack.host,
    port: stack.managementPort,
    user: stack.rabbitmq.user,
    password: stack.rabbitmq.password,
  });
  await client.createVhost(name);
  let mongo: MongoClient | undefined;
  try {
    await client.grantAll(name, stack.rabbitmq.user);
    mongo = new MongoClient(mongoUrlFor(stack, stack.mongodb.password), {
      serverSelectionTimeoutMS: HARNESS_TIMEOUT_MS,
    });
    await mongo.connect();
    return new Environment({ name, stack, mongo, client });
  } catch (error) {
    await mongo?.close().catch(() => undefined);
    await client.deleteVhost(name).catch(() => undefined);
    // Reported without the URL a driver may quote in its message. The raw error is not attached
    // as the cause on purpose: the reporter prints a cause as it is.
    // eslint-disable-next-line preserve-caught-error -- the cause would carry the URL, see above
    throw new Error(`createEnvironment ${name}: ${describeError(error)}`);
  }
}

/**
 * The first line of every test body: `const env = environment(signal)` where the test file defines
 * `environment` over its own `env` variable. Fails with a clear message when `beforeEach` did not
 * complete, and binds the test's own signal to the environment.
 */
export function bindEnvironment(
  env: TestEnvironment | undefined,
  signal: AbortSignal,
): TestEnvironment {
  if (env === undefined) {
    throw new Error('no test environment: beforeEach did not complete');
  }
  env.bind(signal);
  return env;
}
