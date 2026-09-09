---
name: event-consistency-patterns
description: 'Knowledge base on consistency in queue-based event pipelines, distilled from five books (Rocha, Indrasiri & Suhothayan, Casciaro & Mammino, Hunter, Bellemare). Use when reasoning about telemetry or event message metadata, ordering guarantees, deduplication, idempotency, delivery semantics, race conditions, partitioning, dead-lettering or the testing of any of these. Supplies the option space and its trade-offs; it does not decide for a project.'
---

<!-- argument-hint: [topic, pattern name, or chapter number] -->

# Event Pipeline Consistency — Patterns and Trade-offs

**Sources**: 5 books, 11 selected chapters | **Generated**: 2026-09-09

## How to Use This Skill

- **Without arguments** — the core frameworks below.
- **With a topic** — ask about `ordering`, `deduplication`, `partitioning`, `delivery semantics`, `AMQP`, `testing`; the relevant chapter file is read before answering.
- **With a chapter** — ask for `ch02`.
- **Start here for a decision** — [cheatsheet.md](cheatsheet.md) is decision rules, not definitions.

## Scope & Limits — read before using this in a design

1. **This skill carries options and their costs, never a project's decision.** Where a repository has a design spec covering message metadata, freshness, deduplication or atomicity, **that spec wins**. Use this skill to enumerate alternatives and name what each one costs, then let the spec decide.
2. **Books date; products change faster.** Every claim here about what a product can do must be re-verified against current documentation before it lands in code or in a spec.
3. **Most sources are written against Kafka.** Partitions, offsets, changelogs and compacted topics have no direct AMQP equivalent. Concepts transfer; mechanisms do not. Each chapter file names its own caveat at the top.
4. **Known stale claim**: _Design Patterns for Cloud Native Applications_ states MongoDB is unsuitable for transactional data. That is outdated — MongoDB supports distributed transactions on replica sets and sharded clusters.

---

## Core Frameworks & Mental Models

### 1. The event's shape decides everything downstream

An event carrying **absolute state** is idempotent: a duplicate is harmless, a stale copy can be dropped, last-write-wins is sound. An event carrying a **delta** is not: it must be neither duplicated nor skipped, which forces real deduplication and contiguous sequencing. Choose the shape in the contract, before writing a consumer. Counters are where this bites — "add 3" and "the total is now 47" have very different downstream costs. (Ch 2, Ch 9)

### 2. Entity events make current-state projections sound

An **entity event** is keyed on a thing's id and carries that thing's full state, so _only the latest event is needed to determine current state_. Apply events by upserting on the key and the table is the projection — the **table-stream duality**. An event that omits fields is a delta wearing an entity's clothes. Each stream should have exactly one producing service (**single writer principle**). (Ch 9)

### 3. Versioning collapses ordering and deduplication into one comparison

Attach a per-entity **version** to each event; apply only when strictly newer than stored. A duplicate is then just a special case of "not newer", so one comparison buys both guarantees. Sequence numbers are unique and contiguous, so gaps are detectable; timestamps need no producer state but are neither unique nor comparable across unsynchronised sources. Contiguity is only required when events are deltas. (Ch 1, Ch 2, Ch 5)

### 4. Prefer optimistic concurrency; route only when you must

Two families solve "serial within one entity, parallel across entities":

- **Optimistic** — allow the conflict, reject the loser with a single conditional write. No extra infrastructure, unbounded consumer count; does not protect deltas.
- **Pessimistic by routing** — partition on the entity key so one entity meets one consumer. Order by construction; costs hotspotting, rebalance disorder, and caps consumers at the partition count.

Distributed locks come last: on expiry they produce the race they were preventing. Serialising the whole pipeline to protect one entity is the wrong answer to the throughput question. (Ch 2, Ch 5)

### 5. The conditional-write trap

Filter on the field you are **changing**, not only on the identity. A filter on identity alone lets both concurrent writers match, and the second silently overwrites the first with no signal to anyone. Atomic increment is safe against concurrency but not against duplication. Uniqueness belongs to a constraint, never to check-then-insert. (Ch 2, Ch 8)

### 6. Duplicates come from lost acknowledgements

Producer and consumer each transmit and then acknowledge, giving four independent failure points. Two of them — acknowledgement lost after the work was done — leave the sender unable to distinguish success from failure. That ambiguity, not network unreliability, is why retries duplicate and why idempotency is mandatory. Acknowledge only after the effect is durable. (Ch 3, Ch 7)

### 7. Climb the guarantee ladder only when forced

At-most-once → at-least-once → at-least-once with an idempotent effect. Chase exactly-once **processing**, never exactly-once **delivery**; the latter costs broker-to-store coordination that this class of system rarely justifies. Different event types in one system may deserve different rungs. Write down which rung you chose and why. (Ch 3, Ch 4)

### 8. Disorder is manufactured by your own parallelism

Rekeying or repartitioning a stream means independent instances write to independent outputs with no shared notion of progress; slight skew turns ordered data into disordered data. Whether that matters is a property of the **function**, not of the pipeline: a latest-state projection needs only a freshness comparison, a windowed aggregate needs watermarks, a delta counter needs everything. (Ch 10)

### 9. Reorder buffering has a published expiry date

Buffered Event Ordering waits a bounded time for a missing sequence number. Its own source restricts it to time aggregation and action-sequence detection, warning it adds latency and becomes a bottleneck. When only the newest state matters, dropping the stale event is strictly cheaper. (Ch 5)

---

## Chapter Index

| #                                                             | Title                                     | Key frameworks                                                              | Source       |
| ------------------------------------------------------------- | ----------------------------------------- | --------------------------------------------------------------------------- | ------------ |
| [ch01](chapters/ch01-eventual-consistency.md)                 | Managing Eventual Consistency             | safety vs liveliness, staleness window                                      | Rocha 5      |
| [ch02](chapters/ch02-concurrency-out-of-order.md)             | **Concurrency and Out-of-Order Messages** | optimistic vs pessimistic, event versioning, delta vs absolute, hotspotting | Rocha 6      |
| [ch03](chapters/ch03-resilience-reliability.md)               | Resilience and Processing Reliability     | four failure points, outbox, poison events, ACID 2.0                        | Rocha 7      |
| [ch04](chapters/ch04-event-delivery-and-exactly-once.md)      | Event Delivery and Exactly-Once           | guarantee ladder, sequence numbers vs idempotency                           | DPCNA 5      |
| [ch05](chapters/ch05-stream-ordering-and-partitioning.md)     | Stream Ordering and Partitioning          | Sequential Convoy, Buffered Event Ordering, watermarks                      | DPCNA 6      |
| [ch06](chapters/ch06-amqp-messaging-in-node.md)               | AMQP Messaging in Node.js                 | durable subscribers, competing consumers, correlation id                    | NDP 13       |
| [ch07](chapters/ch07-node-resilience-idempotency.md)          | Node Resilience and Idempotency           | high vs low-level errors, stateless services                                | Hunter 8     |
| [ch08](chapters/ch08-distributed-primitives-id-generation.md) | Distributed Primitives, ID Generation     | composite identifier, read-modify-write hazard                              | Hunter 9     |
| [ch09](chapters/ch09-event-contract-fundamentals.md)          | The Contents and Structure of an Event    | entity/keyed/unkeyed, table-stream duality, single writer                   | Bellemare 2  |
| [ch10](chapters/ch10-late-and-out-of-order-events.md)         | Late and Out-of-Order Events              | causes of disorder, event vs processing time                                | Bellemare 6  |
| [ch11](chapters/ch11-testing-event-driven-systems.md)         | Testing Event-Driven Systems              | local vs remote integration, what to prove                                  | Bellemare 15 |

## Topic Index

- **acknowledgement timing** → ch03, ch06, ch07
- **atomicity / conditional write** → ch02, ch08
- **counters** → ch02, ch04, ch09
- **dead-letter / poison events** → ch03
- **deduplication** → ch02, ch04, ch08
- **delivery semantics** → ch03, ch04
- **durable subscriber / AMQP** → ch06
- **eventual consistency** → ch01
- **hotspotting** → ch02, ch05
- **idempotency** → ch03, ch04, ch07
- **message contract / event shape** → ch09, ch02
- **message identity** → ch08, ch09
- **optimistic vs pessimistic concurrency** → ch02
- **ordering** → ch02, ch05, ch10
- **outbox** → ch03
- **partitioning / routing key** → ch02, ch05, ch09
- **race conditions** → ch02, ch07, ch08
- **scaling consumers** → ch04, ch06
- **stateless services** → ch07
- **testing consistency** → ch11
- **timestamps vs sequence numbers** → ch02, ch05, ch10
- **versioning / freshness** → ch01, ch02

## Supporting Files

- [cheatsheet.md](cheatsheet.md) — decision rules, traps and tells. Start here.
- [patterns.md](patterns.md) — each pattern with when to use, how, and what it costs.
- [glossary.md](glossary.md) — terms with the chapter that defines them.
