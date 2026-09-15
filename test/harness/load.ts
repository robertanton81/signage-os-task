import {
  assertNever,
  isNewer,
  messageIdentity,
  type OrderKey,
  type TelemetryEventType,
  type TelemetryMessage,
} from '@telemetry/shared';

import { createRandom, type Random } from '../../apps/emulator/src/random.js';

/**
 * The seeded load generator of the load-shaped tests (integration spec, decision 17): the ordered
 * list of messages to send, duplicates and swaps included, together with the expectation computed
 * from that list alone. An expectation derived from what was stored could not see a message that
 * was dropped on the way; this one can.
 */
export type LoadOptions = {
  devices: number;
  messages: number;
  /** Share of all messages that go to the first device, the hot one; 0 spreads evenly. */
  hotShare: number;
  /** Percentage of sends that appear twice in a row. */
  duplicatePercent: number;
  /** Percentage of adjacent pairs of one device's stream that are swapped. */
  swapPercent: number;
  seed: number;
  /** Device ids are `${deviceIdPrefix}-NNNN` by index, independent of the seed; default `load`. */
  deviceIdPrefix?: string;
};

export type Expected = {
  /** Every distinct message identity string. */
  identities: Set<string>;
  /** Per device, per section, the highest `(sessionId, seq)` sent. */
  sections: Map<string, Map<TelemetryEventType, OrderKey>>;
  /** Per device, the highest key of any type. */
  lastEvent: Map<string, OrderKey>;
  /** How many sends are a second copy of an earlier one. */
  duplicates: number;
  /** The identity strings of the error diagnostics: the alerts. */
  alerts: Set<string>;
};

export type Load = { sends: TelemetryMessage[]; expected: Expected };

/** One session per device, inside the contract's window. */
export const LOAD_SESSION_ID = 1_700_000_000_000;
const TYPES = ['status', 'metrics', 'counters', 'diagnostic'] as const;
/** Every tenth message of a device is an error diagnostic, so the alerts are a known set. */
const ERROR_EVERY = 10;
const DEVICE_INDEX_PAD = 4;

/** `${prefix}-0001`: the emulator's id shape (`apps/emulator/src/config.ts`, `formatDeviceId`). */
export function loadDeviceId(prefix: string, index: number): string {
  return `${prefix}-${String(index).padStart(DEVICE_INDEX_PAD, '0')}`;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function buildMessage({
  deviceId,
  seq,
  random,
}: {
  deviceId: string;
  seq: number;
  random: Random;
}): TelemetryMessage {
  const base = {
    v: 1 as const,
    deviceId,
    sessionId: LOAD_SESSION_ID,
    seq,
    occurredAt: LOAD_SESSION_ID + seq * 1000,
  };
  if (seq % ERROR_EVERY === 0) {
    return {
      ...base,
      type: 'diagnostic',
      payload: {
        severity: 'error',
        code: 'E_OVERHEAT',
        message: `temperature above threshold at seq ${String(seq)}`,
      },
    };
  }
  const type = TYPES[(seq - 1) % TYPES.length] ?? 'status';
  switch (type) {
    case 'status':
      return { ...base, type, payload: { state: random.bool(0.1) ? 'degraded' : 'online' } };
    case 'metrics':
      return {
        ...base,
        type,
        payload: {
          temperatureC: round2(random.range(30, 60)),
          cpuPercent: round2(random.range(0, 100)),
          ramPercent: round2(random.range(0, 100)),
        },
      };
    case 'counters':
      // Cumulative per session (consistency spec, decision 6): monotonic in `seq`.
      return { ...base, type, payload: { operationsTotal: seq * 10, uptimeMs: seq * 1000 } };
    case 'diagnostic':
      return {
        ...base,
        type,
        payload: { severity: 'info', code: 'E_NET_RETRY', message: 'retrying' },
      };
    default:
      return assertNever(type, 'event type');
  }
}

/** The hot device takes `hotShare` of the messages; the rest is spread evenly, remainder first. */
function distribute({
  devices,
  messages,
  hotShare,
}: Pick<LoadOptions, 'devices' | 'messages' | 'hotShare'>): number[] {
  if (
    !Number.isInteger(devices) ||
    devices < 1 ||
    !Number.isInteger(messages) ||
    messages < devices
  ) {
    throw new Error('generateLoad: needs at least one device and one message per device');
  }
  const counts = new Array<number>(devices).fill(0);
  const hot =
    hotShare > 0 && devices > 1
      ? Math.min(Math.round(messages * hotShare), messages - (devices - 1))
      : 0;
  const first = hot > 0 ? 1 : 0;
  if (hot > 0) {
    counts[0] = hot;
  }
  const rest = messages - hot;
  const others = devices - first;
  for (let index = first; index < devices; index += 1) {
    counts[index] = Math.floor(rest / others) + (index - first < rest % others ? 1 : 0);
  }
  return counts;
}

/** One device's stream in `seq` order, with a share of adjacent pairs swapped; pairs never overlap. */
function deviceStream({
  deviceId,
  count,
  swapPercent,
  random,
}: {
  deviceId: string;
  count: number;
  swapPercent: number;
  random: Random;
}): TelemetryMessage[] {
  const stream = Array.from({ length: count }, (_, index) =>
    buildMessage({ deviceId, seq: index + 1, random }),
  );
  for (let index = 0; index + 1 < stream.length; index += 1) {
    if (random.bool(swapPercent / 100)) {
      const earlier = stream[index];
      const later = stream[index + 1];
      if (earlier !== undefined && later !== undefined) {
        stream[index] = later;
        stream[index + 1] = earlier;
      }
      index += 1;
    }
  }
  return stream;
}

/** A draw weighted by what each device still has to send, so the hot device stays hot throughout. */
function interleave(
  streams: readonly (readonly TelemetryMessage[])[],
  random: Random,
): TelemetryMessage[] {
  const cursors = streams.map(() => 0);
  const out: TelemetryMessage[] = [];
  let remaining = streams.reduce((sum, stream) => sum + stream.length, 0);
  while (remaining > 0) {
    let pick = random.int(1, remaining);
    for (let device = 0; device < streams.length; device += 1) {
      const stream = streams[device] ?? [];
      const cursor = cursors[device] ?? 0;
      const left = stream.length - cursor;
      if (pick <= left) {
        const message = stream[cursor];
        if (message !== undefined) {
          out.push(message);
        }
        cursors[device] = cursor + 1;
        break;
      }
      pick -= left;
    }
    remaining -= 1;
  }
  return out;
}

function withDuplicates(
  ordered: readonly TelemetryMessage[],
  { duplicatePercent, random }: { duplicatePercent: number; random: Random },
): { sends: TelemetryMessage[]; duplicates: number } {
  const sends: TelemetryMessage[] = [];
  let duplicates = 0;
  for (const message of ordered) {
    sends.push(message);
    if (random.bool(duplicatePercent / 100)) {
      sends.push(message);
      duplicates += 1;
    }
  }
  return { sends, duplicates };
}

/** The expectation computed from the sends alone: what the pipeline must end with. */
export function expectationOf(sends: readonly TelemetryMessage[]): Expected {
  const identities = new Set<string>();
  const sections = new Map<string, Map<TelemetryEventType, OrderKey>>();
  const lastEvent = new Map<string, OrderKey>();
  const alerts = new Set<string>();
  let duplicates = 0;
  for (const message of sends) {
    const identity = messageIdentity(message);
    if (identities.has(identity)) {
      duplicates += 1;
      continue;
    }
    identities.add(identity);
    const key: OrderKey = { sessionId: message.sessionId, seq: message.seq };
    const device = sections.get(message.deviceId) ?? new Map<TelemetryEventType, OrderKey>();
    const section = device.get(message.type);
    if (section === undefined || isNewer(key, section)) {
      device.set(message.type, key);
    }
    sections.set(message.deviceId, device);
    const last = lastEvent.get(message.deviceId);
    if (last === undefined || isNewer(key, last)) {
      lastEvent.set(message.deviceId, key);
    }
    if (message.type === 'diagnostic' && message.payload.severity === 'error') {
      alerts.add(identity);
    }
  }
  return { identities, sections, lastEvent, duplicates, alerts };
}

export function generateLoad({
  devices,
  messages,
  hotShare,
  duplicatePercent,
  swapPercent,
  seed,
  deviceIdPrefix = 'load',
}: LoadOptions): Load {
  const random = createRandom(seed);
  const streams = distribute({ devices, messages, hotShare }).map((count, index) =>
    deviceStream({ deviceId: loadDeviceId(deviceIdPrefix, index + 1), count, swapPercent, random }),
  );
  const { sends, duplicates } = withDuplicates(interleave(streams, random), {
    duplicatePercent,
    random,
  });
  const expected = expectationOf(sends);
  if (expected.duplicates !== duplicates || expected.identities.size !== messages) {
    throw new Error('generateLoad: the expectation does not match the sends');
  }
  return { sends, expected };
}

/** Two expectations of disjoint device populations as one; a shared device is a programmer error. */
export function mergeExpected(a: Expected, b: Expected): Expected {
  for (const deviceId of b.sections.keys()) {
    if (a.sections.has(deviceId)) {
      throw new Error(`mergeExpected: device ${deviceId} is in both expectations`);
    }
  }
  return {
    identities: new Set([...a.identities, ...b.identities]),
    sections: new Map([...a.sections, ...b.sections]),
    lastEvent: new Map([...a.lastEvent, ...b.lastEvent]),
    duplicates: a.duplicates + b.duplicates,
    alerts: new Set([...a.alerts, ...b.alerts]),
  };
}
