import {
  ALERTS_COLLECTION,
  DEAD_LETTER_EXCHANGE,
  DEAD_LETTER_EXCHANGE_OPTIONS,
  DEAD_LETTER_EXCHANGE_TYPE,
  DEAD_LETTER_QUEUE,
  DEAD_LETTER_QUEUE_OPTIONS,
  DEVICE_STATE_COLLECTION,
  EVENTS_COLLECTION,
  TELEMETRY_EXCHANGE,
  TELEMETRY_EXCHANGE_OPTIONS,
  TELEMETRY_EXCHANGE_TYPE,
  TELEMETRY_QUEUE,
  TELEMETRY_QUEUE_OPTIONS,
  TELEMETRY_ROUTING_KEY,
  messageIdentity,
  type AlertDocument,
  type CountersPayload,
  type DeviceStateDocument,
  type DiagnosticPayload,
  type EventDocument,
  type MetricsPayload,
  type OrderKey,
  type StatusPayload,
  type TelemetryEventType,
  type TelemetryMessage,
  type TelemetryMessageOf,
} from '@telemetry/shared';
import { connect as amqpConnect, type ConfirmChannel, type Options } from 'amqplib';
import type { WithId } from 'mongodb';

import { toPublishArgs, type PublishArgs } from '../../apps/ingest/src/amqp-message.js';
import { connectTestDevice, type TestDevice } from '../../apps/ingest/src/test-device.js';
import type { StorePort, StoreWatcher } from '../../apps/processing/src/store.js';
import type { TestEnvironment } from './environment.js';
import type { Expected } from './load.js';

/** Two session ids inside the contract's window; B is the later session (P5). */
export const SESSION_A = 1_700_000_000_000;
export const SESSION_B = 1_700_000_001_000;

/** A `ws` device against an ingest port; terminated with the test. */
export async function connectDevice(env: TestEnvironment, port: number): Promise<TestDevice> {
  const device = await connectTestDevice({ port });
  env.undo(() => {
    device.terminate();
    return Promise.resolve();
  }, 'device terminate');
  return device;
}

export type MessageBuilder = {
  status(seq: number, payload?: Partial<StatusPayload>): TelemetryMessageOf<'status'>;
  metrics(seq: number, payload?: Partial<MetricsPayload>): TelemetryMessageOf<'metrics'>;
  counters(seq: number, payload?: Partial<CountersPayload>): TelemetryMessageOf<'counters'>;
  diagnostic(seq: number, payload?: Partial<DiagnosticPayload>): TelemetryMessageOf<'diagnostic'>;
};

/** Messages of one device and one session, so the tests read as identity and order, not as JSON. */
export function messages(deviceId: string, sessionId: number): MessageBuilder {
  const envelope = (seq: number) => ({
    v: 1 as const,
    deviceId,
    sessionId,
    seq,
    occurredAt: sessionId + seq,
  });
  return {
    status: (seq, payload = {}) => ({
      ...envelope(seq),
      type: 'status',
      payload: { state: 'online', ...payload },
    }),
    metrics: (seq, payload = {}) => ({
      ...envelope(seq),
      type: 'metrics',
      payload: { temperatureC: 41.5, cpuPercent: 12.25, ramPercent: 63, ...payload },
    }),
    counters: (seq, payload = {}) => ({
      ...envelope(seq),
      type: 'counters',
      payload: { operationsTotal: 120, uptimeMs: 3_600_000, ...payload },
    }),
    diagnostic: (seq, payload = {}) => ({
      ...envelope(seq),
      type: 'diagnostic',
      payload: {
        severity: 'error',
        code: 'E_OVERHEAT',
        message: 'temperature above threshold',
        ...payload,
      },
    }),
  };
}

export type DirectPublisher = {
  /** Resolves on the broker's confirm; rejects when the confirm fails or the channel is gone. */
  publish(message: TelemetryMessage, receivedAt?: number): Promise<void>;
  /** A raw body with the given properties: the poison messages of C7. */
  publishRaw(body: Buffer, properties?: Options.Publish): Promise<void>;
  close(): Promise<void>;
};

/** The six declarations the services make, with the shared constants, in ingest's order. */
async function declareTopology(channel: ConfirmChannel): Promise<void> {
  await channel.assertExchange(
    TELEMETRY_EXCHANGE,
    TELEMETRY_EXCHANGE_TYPE,
    TELEMETRY_EXCHANGE_OPTIONS,
  );
  await channel.assertExchange(
    DEAD_LETTER_EXCHANGE,
    DEAD_LETTER_EXCHANGE_TYPE,
    DEAD_LETTER_EXCHANGE_OPTIONS,
  );
  await channel.assertQueue(TELEMETRY_QUEUE, TELEMETRY_QUEUE_OPTIONS);
  await channel.assertQueue(DEAD_LETTER_QUEUE, DEAD_LETTER_QUEUE_OPTIONS);
  await channel.bindQueue(TELEMETRY_QUEUE, TELEMETRY_EXCHANGE, TELEMETRY_ROUTING_KEY);
  await channel.bindQueue(DEAD_LETTER_QUEUE, DEAD_LETTER_EXCHANGE, '');
}

function confirmed(channel: ConfirmChannel, args: PublishArgs): Promise<void> {
  return new Promise((resolve, reject) => {
    // Throws at once on a closed channel; the executor turns that into a rejection.
    channel.publish(
      args.exchange,
      args.routingKey,
      args.content,
      args.options,
      (error: unknown) => {
        if (error === null || error === undefined) {
          resolve();
        } else {
          // amqplib passes an Error; anything else is named, not stringified (lint: no-base-to-string).
          reject(error instanceof Error ? error : new Error('publish not confirmed'));
        }
      },
    );
  });
}

/**
 * One connection and one confirm channel on the test virtual host, no recovery (integration spec,
 * decision 24): a test that restarts the broker opens a new publisher afterwards. `close()` resolves
 * at once when the connection has already seen its `close` event, because a `close()` after that
 * rejects (measured after a broker restart).
 */
export async function openDirectPublisher(env: TestEnvironment): Promise<DirectPublisher> {
  const model = await amqpConnect(env.amqpUrl);
  let gone = false;
  model.on('error', () => {
    // The `close` event that follows is what matters; the listener keeps the error from throwing.
  });
  model.once('close', () => {
    gone = true;
  });
  const channel = await model.createConfirmChannel();
  channel.on('error', () => {
    // A failed publish rejects its own promise; the channel's error would otherwise throw.
  });
  await declareTopology(channel);
  const close = env.undo(async () => {
    if (gone) {
      return;
    }
    gone = true;
    await model.close();
  }, 'direct publisher close');
  return {
    publish: (message, receivedAt = Date.now()) =>
      confirmed(channel, toPublishArgs(message, receivedAt)),
    publishRaw: (body, properties = {}) =>
      confirmed(channel, {
        exchange: TELEMETRY_EXCHANGE,
        routingKey: TELEMETRY_ROUTING_KEY,
        content: body,
        options: { persistent: true, ...properties },
      }),
    close,
  };
}

export type QueueDepth = { ready: number; consumers: number };

/**
 * The live depth through amqplib's `checkQueue` (decision 13): `messageCount` is the ready count,
 * `consumerCount` the consumers; deliveries a consumer holds show in its `inFlight`, not here.
 * `undefined` when the queue does not exist: the check closes the channel with a 404, which a
 * `waitFor` predicate reads as "not yet" (I3).
 */
export async function queueDepth(
  env: TestEnvironment,
  queue: string = TELEMETRY_QUEUE,
): Promise<QueueDepth | undefined> {
  const model = await env.amqp();
  const channel = await model.createChannel();
  channel.on('error', () => {
    // A 404 closes the channel with an error event; without a listener it would throw.
  });
  try {
    const reply = await channel.checkQueue(queue);
    return { ready: reply.messageCount, consumers: reply.consumerCount };
  } catch {
    return undefined;
  } finally {
    await channel.close().catch(() => undefined);
  }
}

export type InsertGate = {
  /**
   * Wraps the store the consumer sees: every `insertEvent` waits for `release()`; the rest is
   * delegated. A property, not a method signature, so `wrapStore: gate.wrap` passes the
   * `unbound-method` lint rule.
   */
  wrap: (store: StorePort & StoreWatcher) => StorePort & StoreWatcher;
  release: () => void;
};

/** The store gate of C11b; `release` is registered on `env.undo` too, so a failed test never leaves handlers waiting. */
export function holdInserts(env: TestEnvironment): InsertGate {
  const gate = Promise.withResolvers<void>();
  const release = (): void => {
    gate.resolve();
  };
  env.undo(() => {
    release();
    return Promise.resolve();
  }, 'release held inserts');
  return {
    wrap: (store) => ({
      insertEvent: async (doc) => {
        await gate.promise;
        return store.insertEvent(doc);
      },
      applyState: (update) => store.applyState(update),
      insertAlert: (doc) => store.insertAlert(doc),
      watch: (watchSignal) => store.watch(watchSignal),
    }),
    release,
  };
}

export function readEvents(env: TestEnvironment): Promise<WithId<EventDocument>[]> {
  return env.db
    .collection<EventDocument>(EVENTS_COLLECTION)
    .find({})
    .sort({ deviceId: 1, sessionId: 1, seq: 1 })
    .toArray();
}

export function readState(
  env: TestEnvironment,
  deviceId: string,
): Promise<DeviceStateDocument | null> {
  return env.db.collection<DeviceStateDocument>(DEVICE_STATE_COLLECTION).findOne({ _id: deviceId });
}

export function readAlerts(env: TestEnvironment): Promise<AlertDocument[]> {
  return env.db.collection<AlertDocument>(ALERTS_COLLECTION).find({}).sort({ _id: 1 }).toArray();
}

/** The recovery tests reproduce a crash between two writes by removing what the later write made (C13, C14). */
export async function deleteStateDocument(env: TestEnvironment, deviceId: string): Promise<void> {
  const result = await env.db
    .collection<DeviceStateDocument>(DEVICE_STATE_COLLECTION)
    .deleteOne({ _id: deviceId });
  if (result.deletedCount !== 1) {
    throw new Error(`no device_state document for ${deviceId}`);
  }
}

export async function deleteAlertDocument(env: TestEnvironment, identity: string): Promise<void> {
  const result = await env.db
    .collection<AlertDocument>(ALERTS_COLLECTION)
    .deleteOne({ _id: identity });
  if (result.deletedCount !== 1) {
    throw new Error(`no alert document ${identity}`);
  }
}

export function identitiesOf(events: readonly EventDocument[]): Set<string> {
  return new Set(events.map((event) => messageIdentity(event)));
}

/** The `(sessionId, seq)` of one section, or undefined when the section is absent. */
export function sectionKey(
  state: DeviceStateDocument | null,
  type: TelemetryEventType,
): OrderKey | undefined {
  const section = state?.[type];
  return section === undefined ? undefined : { sessionId: section.sessionId, seq: section.seq };
}

function describeKey(key: OrderKey | undefined): string {
  return key === undefined ? 'absent' : `(${String(key.sessionId)}, ${String(key.seq)})`;
}

/**
 * Every section and `lastEvent` of `expected` compared with the stored documents; empty when all
 * match, otherwise one line per mismatch, so a failure names the device, the section and both keys.
 */
export async function stateMismatches(env: TestEnvironment, expected: Expected): Promise<string[]> {
  const mismatches: string[] = [];
  for (const [deviceId, sections] of expected.sections) {
    const state = await readState(env, deviceId);
    for (const [type, key] of sections) {
      const stored = sectionKey(state, type);
      if (stored === undefined || stored.sessionId !== key.sessionId || stored.seq !== key.seq) {
        mismatches.push(
          `${deviceId}.${type}: stored ${describeKey(stored)}, expected ${describeKey(key)}`,
        );
      }
    }
    const last = expected.lastEvent.get(deviceId);
    const storedLast = state?.lastEvent;
    if (
      last !== undefined &&
      (storedLast === undefined ||
        storedLast.sessionId !== last.sessionId ||
        storedLast.seq !== last.seq)
    ) {
      mismatches.push(
        `${deviceId}.lastEvent: stored ${describeKey(storedLast)}, expected ${describeKey(last)}`,
      );
    }
  }
  return mismatches;
}
