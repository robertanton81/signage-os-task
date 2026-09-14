import type { ReadinessReport } from '@telemetry/shared';

import { isConsuming, type ConsumerState } from './consumer-state.js';

export type ProcessingReadinessReason = 'connecting' | 'mongodb' | 'shutting_down';

/**
 * What `/readyz` reports (processing spec, decision 19): ready while the consumer is registered on
 * an open link with the store ready and the instance is not shutting down. Shutting down wins over
 * everything; then `mongodb` while the store is not ready, which includes a paused consumer, so the
 * reason names the dependency an operator should look at; every other state reads as `connecting`.
 * The server that answers the request is `startHealthServer` from the shared package.
 */
export function readinessReport({
  consumerState,
  shuttingDown,
}: {
  consumerState: ConsumerState;
  shuttingDown: boolean;
}): ReadinessReport<ProcessingReadinessReason> {
  if (shuttingDown) {
    return { ready: false, reason: 'shutting_down' };
  }
  if (!consumerState.storeReady) {
    return { ready: false, reason: 'mongodb' };
  }
  return isConsuming(consumerState) ? { ready: true } : { ready: false, reason: 'connecting' };
}
