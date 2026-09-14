// End-to-end and scaling check of the Docker Compose development stack (compose spec, decision
// 25). Host-side Node with no dependencies; run it from any directory:
//
//   node scripts/compose-check.mjs [--scale] [--down]
//
// It starts the stack itself (`docker compose up -d --build --wait`), reads the resolved
// configuration for the expected device count and the management-API credentials, and prints one
// PASS or FAIL line per check. Every check runs even after a failure, so one run shows every
// problem; the exit code is 1 when any check failed. `--scale` starts two ingest and three
// processing replicas and adds the two scaling checks. `--down` tears the stack down at the end,
// volumes included; without it the stack stays up so a developer can look at it.
//
// No credential reaches a host command line or this output: MongoDB is queried through
// `docker compose exec` with the container's own environment variables, and the management API
// gets an Authorization header built here from the resolved RABBITMQ_URL (decision 27).
import { execFile, spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs, promisify } from 'node:util';

/** Resolved from this file, so the script runs from any directory and Compose reads the .env next to the file. */
const COMPOSE_FILE = fileURLToPath(new URL('../docker-compose.yml', import.meta.url));
const SCALE = { ingest: 2, processing: 3 };
const UP_WAIT_TIMEOUT_S = 300;
const MONGODB_BUDGET_MS = 120_000;
/** The management API's queue counts lag by collect_statistics_interval, 5 s (decision 26). */
const CONSUMERS_BUDGET_MS = 30_000;
/** Ingest writes its `summary` line every 10 s; three intervals cover a line written after the last device connected. */
const SPREAD_BUDGET_MS = 30_000;
const MANAGEMENT_URL = 'http://127.0.0.1:15672';
/** packages/shared/src/topology.ts, TELEMETRY_QUEUE: the queue every processing replica consumes. */
const TELEMETRY_QUEUE = 'telemetry.events';
/** The processing default (packages/shared/src/config.ts, MONGODB_DB) and the collection names of packages/shared/src/collections.ts. */
const MONGODB_DB = 'telemetry';
const MONGO_EVAL =
  'JSON.stringify({state: db.device_state.countDocuments({}), events: db.events.countDocuments({}), alerts: db.alerts.countDocuments({})})';
/** `docker logs` of a long run exceeds execFile's 1 MiB default, which would kill the child and truncate. */
const MAX_BUFFER = 64 * 1024 * 1024;

const run = promisify(execFile);
const out = (text) => process.stdout.write(`${text}\n`);

const { values: flags } = parseArgs({
  options: {
    scale: { type: 'boolean', default: false },
    down: { type: 'boolean', default: false },
  },
});

/** Runs a docker compose subcommand and returns its stdout. */
async function compose(args) {
  const { stdout } = await run('docker', ['compose', '-f', COMPOSE_FILE, ...args], {
    maxBuffer: MAX_BUFFER,
  });
  return stdout;
}

/** Runs a docker compose subcommand with the terminal attached (build progress, Healthy lines); resolves with its exit code. */
function composeAttached(args) {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', ['compose', '-f', COMPOSE_FILE, ...args], { stdio: 'inherit' });
    child.on('error', reject);
    child.on('close', (code) => resolve(code ?? 1));
  });
}

/**
 * Polls `probe` until it returns a value other than undefined or the budget is spent. A probe
 * that throws counts as "not yet" (mongosh before the server answers, fetch before the management
 * listener is up); the last error is reported when the budget runs out.
 */
async function waitFor({ probe, budgetMs, intervalMs = 1000 }) {
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

let failures = 0;
function report({ name, ok, detail }) {
  if (!ok) failures += 1;
  out(`${ok ? 'PASS' : 'FAIL'} ${name} — ${detail}`);
}

async function runChecks() {
  // --- 1. start: `--wait` returns 0 only when every service with a health check is healthy -----
  const upArgs = ['up', '-d', '--build', '--wait', '--wait-timeout', String(UP_WAIT_TIMEOUT_S)];
  if (flags.scale) {
    for (const [service, count] of Object.entries(SCALE)) {
      upArgs.push('--scale', `${service}=${String(count)}`);
    }
  }
  const upExit = await composeAttached(upArgs);
  report({
    name: 'stack up and healthy',
    ok: upExit === 0,
    detail: `docker compose up --wait exited with ${String(upExit)}${flags.scale ? ' (scaled)' : ''}`,
  });

  // --- 2. resolved configuration: expected device count, replica ids, management credentials ----
  // Checks 3–5 need these values, so a failure here is reported once and ends the checks; the
  // summary line and the teardown still run.
  let resolved;
  try {
    const config = JSON.parse(await compose(['config', '--format', 'json']));
    const amqp = new URL(config.services.processing.environment.RABBITMQ_URL);
    resolved = {
      devices: Number(config.services.emulator.environment.EMULATOR_DEVICE_COUNT),
      authorization: `Basic ${Buffer.from(
        `${decodeURIComponent(amqp.username)}:${decodeURIComponent(amqp.password)}`,
      ).toString('base64')}`,
      ingestIds: (await compose(['ps', '-q', 'ingest'])).trim().split('\n').filter(Boolean),
      processingIds: (await compose(['ps', '-q', 'processing'])).trim().split('\n').filter(Boolean),
    };
  } catch (error) {
    report({
      name: 'resolved configuration',
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
    });
    return;
  }
  const { devices, authorization, ingestIds, processingIds } = resolved;
  out(
    `config: devices=${String(devices)} ingest=${String(ingestIds.length)} processing=${String(processingIds.length)}`,
  );

  // --- 3. data reaches MongoDB: one device_state document per device, events flowing -----------
  // Exactly the fleet size, not at least: device_state is keyed by device id, so a higher count
  // means a previous run's data is still in the volume (reset with `docker compose down -v`) and
  // a lower one means devices are missing. Either way the FAIL line shows the last counts read.
  let lastCounts;
  const counts = await waitFor({
    probe: async () => {
      const stdout = await compose([
        'exec',
        '-T',
        'mongodb',
        'sh',
        '-c',
        `mongosh --quiet -u "$MONGO_INITDB_ROOT_USERNAME" -p "$MONGO_INITDB_ROOT_PASSWORD" --authenticationDatabase admin ${MONGODB_DB} --eval '${MONGO_EVAL}'`,
      ]);
      lastCounts = JSON.parse(stdout.trim());
      return lastCounts.state === devices && lastCounts.events > 0 ? lastCounts : undefined;
    },
    budgetMs: MONGODB_BUDGET_MS,
  });
  const countsSeen =
    lastCounts === undefined
      ? 'no counts read'
      : `device_state=${String(lastCounts.state)} events=${String(lastCounts.events)} alerts=${String(lastCounts.alerts)}`;
  let countsProblem = '';
  if (!counts.ok) {
    countsProblem = `; ${counts.detail}`;
    if (lastCounts !== undefined && lastCounts.state > devices) {
      countsProblem +=
        '; more documents than devices: a previous run is still in the volume, reset with docker compose down -v';
    }
  }
  report({
    name: 'data reaches MongoDB',
    ok: counts.ok,
    detail: `${countsSeen} expected_devices=${String(devices)}${countsProblem}`,
  });

  if (!flags.scale) return;

  // --- 4. one consumer per processing replica, from the management API (polled, decision 26) ----
  let lastConsumers;
  const consumers = await waitFor({
    probe: async () => {
      const response = await fetch(`${MANAGEMENT_URL}/api/queues/%2F/${TELEMETRY_QUEUE}`, {
        headers: { authorization },
      });
      if (!response.ok) throw new Error(`management API answered ${String(response.status)}`);
      const queue = await response.json();
      lastConsumers = queue.consumers;
      return lastConsumers === processingIds.length ? lastConsumers : undefined;
    },
    budgetMs: CONSUMERS_BUDGET_MS,
  });
  const consumersSeen = lastConsumers === undefined ? 'none read' : String(lastConsumers);
  report({
    name: 'one consumer per processing replica',
    ok: consumers.ok,
    detail: `consumers=${consumersSeen} expected=${String(processingIds.length)}${consumers.ok ? '' : `; ${consumers.detail}`}`,
  });

  // --- 5. devices spread over every ingest replica: `open` of each replica's last summary line ---
  // `none` means the replica has written no summary line yet: the line is written at info every
  // 10 s, so LOG_LEVEL must be info or lower for this check.
  let split = [];
  const spread = await waitFor({
    probe: async () => {
      split = [];
      for (const id of ingestIds) {
        const { stdout } = await run('docker', ['logs', id], { maxBuffer: MAX_BUFFER });
        const last = stdout
          .split('\n')
          .filter((line) => line.includes('"msg":"summary"'))
          .at(-1);
        split.push(last === undefined ? undefined : Number(JSON.parse(last).open));
      }
      const total = split.reduce((sum, value) => sum + (value ?? 0), 0);
      const everyReplicaHasDevices = split.every((value) => value !== undefined && value > 0);
      return everyReplicaHasDevices && total === devices ? split : undefined;
    },
    budgetMs: SPREAD_BUDGET_MS,
  });
  const rendered = split.map((value) => (value === undefined ? 'none' : String(value)));
  report({
    name: 'devices spread over every ingest replica',
    ok: spread.ok,
    detail: `split=[${rendered.join(', ')}] expected_total=${String(devices)}${spread.ok ? '' : `; ${spread.detail}`}`,
  });
}

try {
  await runChecks();
} finally {
  // --- 6. teardown: only with --down; otherwise leave the stack for inspection ------------------
  if (flags.down) {
    const downExit = await composeAttached(['down', '-v']);
    report({
      name: 'stack down, volumes removed',
      ok: downExit === 0,
      detail: `docker compose down -v exited with ${String(downExit)}`,
    });
  } else {
    out('stack left running; reset from the repository root with: docker compose down -v');
  }
}

out(failures === 0 ? 'ALL PASS' : `${String(failures)} FAILED`);
process.exit(failures === 0 ? 0 : 1);
