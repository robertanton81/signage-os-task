import { setTimeout as sleep } from 'node:timers/promises';

import {
  ALERTS_COLLECTION,
  DEVICE_STATE_COLLECTION,
  DUPLICATE_KEY_ERROR_CODE,
  EVENTS_COLLECTION,
  EVENTS_IDENTITY_INDEX_NAME,
  EVENTS_IDENTITY_INDEX_SPEC,
  backoffDelay,
  redactUserinfo,
  settleWithin,
  type AlertDocument,
  type DeviceStateDocument,
  type EventDocument,
  type Logger,
} from '@telemetry/shared';
import {
  MongoClient,
  MongoClientClosedError,
  MongoNetworkError,
  MongoNotConnectedError,
  MongoServerError,
  MongoServerSelectionError,
  MongoTopologyClosedError,
  type Collection,
  type Db,
} from 'mongodb';

import { StoreError, type StoreFailure } from './failure.js';
import type { StateUpdate } from './state-update.js';

/**
 * All the handler knows about MongoDB (processing spec, decision 8). Each method resolves on
 * success, resolves with the duplicate result when the server answered duplicate key error 11000,
 * and otherwise rejects with a `StoreError` carrying the structural view of the driver's error —
 * never a driver class. The handler is tested against an in-memory implementation of this port.
 * The update's filter carries the device id, so `applyState` takes the update alone.
 */
export type StorePort = {
  insertEvent(doc: EventDocument): Promise<'inserted' | 'duplicate'>;
  applyState(
    update: StateUpdate,
  ): Promise<{ result: 'updated'; before: DeviceStateDocument | null } | { result: 'duplicate' }>;
  insertAlert(doc: AlertDocument): Promise<'inserted' | 'duplicate'>;
};

/** The pause's ping loop (decision 10): resolves once a ping succeeds, or when the signal aborts. */
export type StoreWatcher = {
  watch(signal: AbortSignal): Promise<'ready' | 'aborted'>;
};

export type MongoStoreOptions = {
  url: string;
  dbName: string;
  /** `1` on the standalone development database, `majority` on a replica set (consistency spec, decision 20). */
  writeW: 'majority' | number;
  /** One bound for connect, server selection, socket, every operation's `maxTimeMS` and the write concern's `wtimeoutMS` (consistency spec, decision 24). */
  timeoutMs: number;
  logger: Logger;
};

export const STORE_BACKOFF_BASE_MS = 500;
export const STORE_BACKOFF_MAX_MS = 10_000;

/** IndexOptionsConflict (85), IndexKeySpecsConflict (86): a deployment bug no retry fixes (decision 10). */
export const INDEX_CONFLICT_CODES: ReadonlySet<number> = new Set([85, 86]);

/**
 * Maps a driver error to the structural view the handler classifies (decision 9). The only
 * function that touches the driver's classes: `MongoWriteConcernError` extends `MongoServerError`
 * and carries the server code, `MongoNetworkTimeoutError` extends `MongoNetworkError`, and the
 * three "closed" classes are what the client throws once `close()` has run. The driver documents
 * its constructors as internal, so the tests build each class and would fail loudly if a driver
 * upgrade moved one, instead of silently turning every outage into a dead-lettered message. The
 * driver quotes the connection string in some messages, so every message loses its URL userinfo
 * here, before the view can reach a log line by any path.
 */
export function describeMongoError(error: unknown): StoreFailure {
  if (error instanceof MongoServerError) {
    return {
      kind: 'server',
      code: typeof error.code === 'number' ? error.code : undefined,
      codeName: typeof error.codeName === 'string' ? error.codeName : undefined,
      labels: error.errorLabels,
      message: redactUserinfo(error.message),
    };
  }
  if (error instanceof MongoNetworkError) {
    return { kind: 'network', message: redactUserinfo(error.message) };
  }
  if (error instanceof MongoServerSelectionError) {
    return { kind: 'server_selection', message: redactUserinfo(error.message) };
  }
  if (
    error instanceof MongoClientClosedError ||
    error instanceof MongoNotConnectedError ||
    error instanceof MongoTopologyClosedError
  ) {
    return { kind: 'closed', message: redactUserinfo(error.message) };
  }
  if (error instanceof Error) {
    return { kind: 'other', name: error.name, message: redactUserinfo(error.message) };
  }
  return { kind: 'other', name: 'non-error', message: redactUserinfo(String(error)) };
}

function isDuplicateKey(failure: StoreFailure): boolean {
  return failure.kind === 'server' && failure.code === DUPLICATE_KEY_ERROR_CODE;
}

/**
 * The one startup failure no retry fixes (decision 10): the identity index exists under another
 * name or with another key, which is a deployment bug the operator has to resolve.
 */
export function isIndexConflict(failure: StoreFailure): boolean {
  return (
    failure.kind === 'server' &&
    failure.code !== undefined &&
    INDEX_CONFLICT_CODES.has(failure.code)
  );
}

/**
 * The MongoDB shell of the store port (decisions 10 and 11). One client per instance, every
 * option from one timeout, a journaled write concern, and one driver call per port method with
 * `maxTimeMS`. No I/O in the constructor.
 */
export class MongoStore implements StorePort, StoreWatcher {
  readonly #client: MongoClient;
  readonly #db: Db;
  readonly #events: Collection<EventDocument>;
  readonly #state: Collection<DeviceStateDocument>;
  readonly #alerts: Collection<AlertDocument>;
  readonly #timeoutMs: number;
  readonly #logger: Logger;

  constructor({ url, dbName, writeW, timeoutMs, logger }: MongoStoreOptions) {
    // The URL can carry credentials; it is never logged. `retryWrites` and `maxPoolSize` keep the
    // driver defaults (true, 100; trade-off T47). Not the experimental `timeoutMS`.
    this.#client = new MongoClient(url, {
      connectTimeoutMS: timeoutMs,
      serverSelectionTimeoutMS: timeoutMs,
      socketTimeoutMS: timeoutMs,
      writeConcern: { w: writeW, journal: true, wtimeoutMS: timeoutMs },
      appName: 'processing',
    });
    this.#db = this.#client.db(dbName);
    this.#events = this.#db.collection<EventDocument>(EVENTS_COLLECTION);
    this.#state = this.#db.collection<DeviceStateDocument>(DEVICE_STATE_COLLECTION);
    this.#alerts = this.#db.collection<AlertDocument>(ALERTS_COLLECTION);
    this.#timeoutMs = timeoutMs;
    this.#logger = logger;
  }

  /**
   * Connects and creates the unique identity index, retried with backoff until both succeed or
   * the signal aborts. Invariant 2 depends on the index existing before the first insert, so the
   * consumer registers only after this resolved `ready`. An index conflict is the one failure no
   * retry fixes: it rejects with its `StoreError`, and the entry point exits. Every other failure
   * — the database still booting, a wrong password — is a `warn` line and another attempt.
   */
  start(signal: AbortSignal): Promise<'ready' | 'aborted'> {
    return this.#untilReady(signal, async () => {
      await this.#client.connect();
      await this.#events.createIndex(EVENTS_IDENTITY_INDEX_SPEC.key, {
        name: EVENTS_IDENTITY_INDEX_NAME,
        unique: true,
        maxTimeMS: this.#timeoutMs,
      });
    });
  }

  /**
   * Pings until the server answers (decision 10). `maxTimeMS` goes into the command document,
   * where the server reads it as a generic argument; the driver's `command` options carry no such
   * field. The socket timeout bounds the call as well.
   */
  watch(signal: AbortSignal): Promise<'ready' | 'aborted'> {
    return this.#untilReady(signal, () =>
      this.#db.command({ ping: 1, maxTimeMS: this.#timeoutMs }),
    );
  }

  insertEvent(doc: EventDocument): Promise<'inserted' | 'duplicate'> {
    return this.#insert(() => this.#events.insertOne(doc, { maxTimeMS: this.#timeoutMs }));
  }

  /**
   * The one conditional write (consistency spec, decision 29): the pipeline evaluates the freshness
   * guard on the server, the upsert creates the document for a new device, and the returned
   * pre-update document tells the handler the outcome. A duplicate key error is the racing first
   * insert of a new device; the handler retries it once.
   */
  async applyState(
    update: StateUpdate,
  ): Promise<{ result: 'updated'; before: DeviceStateDocument | null } | { result: 'duplicate' }> {
    try {
      const before = await this.#state.findOneAndUpdate(update.filter, update.pipeline, {
        upsert: true,
        returnDocument: 'before',
        maxTimeMS: this.#timeoutMs,
      });
      return { result: 'updated', before };
    } catch (error) {
      const failure = describeMongoError(error);
      if (isDuplicateKey(failure)) {
        return { result: 'duplicate' };
      }
      throw new StoreError(failure);
    }
  }

  insertAlert(doc: AlertDocument): Promise<'inserted' | 'duplicate'> {
    return this.#insert(() => this.#alerts.insertOne(doc, { maxTimeMS: this.#timeoutMs }));
  }

  /** Bounded by the timeout; a rejection or a timeout is logged, never thrown (decision 20). */
  async close(): Promise<void> {
    const result = await settleWithin(this.#client.close(), this.#timeoutMs);
    if (result.outcome === 'rejected') {
      this.#logger.warn({ outcome: result.outcome, err: result.error }, 'store close');
    } else if (result.outcome === 'timed_out') {
      this.#logger.warn({ outcome: result.outcome, timeoutMs: this.#timeoutMs }, 'store close');
    }
  }

  async #insert(run: () => Promise<unknown>): Promise<'inserted' | 'duplicate'> {
    try {
      await run();
      return 'inserted';
    } catch (error) {
      const failure = describeMongoError(error);
      if (isDuplicateKey(failure)) {
        return 'duplicate';
      }
      throw new StoreError(failure);
    }
  }

  /**
   * Runs `step` until it resolves, with the shared backoff between attempts (500 ms to 10 s) and
   * the signal ending the wait at once. An index conflict rejects; everything else is retried
   * forever with a `warn` line, because a crash loop would hide the line that explains the problem
   * (trade-off T49).
   */
  async #untilReady(
    signal: AbortSignal,
    step: () => Promise<unknown>,
  ): Promise<'ready' | 'aborted'> {
    for (let attempt = 0; ; attempt += 1) {
      if (signal.aborted) {
        return 'aborted';
      }
      try {
        await step();
        this.#logger.info({ attempt }, 'store ready');
        return 'ready';
      } catch (error) {
        const failure = describeMongoError(error);
        if (isIndexConflict(failure)) {
          throw new StoreError(failure);
        }
        this.#logger.warn({ attempt, failure }, 'store not ready');
      }
      const delayMs = backoffDelay({
        attempt,
        baseMs: STORE_BACKOFF_BASE_MS,
        maxMs: STORE_BACKOFF_MAX_MS,
        random: Math.random,
      });
      try {
        await sleep(delayMs, undefined, { signal });
      } catch {
        // The only rejection of a timers/promises sleep with a signal is its AbortError.
        return 'aborted';
      }
    }
  }
}
