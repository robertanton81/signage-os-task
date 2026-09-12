/**
 * RabbitMQ objects (consistency spec, "Queue topology"). Ingest and processing both declare
 * them at startup; a redeclaration with different attributes fails with 406 PRECONDITION_FAILED,
 * so the arguments live here once.
 */
export const TELEMETRY_EXCHANGE = 'telemetry';
export const TELEMETRY_ROUTING_KEY = 'event';
export const TELEMETRY_QUEUE = 'telemetry.events';
export const DEAD_LETTER_EXCHANGE = 'telemetry.dlx';
export const DEAD_LETTER_QUEUE = 'telemetry.dead';

/** Exchange types are part of the declaration, so a mismatch is a 406 just like a wrong argument. */
export const TELEMETRY_EXCHANGE_TYPE = 'direct';
export const DEAD_LETTER_EXCHANGE_TYPE = 'fanout';

/**
 * Quorum queue, dead-lettered after the fifth delivery attempt (decisions 13 and 19).
 * `x-dead-letter-strategy` is deliberately left at its `at-most-once` default: `at-least-once`
 * would additionally require `overflow: reject-publish`, the `stream_queue` feature flag and a
 * `max-length` bound, and it buys nothing here because nothing consumes `telemetry.dead` — the
 * dead-lettered messages are informational and read in the management UI (trade-off T8).
 * https://www.rabbitmq.com/docs/quorum-queues#dead-lettering
 */
export const TELEMETRY_QUEUE_ARGUMENTS = {
  'x-queue-type': 'quorum',
  'x-delivery-limit': 5,
  'x-dead-letter-exchange': DEAD_LETTER_EXCHANGE,
} as const;

export const DEAD_LETTER_QUEUE_ARGUMENTS = {
  'x-queue-type': 'quorum',
} as const;

/** Header set by ingest: integer milliseconds when the message was received (stored as `receivedAt`). */
export const RECEIVED_AT_HEADER = 'x-received-at';

export const MESSAGE_CONTENT_TYPE = 'application/json';

/**
 * `durable` and the arguments are the attributes either service sets; both are checked at
 * redeclaration, so both services pass these objects unchanged to `assertExchange` and
 * `assertQueue`. `internal`, `autoDelete` and `exclusive` are deliberately left at amqplib's
 * default of false, which is what this design wants — that is safe only while both callers import
 * these constants instead of building their own options.
 */
export const TELEMETRY_EXCHANGE_OPTIONS = { durable: true } as const;
export const DEAD_LETTER_EXCHANGE_OPTIONS = { durable: true } as const;
export const TELEMETRY_QUEUE_OPTIONS = {
  durable: true,
  arguments: TELEMETRY_QUEUE_ARGUMENTS,
} as const;
export const DEAD_LETTER_QUEUE_OPTIONS = {
  durable: true,
  arguments: DEAD_LETTER_QUEUE_ARGUMENTS,
} as const;
