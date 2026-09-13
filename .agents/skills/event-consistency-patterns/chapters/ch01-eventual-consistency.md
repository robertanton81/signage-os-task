# Chapter 1: Managing Eventual Consistency

**Source:** Rocha, _Practical Event-Driven Microservices Architecture_, Apress 2022, ch. 5
**Caveat:** Examples are Kafka-based. The reasoning is broker-agnostic; the mechanisms are not.

## Core Idea

When state is derived from a stream, readers can observe a version of the world that is behind the writer. The job is not to eliminate that gap but to decide who is allowed to notice it and for how long.

## Frameworks Introduced

- **Safety vs liveliness as the two failure axes**: safety means nothing bad happens (no invalid state); liveliness means something good eventually happens (the state does converge). Most "consistency" arguments are really about which of the two you are trading.
  - When to use: whenever someone says "but that's inconsistent" — ask whether they mean an invalid state was written, or that a correct state arrived late.
- **Event versioning as the staleness detector**: a version attached to each event lets a consumer tell whether what it holds is older than what it just received, without consulting the producer.
  - How: carry a per-entity version on the event; compare against the stored version before applying.
- **"It's not eventual if nobody notices"**: the practical bar is not zero lag, it is lag below the observation threshold of the consumer that cares.
  - Failure mode: this argument is abused to justify unbounded lag. It only holds when the lag is measured, bounded and alarmed.

## Key Concepts

- **Eventual consistency** — replicas converge given no new writes; nothing says when.
- **Staleness window** — how far behind a derived view is allowed to fall before it is a defect.
- **Entity version** — a monotonically increasing marker of an entity's state at a point in time.
- **Buffering state** — holding recent events in memory as an alternative to persisting a projection; cheap, but lost on restart.
- **End-to-end argument** — correctness checks belong at the endpoints that care, not in every intermediate hop.

## Mental Models

- Think of a projection as a **cache with a version stamp**, not as a database. The stamp is what makes staleness detectable rather than invisible.
- Use **"retry later"** as the first answer to a stale read, and only escalate to stronger coordination when you can name the read that cannot tolerate the delay.

## Reference Tables

| Strategy for stale reads    | Cost                          | When it fits                   |
| --------------------------- | ----------------------------- | ------------------------------ |
| Retry later                 | extra requests, added latency | transient lag, idempotent read |
| Version check at the reader | needs a version on the event  | reader can decide for itself   |
| Persist the projection      | storage, write amplification  | reader must survive restarts   |
| Buffer in memory            | lost on restart               | short windows, tolerable loss  |

## Key Takeaways

1. Ask which axis is being violated — safety or liveliness — before designing a fix.
2. A version on the event turns invisible staleness into a decision the consumer can make.
3. Bounded and measured lag is a design position; unbounded lag is a defect wearing a design's clothes.
4. Persisting a projection buys restart survival, not correctness.

## Connects To

- **Ch 2**: versioning is developed there into the freshness rule and the concurrency mechanism.
- **Ch 9**: the entity event is the shape that makes a projection materializable at all.
