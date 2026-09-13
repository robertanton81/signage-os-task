import type { Logger } from '@telemetry/shared';

import { formatDeviceId, type EmulatorConfig } from './config.js';
import { DeviceClient } from './device.js';
import { createRandom, deviceSeed } from './random.js';

/** One aggregate line per interval, so a Compose run stays readable at a glance. */
export const SUMMARY_INTERVAL_MS = 10_000;

/** How often the drain checks whether the outboxes have emptied. */
const DRAIN_POLL_MS = 10;

export type FleetOptions = {
  config: EmulatorConfig;
  logger: Logger;
  /** Defaults to SUMMARY_INTERVAL_MS; only the tests override it. */
  summaryIntervalMs?: number;
};

/** Every emulated device in this process. */
export class Fleet {
  readonly #config: EmulatorConfig;
  readonly #logger: Logger;
  readonly #summaryIntervalMs: number;
  readonly #clients: DeviceClient[] = [];
  #summaryTimer: NodeJS.Timeout | null = null;
  #shutdown: Promise<void> | null = null;

  constructor(options: FleetOptions) {
    this.#config = options.config;
    this.#logger = options.logger;
    this.#summaryIntervalMs = options.summaryIntervalMs ?? SUMMARY_INTERVAL_MS;
  }

  get devices(): readonly DeviceClient[] {
    return this.#clients;
  }

  start(): void {
    const { EMULATOR_DEVICE_COUNT, EMULATOR_DEVICE_ID_PREFIX, EMULATOR_SEED } = this.#config;
    for (let index = 0; index < EMULATOR_DEVICE_COUNT; index += 1) {
      const client = new DeviceClient({
        deviceId: formatDeviceId(EMULATOR_DEVICE_ID_PREFIX, index + 1),
        config: this.#config,
        // Seeded from the fleet seed and the index, so devices differ from each other while the
        // whole run replays from EMULATOR_SEED.
        random: createRandom(deviceSeed(EMULATOR_SEED, index)),
        logger: this.#logger,
      });
      this.#clients.push(client);
      // Each client's own random tick phase is the stagger; no startup sleep loop.
      client.start();
    }

    this.#summaryTimer = setInterval(() => this.#logSummary(), this.#summaryIntervalMs);
    // Never the reason the process stays alive.
    this.#summaryTimer.unref();
  }

  /**
   * The shutdown drain: best-effort, bounded, and loud about what it could not deliver.
   *
   * 1. Clear the summary interval and every client's timers, so nothing new is generated.
   * 2. Flush each client's chaos hold slot, then queue its farewell.
   * 3. Pump and wait for the outboxes to empty, or for SHUTDOWN_TIMEOUT_MS.
   * 4. Log a `warn` for every device that still holds messages.
   * 5. Close the sockets.
   *
   * Step 1 before step 2 is why `DeviceClient` needs its stopped flag, and step 4 exists because
   * the drain really can fail: the backoff cap and the default shutdown budget are both 10 000 ms,
   * so a device that is reconnecting when SIGTERM arrives may never get a writable socket. Every
   * other loss path in this system logs what it lost; so does this one.
   */
  async shutdown(): Promise<void> {
    // Idempotent, and it has to be: SIGTERM followed by SIGINT calls this twice, and a second
    // pass would queue a second farewell that no longer has a writable socket to go out on — the
    // drain would then wait out its whole budget for a message it can never send.
    this.#shutdown ??= this.#runShutdown();
    return this.#shutdown;
  }

  async #runShutdown(): Promise<void> {
    if (this.#summaryTimer !== null) {
      clearInterval(this.#summaryTimer);
      this.#summaryTimer = null;
    }
    for (const client of this.#clients) client.stopGenerating();
    for (const client of this.#clients) client.prepareShutdown();

    await this.#drain();

    for (const client of this.#clients) {
      if (client.outboxLength > 0) {
        this.#logger.warn(
          {
            deviceId: client.deviceId,
            remaining: client.outboxLength,
            state: client.connectionState,
          },
          'shutdown timed out with messages still queued',
        );
      }
    }

    await Promise.all(this.#clients.map((client) => client.stop()));
    this.#logSummary();
  }

  /**
   * Resolves when every outbox is empty or the budget runs out.
   *
   * A poll rather than a sleep: `pump()` is synchronous and the background draining is driven by
   * the connection's writable callback, so this loop calls the pump and reads `outboxLength` until
   * both conditions are settled. Bounded on both ends — it cannot hang, and it does not wait
   * longer than it has to.
   *
   * The poll timer is the one timer here that stays referenced, on purpose. A pending promise does
   * not keep Node running. Step 1 has cleared the tick, heartbeat and chaos timers and the summary
   * interval, so the only other timers left are the devices' reconnect backoffs, and those are
   * unreferenced. With every device in backoff and no socket open, an unreferenced poll let the
   * process exit in the middle of the drain — no loss warning, no summary, exit code 0. The budget
   * bounds how long this timer keeps the process up.
   */
  #drain(): Promise<void> {
    const deadline = Date.now() + this.#config.SHUTDOWN_TIMEOUT_MS;
    return new Promise<void>((resolve) => {
      const check = () => {
        for (const client of this.#clients) client.pump();
        const pending = this.#clients.some((client) => client.outboxLength > 0);
        if (!pending || Date.now() >= deadline) {
          resolve();
          return;
        }
        setTimeout(check, DRAIN_POLL_MS);
      };
      check();
    });
  }

  #logSummary(): void {
    const totals = this.#clients.reduce(
      (sum, client) => {
        const stats = client.stats;
        return {
          generated: sum.generated + stats.generated,
          written: sum.written + stats.written,
          dropped: sum.dropped + stats.dropped,
          reconnects: sum.reconnects + stats.reconnects,
          connected: sum.connected + (client.isConnected ? 1 : 0),
        };
      },
      { generated: 0, written: 0, dropped: 0, reconnects: 0, connected: 0 },
    );
    this.#logger.info({ devices: this.#clients.length, ...totals }, 'emulator fleet summary');
  }
}
