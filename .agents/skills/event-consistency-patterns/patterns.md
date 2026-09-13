# Patterns

## Event Versioning as the Freshness Rule

**When to use**: a consumer maintains current state and must not let an older message overwrite a newer one.
**How**: carry a per-entity version on every event. On receipt, compare against stored version; apply only if strictly newer.
**Trade-offs**: collapses ordering and deduplication into one comparison and needs no extra infrastructure. Works only for events carrying absolute state; a delta event cannot be safely dropped for being "not newer". (Ch 1, Ch 2)

## Optimistic Concurrency via Conditional Write

**When to use**: conflicts are possible but not the common case, and the losing write can be discarded or retried.
**How**: express the update as a single conditional operation whose filter includes the field being changed, so a concurrent writer's update no longer matches.
**Trade-offs**: no locks, no extra components, unbounded consumer count. Under high contention the rejected-write rate grows. Does not protect delta operations. (Ch 2)

## End-to-End Partitioning (Sequential Convoy)

**When to use**: you need order within an entity and parallelism across entities.
**How**: derive a partition key from the entity id; route every event for one entity to the same queue and consumer. Optionally merge substreams back by sequence number.
**Trade-offs**: order guaranteed by construction, and it raises cache-hit rates. Costs hotspotting on skewed keys, disorder during rebalance, and caps consumers at the partition count. (Ch 2, Ch 5)

## Buffered Event Ordering

**When to use**: a downstream function genuinely needs the true sequence — a time aggregate, or detection of an action sequence.
**How**: hold an event whose predecessor is missing, wait a bounded timeout, then emit in order or emit out of order on expiry. Grow the timeout by the observed disorder. Upstream can send an empty placeholder or annotate "all prior processed" to avoid the wait.
**Trade-offs**: the source itself says it adds latency and can become a bottleneck; do not use it when only the newest state matters. (Ch 5)

## At-Least-Once Delivery plus Idempotent Effect

**When to use**: the default for anything business-critical.
**How**: consume, perform the effect durably, then acknowledge. Make the effect idempotent, or recognise duplicates by identity before performing it.
**Trade-offs**: cheap and robust. Requires that every effect be shaped as idempotent, which constrains the event contract. (Ch 3, Ch 4, Ch 7)

## Entity Event Contract

**When to use**: downstream must maintain current state.
**How**: key the event on the entity id; carry the full state in the value, so only the latest event is needed.
**Trade-offs**: makes last-write-wins projections sound and deduplication nearly free. Larger messages, and per-change detail is not recoverable from the stream. (Ch 9)

## Composite Message Identity

**When to use**: you need a deduplication key without an id-generation service.
**How**: derive the message id from producer identity plus a locally increasing counter. Enforce it with a unique constraint at the store.
**Trade-offs**: unique and ordered per producer with no coordination. Producer must keep the counter across restarts, or add a run/session component. (Ch 8)

## Outbox Pattern

**When to use**: one service both persists state and publishes events.
**How**: write the outgoing message into the same transaction as the state change; a separate process publishes it.
**Trade-offs**: closes the dual-write hole. Adds a table, a publisher process and publication latency. Unnecessary for a service that only publishes. (Ch 3)

## Poison Event Exit

**When to use**: an event fails every attempt and would otherwise block the queue.
**How**: after N attempts route it to a dead-letter queue, or on a retaining broker fix the code and reprocess from the stored offset.
**Trade-offs**: keeps the hot path moving. A dead-letter queue nobody consumes is silent data loss. (Ch 3)

## Durable Subscriber (AMQP)

**When to use**: a consumer whose purpose breaks if it misses messages while down.
**How**: bind a named, durable, non-exclusive queue to the exchange; acknowledge only after durable work.
**Trade-offs**: messages accumulate while the consumer is down, which is the point and also the risk. Exclusive queues are the correct opposite choice for live-only consumers. (Ch 6)
