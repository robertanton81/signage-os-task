/** MongoDB names and index definitions (consistency spec, "MongoDB collections and indexes"). */
export const EVENTS_COLLECTION = 'events';
export const DEVICE_STATE_COLLECTION = 'device_state';
export const ALERTS_COLLECTION = 'alerts';

/** The dedup key (decision 9a), unique. Its prefixes serve per-device and per-session reads. */
export const EVENTS_IDENTITY_INDEX = { deviceId: 1, sessionId: 1, seq: 1 } as const;
export const EVENTS_IDENTITY_INDEX_NAME = 'identity_unique';

/**
 * The whole index description for `createIndexes`, so that `unique: true` — the one option
 * invariant 2 depends on — is defined once. Processing must create it before it consumes.
 */
export const EVENTS_IDENTITY_INDEX_SPEC = {
  key: EVENTS_IDENTITY_INDEX,
  name: EVENTS_IDENTITY_INDEX_NAME,
  unique: true,
} as const;

/** Server error code of a unique-index violation (`DuplicateKey`); the driver has no named constant. */
export const DUPLICATE_KEY_ERROR_CODE = 11000;
