/**
 * Exhaustiveness guard for discriminated unions. Reaching it at runtime means a
 * new variant (for example a new telemetry event type) was added without being
 * handled, so it fails loudly with the offending value instead of silently
 * ignoring it.
 */
export function assertNever(value: never, context = 'unhandled variant'): never {
  throw new Error(`${context}: ${render(value)}`);
}

/**
 * The guard's own message must win, so every step here is allowed to fail. `JSON.stringify` throws
 * on a BigInt and on a circular value, and `String` throws on an object with no prototype or with
 * a `toString` that throws — a value that is both circular and unconvertible reaches the last
 * resort, which cannot throw for any input.
 */
function render(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    // Fall through to the conversions below.
  }
  try {
    return String(value);
  } catch {
    return Object.prototype.toString.call(value);
  }
}
