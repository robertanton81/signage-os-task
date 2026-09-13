# Chapter 2: Concurrency and Out-of-Order Messages

**Source:** Rocha, _Practical Event-Driven Microservices Architecture_, Apress 2022, ch. 6
**Caveat:** 138 Kafka mentions vs 19 for RabbitMQ. Partitioning maps to a consistent-hash exchange or hashed routing keys in RabbitMQ — verify the mechanism in RabbitMQ docs, never assume Kafka semantics.
**This is the highest-value chapter in this skill.**

## Core Idea

In a monolith a race condition is rare enough to ignore. At a hundred messages per second a one-in-a-million race happens nine times a day. Concurrency in an event pipeline is not an edge case, it is the normal operating condition.

## Frameworks Introduced

- **Optimistic vs pessimistic concurrency**
  - _Pessimistic_: prevent the conflict (lock, or route so it cannot occur).
  - _Optimistic_: allow the conflict and reject the loser at write time using a condition.
  - When to use optimistic: conflicts are rare, and the losing write can be safely discarded or retried.
  - When to use pessimistic: the operation is not expressible as a single conditional write.
- **Solving concurrency by implementation vs by design**: an implementation fix (locks, conditions) treats the symptom; a design fix (routing so two writers never touch the same entity) removes the possibility. Prefer design where it does not cost you scaling headroom.
- **Event versioning as the freshness rule**: the version is the version of the _entity_ at the moment of the change. Compare incoming version against stored version; apply only if newer.
  - How: on receiving version N, read stored version M. If N > M apply, else drop (or handle late, see below).
  - Why it works: it collapses ordering and deduplication into one comparison — a duplicate is just "not newer".
- **End-to-end partitioning**: derive a partition key from the entity id so every event for one entity is handled by one consumer. Serial within an entity, parallel across entities.

## Key Concepts

- **Race condition** — two writers change the same state concurrently and the result depends on timing.
- **Entity version** — sequential per entity; each change increments it.
- **Partition key / routing key** — the field that decides which queue or consumer an event lands on.
- **Hotspotting** — an uneven key distribution that sends a large share of traffic to one partition.
- **Distributed lock** — pessimistic coordination across processes; adds a component and a failure mode.

## Mental Models

- **A duplicate is a special case of "not newer".** If your freshness rule is a strict inequality, deduplication of full-state events comes free.
- **Sequential version vs timestamp**: a sequential version is unique and contiguous, so you can detect a gap. A timestamp always increases and needs no producer state, but is not unique and not contiguous. Choose contiguity only if you must not skip an event.
- **Contiguity is only needed for deltas.** If the event carries absolute state, gaps are harmless.

## Anti-patterns

- **Distributed locks as the default answer**: adds infrastructure and latency, and when a lock expires early you get exactly the race you were avoiding.
- **Ordering the whole pipeline**: serialising everything to guarantee order inside one entity throws away the throughput the system exists for.
- **Partitioning on a low-cardinality field**: category-like keys produce hotspots; entity-like keys usually do not.
- **Assuming timestamps from distributed sources are comparable**: producers' clocks are not synchronised to the millisecond.

## Worked Example

An inventory service receives an event with version 21 while the stored product stock is at version 22.

- The event is **older** than the state. Options:
  1. **Drop it** — correct when the event carries absolute state and only the latest matters.
  2. **Process it anyway** — correct when the business effect is order-insensitive, e.g. "notify when one unit remains" should fire regardless of arrival order.
  3. **Buffer and reorder** — only when a downstream function needs the true sequence.

The chapter's sharpest point sits underneath this: **stock-in and stock-out events are deltas and are not idempotent, whereas a stock-change event carrying the resulting quantity is.** Choosing the delta shape forces you into contiguity (never skip, never duplicate). Choosing the absolute shape lets last-write-wins do the work. The event's shape decides how hard consistency will be — before you write a line of consumer code.

## Reference Tables

|                            | Prevent by routing (pessimistic) | Guard at write (optimistic)               |
| -------------------------- | -------------------------------- | ----------------------------------------- |
| Ordering inside one entity | guaranteed by construction       | not guaranteed; enforced by the condition |
| Delta operations           | safe                             | unsafe                                    |
| Consumer count             | capped by partition count        | unbounded                                 |
| Failure mode               | hotspot, rebalance disorder      | rejected writes under contention          |
| Extra infrastructure       | routing scheme / plugin          | none                                      |

## Key Takeaways

1. At throughput, "this will probably never happen" becomes "this happens daily".
2. Event versioning gives you ordering and deduplication in one comparison.
3. Deltas are not idempotent; absolute-state events are. Decide this in the contract, not the consumer.
4. Partitioning by entity id gives serial-within, parallel-across — and buys hotspotting as its price.
5. Reach for a distributed lock last, not first.

## Connects To

- **Ch 5**: Sequential Convoy is the same partitioning idea under a pattern name.
- **Ch 4**: at-least-once delivery is what makes the "not newer" case common rather than rare.
- **Ch 9**: entity events are the shape that makes the optimistic path viable.
