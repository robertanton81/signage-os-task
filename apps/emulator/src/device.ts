import {
  messageIdentity,
  messageLogger,
  type Logger,
  type TelemetryMessage,
} from '@telemetry/shared';

import { ChaosPolicy, type ConnectionChaosMode } from './chaos.js';
import type { EmulatorConfig } from './config.js';
import { DeviceConnection } from './connection.js';
import { Outbox, type OutboxEntry } from './outbox.js';
import type { Random } from './random.js';
import { DeviceSession } from './session.js';

export type DeviceClientOptions = {
  deviceId: string;
  config: EmulatorConfig;
  random: Random;
  logger: Logger;
};

export type DeviceStats = {
  generated: number;
  written: number;
  dropped: number;
  reconnects: number;
};

/**
 * Writes the outbox into the connection, oldest entry first, while the connection takes messages.
 * Returns the entries it wrote, in order.
 *
 * Peek, write, and remove only what the connection took. Shifting first and pushing back on a
 * refused write would put the entry behind anything enqueued in between — the emulator would become
 * the source of the reordering the tests attribute to the broker. Removing on `true` is exact
 * because `write()` counts the message that filled the send buffer as taken; the first version
 * counted it as refused, kept it at the head and wrote it a second time after the buffer drained.
 */
export function pumpOutbox(outbox: Outbox, connection: DeviceConnection): OutboxEntry[] {
  const written: OutboxEntry[] = [];
  for (let entry = outbox.peek(); entry !== null; entry = outbox.peek()) {
    if (!connection.write(entry.text)) break;
    outbox.shift();
    written.push(entry);
  }
  return written;
}

/**
 * One emulated device: its session, its chaos policy, its outbox, its socket and its timers.
 *
 * Everything stateful about a device lives here, and nothing is shared with another client except
 * the logger — which is what makes "different devices are processed in parallel, and events of one
 * device never conflict with each other" true at the source (invariant 4).
 */
export class DeviceClient {
  readonly #deviceId: string;
  readonly #config: EmulatorConfig;
  readonly #logger: Logger;
  readonly #random: Random;
  readonly #session: DeviceSession;
  readonly #chaos: ChaosPolicy;
  readonly #outbox: Outbox;
  readonly #connection: DeviceConnection;

  #tickTimer: NodeJS.Timeout | null = null;
  #heartbeatTimer: NodeJS.Timeout | null = null;
  #chaosTimer: NodeJS.Timeout | null = null;
  #stopped = false;
  #stats: DeviceStats = { generated: 0, written: 0, dropped: 0, reconnects: 0 };

  constructor(options: DeviceClientOptions) {
    const { deviceId, config, random, logger } = options;
    this.#deviceId = deviceId;
    this.#config = config;
    this.#logger = logger;
    this.#random = random;
    this.#session = new DeviceSession({ deviceId, random, now: () => Date.now() });
    // The SAME random instance as the session, so one seed replays the payloads and the chaos
    // decisions together rather than only half of the run.
    this.#chaos = new ChaosPolicy({
      modes: config.EMULATOR_CHAOS,
      percent: config.EMULATOR_CHAOS_PERCENT,
      intervalMs: config.EMULATOR_CHAOS_INTERVAL_MS,
      random,
    });
    this.#outbox = new Outbox(config.EMULATOR_OUTBOX_MAX);
    this.#connection = new DeviceConnection({
      deviceId,
      hosts: config.INGEST_HOSTS,
      random,
      logger,
      onWritable: () => this.pump(),
    });
  }

  get deviceId(): string {
    return this.#deviceId;
  }

  get outboxLength(): number {
    return this.#outbox.length;
  }

  get stats(): DeviceStats {
    return { ...this.#stats };
  }

  get isConnected(): boolean {
    return this.#connection.isConnected;
  }

  get connectionState(): string {
    return this.#connection.state.name;
  }

  start(): void {
    this.#generate(this.#session.start());
    this.#connection.start();
    // A random phase inside the interval, so a fleet does not fire every device in the same
    // millisecond. This is the whole stagger — no separate startup sleep loop. Drawn from the
    // device's seeded stream, not `Math.random()`, or the run would stop being reproducible.
    this.#tickTimer = setTimeout(
      () => this.#onTick(),
      this.#random.range(0, this.#config.EMULATOR_EVENT_INTERVAL_MS),
    );
    this.#armChaos();
  }

  /** Stops every timer and stops generating. Does not drain. */
  stopGenerating(): void {
    this.#stopped = true;
    for (const timer of [this.#tickTimer, this.#heartbeatTimer, this.#chaosTimer]) {
      if (timer !== null) clearTimeout(timer);
    }
    this.#tickTimer = null;
    this.#heartbeatTimer = null;
    this.#chaosTimer = null;
  }

  /**
   * Releases the chaos hold slot and queues the farewell, both bypassing `chaos.apply`.
   *
   * Routing either back through the policy would let the hold slot capture it, and at
   * `EMULATOR_CHAOS_PERCENT: 100` that is deterministic: the farewell would sit inside the policy,
   * `outboxLength` would report 0, and the message would be lost with none of the `warn` the
   * outbox emits when it drops something. The order also keeps the farewell last on the wire,
   * which is what makes it a usable end-of-session marker.
   */
  prepareShutdown(): void {
    this.#push(this.#chaos.flushHeld());
    this.#push(this.#session.farewell());
  }

  /** Drains the outbox into the socket as far as backpressure allows. Synchronous. */
  pump(): void {
    for (const entry of pumpOutbox(this.#outbox, this.#connection)) {
      this.#stats.written += 1;
      messageLogger(this.#logger, entry.message).debug('telemetry message written');
    }
  }

  async stop(): Promise<void> {
    this.stopGenerating();
    await this.#connection.stop();
  }

  #onTick(): void {
    if (this.#stopped) return;
    this.#generate(this.#session.tick());
    this.pump();
    this.#tickTimer = setTimeout(() => this.#onTick(), this.#config.EMULATOR_EVENT_INTERVAL_MS);
  }

  /** The generation path: chaos may duplicate, delay or reorder what goes into the outbox. */
  #generate(messages: readonly TelemetryMessage[]): void {
    for (const message of messages) {
      this.#stats.generated += 1;
      this.#push(this.#chaos.apply(message));
    }
  }

  /** The direct path: anything chaos has already released, and the farewell. */
  #push(messages: readonly TelemetryMessage[]): void {
    for (const message of messages) {
      const evicted = this.#outbox.push(message);
      if (evicted !== null) {
        this.#stats.dropped += 1;
        this.#logger.warn(
          { deviceId: this.#deviceId, dropped: messageIdentity(evicted.message) },
          'outbox full, dropped a message',
        );
      }
    }
    if (messages.some((message) => message.type === 'status')) this.#armHeartbeat();
  }

  /**
   * The status refresh (design spec, decision 26): re-armed whenever a `status` is enqueued — the
   * session start, a transition, the heartbeat itself — and by nothing else. A device therefore
   * sends a `status` at least once per EMULATOR_HEARTBEAT_MS however busy it is, which is what
   * replaces a `status` lost between device and ingest; metrics and counters replace themselves on
   * the next tick. One exception widens that bound by one tick: `out-of-order` chaos can hold the
   * heartbeat's own `status`, and the timer re-arms only when the next tick releases it. The
   * `#stopped` guard keeps `prepareShutdown`'s farewell, itself a `status`, from
   * resurrecting a timer the drain has already cleared — which would put a `status` on the wire
   * after the farewell.
   */
  #armHeartbeat(): void {
    if (this.#stopped) return;
    if (this.#heartbeatTimer !== null) clearTimeout(this.#heartbeatTimer);
    this.#heartbeatTimer = setTimeout(() => {
      if (this.#stopped) return;
      this.#generate(this.#session.heartbeat());
      this.pump();
    }, this.#config.EMULATOR_HEARTBEAT_MS);
  }

  #armChaos(): void {
    if (this.#stopped) return;
    const next = this.#chaos.nextConnectionChaos();
    if (next === null) return;
    this.#chaosTimer = setTimeout(() => this.#onConnectionChaos(next.mode), next.delayMs);
  }

  #onConnectionChaos(mode: ConnectionChaosMode): void {
    if (this.#stopped) return;
    this.#logger.info({ deviceId: this.#deviceId, mode }, 'injecting connection chaos');
    this.#stats.reconnects += 1;
    if (mode === 'disconnect') {
      // Transport loss, not device loss: the session and the outbox survive, so seq continues and
      // the queued messages go out after the reconnect.
      this.#push(this.#chaos.flushHeld());
      this.#connection.dropConnection();
    } else {
      // A power cycle: RAM is gone, so the hold slot and the outbox go with it, and a strictly
      // greater sessionId opens a new order-key space.
      this.#chaos.clearHeld();
      this.#outbox.clear();
      this.#connection.dropConnection();
      this.#generate(this.#session.restart());
    }
    this.#armChaos();
  }
}
