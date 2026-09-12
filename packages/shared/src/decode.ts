import { extractRawIdentity, type RawIdentity } from './identity.js';
import { telemetryMessageSchema, type TelemetryMessage } from './message.js';

export type DecodeFailureReason = 'invalid_json' | 'invalid_schema';

export type DecodeResult =
  | { ok: true; message: TelemetryMessage }
  | { ok: false; reason: DecodeFailureReason; detail: string; identity: RawIdentity };

type IssueLike = { readonly path: readonly PropertyKey[]; readonly message: string };

/**
 * Upper bound on `detail`. A zod `unrecognized_keys` issue quotes the offending key names
 * verbatim, so a device controls that text: without a cap, one 64 KiB frame of junk keys becomes
 * a 64 KiB log line. Verified against zod 4.6.2; `invalid_value` does not echo the received value.
 */
const MAX_DETAIL_LENGTH = 512;

/**
 * Turns the text of one frame into a validated message or a structured rejection. Never throws:
 * invalid input is a normal path that the caller logs (with `identity`) and drops.
 *
 * The caller must bound `text` before calling. Ingest gets that from `FrameDecoder`
 * (`MAX_FRAME_BYTES`); the AMQP consumer in processing has to bound the body itself.
 */
export function decodeTelemetryMessage(text: string): DecodeResult {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { ok: false, reason: 'invalid_json', detail, identity: {} };
  }
  const result = telemetryMessageSchema.safeParse(value);
  if (result.success) {
    return { ok: true, message: result.data };
  }
  return {
    ok: false,
    reason: 'invalid_schema',
    detail: formatIssues(result.error.issues),
    identity: extractRawIdentity(value),
  };
}

function formatIssues(issues: readonly IssueLike[]): string {
  const detail = issues
    .map(
      (issue) =>
        `${issue.path.length === 0 ? '(root)' : issue.path.map(String).join('.')}: ${issue.message}`,
    )
    .join('; ');
  return detail.length <= MAX_DETAIL_LENGTH
    ? detail
    : `${detail.slice(0, MAX_DETAIL_LENGTH)}… (truncated from ${detail.length} characters)`;
}
