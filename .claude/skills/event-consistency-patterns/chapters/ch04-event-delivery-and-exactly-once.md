# Chapter 4: Event-Delivery Patterns and Exactly-Once Processing

**Source:** Indrasiri & Suhothayan, _Design Patterns for Cloud Native Applications_, O'Reilly 2021, ch. 5
**Caveat:** This book's ch. 4 claims MongoDB is unsuitable for transactional data. That is **outdated** — MongoDB supports distributed transactions on replica sets and sharded clusters (verified against live MongoDB docs, 2026-09-09). Treat every product capability claim in this book as needing re-verification.

## Core Idea

Delivery semantics and effect semantics are different things. Brokers give you at-least-once delivery; what the business needs is that the effect happens once. Bridge the two with sequence numbers or with idempotency, and pick the cheapest guarantee that is sufficient.

## Frameworks Introduced

- **At-most-once / at-least-once / exactly-once processing**
  - _At-most-once delivery_ is enough for data the business can afford to lose: notifications, periodic refreshes.
  - _At-least-once delivery plus exactly-once processing_ is what business-critical data needs.
  - **Rule the book states explicitly: implement the lowest required guarantee**, because a higher one costs performance and complexity.
- **Two routes to exactly-once processing**
  1. **Sequence numbers**: attach them to events so the consumer recognises and drops a duplicate before processing.
  2. **Idempotent events**: shape the event so that receiving it twice yields the same outcome as once — e.g. an event that sets a phone number to a value, rather than one that mutates it.
- **Event-delivery patterns**: Producer-Consumer (one consumer per message, work distribution), Publisher-Subscriber (every subscriber gets a copy), Fire-and-Forget, Store-and-Forward, Polling, Request-Callback.
  - When to use Producer-Consumer: horizontal scaling of a stateless processing step — this is the competing-consumers shape.

## Key Concepts

- **Exactly-once processing** — the effect occurs once even under repeated delivery.
- **Idempotent event** — one whose repeated application does not change the outcome.
- **Event broker vs message broker** — a broker that retains a log versus one that removes on acknowledgement.
- **Store and forward** — durability at the producer boundary so a broker outage does not lose the event.

## Mental Models

- **"Set to X" is idempotent; "add X" is not.** The verb in the event decides how much machinery you need downstream.
- **Guarantee ladder**: at-most-once → at-least-once → at-least-once + idempotent effect. Climb only when a requirement forces you, and write down what each rung cost.

## Anti-patterns

- **Reaching for exactly-once delivery**: the book treats it as a cost to be avoided, not a feature to be achieved.
- **Uniform guarantees across all event types**: telemetry that can be dropped and counters that cannot should not pay the same price.

## Reference Tables

| Guarantee                   | Cost                                 | Fits                                      |
| --------------------------- | ------------------------------------ | ----------------------------------------- |
| At-most-once                | lowest                               | droppable notifications, periodic refresh |
| At-least-once               | redelivery, duplicate handling       | almost everything                         |
| At-least-once + idempotency | design constraint on the event shape | counters, alerts, state                   |

## Key Takeaways

1. Do not chase exactly-once delivery; achieve exactly-once _effect_.
2. Sequence numbers and idempotency are alternatives, not a stack — either suffices.
3. Pick the lowest sufficient guarantee and record why.
4. Different event types in one system may deserve different guarantees.

## Connects To

- **Ch 2**: the version comparison is the sequence-number route in practice.
- **Ch 3**: the four failure points explain why at-least-once is the honest default.
