import { extractRawIdentity, type RawIdentity } from './identity.js';
import { telemetryMessageSchema, type TelemetryMessage } from './message.js';

export type DecodeFailureReason = 'invalid_json' | 'invalid_schema';

export type DecodeResult =
  | { ok: true; message: TelemetryMessage }
  | { ok: false; reason: DecodeFailureReason; detail: string; identity: RawIdentity };

type IssueLike = { readonly path: readonly PropertyKey[]; readonly message: string };

/**
 * Upper bound on the text of one issue. A zod `unrecognized_keys` issue quotes the offending key
 * names verbatim, so a device controls that text: without a cap, one 64 KiB frame of junk keys
 * becomes a 64 KiB log line. The cap is per issue, not per `detail`, so the path of every failing
 * field survives however long one message is. `JSON.parse` messages get the same cap: V8 quotes a
 * window of the input, and how long that window is belongs to the engine, not to this code.
 * Verified against zod 4.6.2; `unrecognized_keys` is the only issue that echoes received text.
 *
 * The whole `detail` stays bounded only because the contract has no array or record field and is
 * at most two `strictObject` levels deep, which caps the issue count at a small constant (measured
 * worst case: 11 issues, 993 bytes). Re-derive that if the contract gains either.
 */
const MAX_ISSUE_MESSAGE_LENGTH = 200;

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
    const detail = cap(error instanceof Error ? error.message : String(error));
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
  return issues
    .map((issue) => {
      const path = issue.path.length === 0 ? '(root)' : issue.path.map(String).join('.');
      // The join token is removed from the message before joining. A device chooses its own JSON
      // key names, and zod's `unrecognized_keys` message quotes them verbatim, so a key named
      // `; deviceId: device is on fire` would otherwise render one real issue as two and forge a
      // failure of a field that actually validated. Path segments cannot be forged: every object
      // in the contract is a `strictObject`, so a segment only ever comes from the schema.
      return `${path}: ${cap(issue.message).replaceAll('; ', ', ')}`;
    })
    .join('; ');
}

function cap(text: string): string {
  return text.length <= MAX_ISSUE_MESSAGE_LENGTH
    ? text
    : `${text.slice(0, MAX_ISSUE_MESSAGE_LENGTH)}… (truncated from ${text.length} characters)`;
}
