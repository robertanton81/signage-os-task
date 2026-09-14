// The pure parts of scripts/compose-check.mjs: the poll, the pass rules of the MongoDB and the
// spread checks, and the rendering of their lines. Nothing here touches Docker, so these are
// unit-tested in compose-check-lib.test.mjs; the Docker-driving runner is proven by its recorded
// runs (compose plan, Task 4).
import { setTimeout as sleep } from 'node:timers/promises';

/**
 * Polls `probe` until it returns a value other than undefined or the budget is spent. A probe
 * that throws counts as "not yet" (mongosh before the server answers, fetch before the management
 * listener is up); the last error is reported when the budget runs out.
 */
export async function waitFor({ probe, budgetMs, intervalMs = 1000 }) {
  const deadline = Date.now() + budgetMs;
  let lastError;
  for (;;) {
    try {
      const value = await probe();
      if (value !== undefined) return { ok: true, value };
    } catch (error) {
      lastError = error;
    }
    if (Date.now() >= deadline) {
      const reason = lastError instanceof Error ? lastError.message : String(lastError);
      return {
        ok: false,
        detail: lastError === undefined ? 'timed out' : `timed out; last error: ${reason}`,
      };
    }
    await sleep(intervalMs);
  }
}

/**
 * The pass rule of the MongoDB check: one device_state document per device and at least one
 * event. Exactly the fleet size, not at least: device_state is keyed by device id, so a higher
 * count can only be a previous run's data still in the volume, and a lower one means devices are
 * missing.
 */
export function countsReached({ counts, devices }) {
  return counts.state === devices && counts.events > 0;
}

/**
 * The detail of the MongoDB check's PASS or FAIL line: the last counts read (or that none were),
 * the expected fleet size and, on a failure, why. A surplus of documents gets the hint that names
 * the reset command, because it looks like a working stack when it is stale data.
 */
export function countsDetail({ counts, devices, failure }) {
  const seen =
    counts === undefined
      ? 'no counts read'
      : `device_state=${String(counts.state)} events=${String(counts.events)} alerts=${String(counts.alerts)}`;
  let problem = '';
  if (failure !== undefined) {
    problem = `; ${failure}`;
    if (counts !== undefined && counts.state > devices) {
      problem +=
        '; more documents than devices: a previous run is still in the volume, reset with docker compose down -v';
    }
  }
  return `${seen} expected_devices=${String(devices)}${problem}`;
}

/**
 * `open` of the last `summary` line in one ingest replica's log, or undefined when the replica
 * has written none yet. The last line, not the first: the count grows while devices connect.
 */
export function parseLastSummaryOpen(logText) {
  const last = logText
    .split('\n')
    .filter((line) => line.includes('"msg":"summary"'))
    .at(-1);
  return last === undefined ? undefined : Number(JSON.parse(last).open);
}

/**
 * The pass rule of the spread check: every replica holds at least one device and the per-replica
 * counts sum to the fleet. An undefined entry is a replica without a summary line yet.
 */
export function splitCoversFleet({ split, devices }) {
  const total = split.reduce((sum, value) => sum + (value ?? 0), 0);
  return split.every((value) => value !== undefined && value > 0) && total === devices;
}
