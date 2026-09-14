import type { ReadinessReport } from '@telemetry/shared';

import type { PublisherState } from './publisher-state.js';

export type IngestReadinessReason = 'connecting' | 'blocked' | 'shutting_down';

/**
 * What `/readyz` reports (ingest spec, decision 17). The instance is ready when the publisher is
 * ready — connected, confirm channel open, topology declared, not blocked — and the instance is
 * not shutting down. Shutting down wins over every publisher state; `blocked` applies only to a
 * connection that is otherwise ready; every other state reads as `connecting`. The server that
 * answers the request is `startHealthServer` from the shared package.
 */
export function readinessReport({
  publisherState,
  shuttingDown,
}: {
  publisherState: PublisherState;
  shuttingDown: boolean;
}): ReadinessReport<IngestReadinessReason> {
  if (shuttingDown) {
    return { ready: false, reason: 'shutting_down' };
  }
  if (publisherState.name !== 'ready') {
    return { ready: false, reason: 'connecting' };
  }
  return publisherState.blocked ? { ready: false, reason: 'blocked' } : { ready: true };
}
