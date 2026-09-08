/**
 * Exhaustiveness guard for discriminated unions. Reaching it at runtime means a
 * new variant (for example a new telemetry event type) was added without being
 * handled, so it fails loudly with the offending value instead of silently
 * ignoring it.
 */
export function assertNever(value: never, context = 'unhandled variant'): never {
  throw new Error(`${context}: ${JSON.stringify(value)}`);
}
