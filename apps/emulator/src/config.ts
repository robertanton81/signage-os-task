import {
  DEVICE_ID_MAX_LENGTH,
  DEVICE_ID_PATTERN,
  envInt,
  loadConfig,
  logLevelEnv,
  shutdownEnv,
} from '@telemetry/shared';
import { z } from 'zod';

import { parseChaosModes, type ParseResult } from './chaos.js';

export type IngestHost = { host: string; port: number };

/** Zero-padded to four digits, widening past 9 999: `dev-0001`, `dev-12345`. */
export const DEVICE_INDEX_PAD = 4;

const PORT_MIN = 1;
const PORT_MAX = 65_535;

/** `host:port`, where an IPv6 literal is bracketed so its colons cannot be confused for the separator. */
const HOST_PORT = /^(\[[0-9A-Fa-f:]+\]|[^:\s]+):(\d{1,5})$/;

/** The one place the device id format lives; the config cross-check and the fleet both use it. */
export function formatDeviceId(prefix: string, index: number): string {
  return `${prefix}-${String(index).padStart(DEVICE_INDEX_PAD, '0')}`;
}

/**
 * Each entry is trimmed, not only the whole string, and empties are dropped. Reports rather than
 * throws, because it runs inside a zod transform (see `ParseResult`).
 */
export function parseIngestHosts(raw: string): ParseResult<IngestHost[]> {
  const hosts: IngestHost[] = [];
  for (const entry of raw.split(',').map((part) => part.trim())) {
    if (entry === '') continue;
    const match = HOST_PORT.exec(entry);
    const host = match?.[1];
    const port = Number(match?.[2]);
    if (host === undefined || !Number.isInteger(port) || port < PORT_MIN || port > PORT_MAX) {
      return { ok: false, message: `must be a comma-separated list of host:port (port 1-65535)` };
    }
    hosts.push({ host: host.replace(/^\[|\]$/g, ''), port });
  }
  if (hosts.length === 0) {
    return { ok: false, message: 'must list at least one host:port' };
  }
  return { ok: true, value: hosts };
}

/**
 * Bridges a reporting parser into zod's issue channel.
 *
 * `ctx.addIssue` + `z.NEVER`, never a throw: a throw inside a transform escapes `safeParse`
 * entirely rather than becoming an issue, so it would bypass `ConfigError`, lose the variable
 * name, and could print the rejected value. Measured against zod 4.6.2.
 */
function parsedString<T>(defaultValue: string, parse: (raw: string) => ParseResult<T>) {
  return z
    .string()
    .default(defaultValue)
    .transform((raw, ctx) => {
      const result = parse(raw);
      if (!result.ok) {
        ctx.addIssue({ code: 'custom', message: result.message });
        return z.NEVER;
      }
      return result.value;
    });
}

/**
 * No explicit type annotation on purpose. `EmulatorConfig` is `z.output<typeof
 * emulatorEnvSchema>`, so annotating the schema as `z.ZodType<EmulatorConfig>` would make the
 * alias reference itself and TypeScript would reject it. Inference flows one way only — the same
 * reason `telemetryMessageSchema` in `packages/shared` carries no annotation.
 *
 * `z.object`, never `.strict()`: a service runs with hundreds of unrelated environment variables.
 */
export const emulatorEnvSchema = z
  .object({
    ...logLevelEnv,
    ...shutdownEnv,
    EMULATOR_DEVICE_COUNT: envInt(1, 10),
    EMULATOR_DEVICE_ID_PREFIX: z
      .string()
      .regex(/^[A-Za-z0-9_]+$/, 'must contain only letters, digits and underscores')
      .default('dev'),
    EMULATOR_EVENT_INTERVAL_MS: envInt(1, 1_000),
    EMULATOR_HEARTBEAT_MS: envInt(1, 30_000),
    EMULATOR_OUTBOX_MAX: envInt(1, 1_000),
    EMULATOR_SEED: envInt(0, 1),
    // Written out rather than `envInt`: `.default()` produces a ZodDefault, which has no `.max()`.
    EMULATOR_CHAOS_PERCENT: z.coerce.number().int().min(0).max(100).default(5),
    EMULATOR_CHAOS_INTERVAL_MS: envInt(1_000, 60_000),
    EMULATOR_CHAOS: parsedString('', parseChaosModes),
    INGEST_HOSTS: parsedString('ingest:4000', parseIngestHosts),
  })
  .superRefine((value, ctx) => {
    // The longest id is the one that can overflow. Checking it exactly beats a fixed length cap
    // on the prefix, which would be a guess — and failing here, at startup, beats failing as a
    // validation rejection in ingest at message 1 of device 9 999.
    const longest = formatDeviceId(value.EMULATOR_DEVICE_ID_PREFIX, value.EMULATOR_DEVICE_COUNT);
    if (longest.length > DEVICE_ID_MAX_LENGTH || !DEVICE_ID_PATTERN.test(longest)) {
      ctx.addIssue({
        code: 'custom',
        // The explicit path is what makes ConfigError name a variable the operator can act on.
        path: ['EMULATOR_DEVICE_ID_PREFIX'],
        message: `is too long: the id of device ${value.EMULATOR_DEVICE_COUNT} would exceed ${DEVICE_ID_MAX_LENGTH} characters`,
      });
    }
  });

export type EmulatorConfig = z.output<typeof emulatorEnvSchema>;

/**
 * Validates the environment once, at startup. Never wrap the call in a try/catch: an invalid
 * configuration must end the process, not run it in a possibly wrong state.
 */
export function loadEmulatorConfig(env: NodeJS.ProcessEnv = process.env): EmulatorConfig {
  return loadConfig(emulatorEnvSchema, env);
}
