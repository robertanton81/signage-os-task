# Chapter 3: Resilience and Event Processing Reliability

**Source:** Rocha, _Practical Event-Driven Microservices Architecture_, Apress 2022, ch. 7
**Caveat:** Section on exactly-once delivery is specific to Kafka transactions. No RabbitMQ equivalent — do not port the claim.

## Core Idea

Every interaction with a broker is two steps — transmit and acknowledge — on both the producer and the consumer side. Each of the four steps can fail independently, and the delivery semantics you get are decided by which failures you choose to tolerate.

## Frameworks Introduced

- **The four failure points**: (1) producer cannot reach the broker; (2) broker received the message but the producer never got the acknowledgement; (3) broker cannot deliver to the consumer; (4) consumer processed but failed to acknowledge.
  - When to use: walk these four in order whenever someone asks "what happens if X dies".
  - Why it matters: failures 2 and 4 are the ones that produce duplicates, because the sender cannot tell success from lost-acknowledgement.
- **Outbox pattern**: write the outgoing message into the same transaction as the state change, and let a separate process publish it. Removes the "wrote to the database but failed to publish" hole.
  - When to use: a service that both persists state and publishes events.
  - When not to: a service that only publishes (no local write) has no such hole and does not need it.
- **Event stream as the only source of truth**: avoid the dual-write problem by not writing twice — derive state from the stream instead of writing state and stream separately.
- **Poison event handling**: an event that reliably fails processing must leave the hot path or it blocks the queue.
  - Options: dead-letter queue, or (on a durable log broker) rewind the offset and reprocess after a fix. The book notes the second is often simpler when the broker retains events.

## Key Concepts

- **At-least-once delivery** — the broker may deliver more than once, never fewer.
- **At-most-once delivery** — never duplicated, may be lost.
- **Dual-write problem** — writing to a database and a broker without a shared transaction; either can succeed alone.
- **Poison event** — an event that fails every processing attempt, often because of unexpected data or a bug.
- **Dead-letter queue** — a side queue for events that exhausted their retries.
- **ACID 2.0** — associative, commutative, idempotent, distributed: properties that make ordering and duplication stop mattering.

## Mental Models

- **Retries convert an availability problem into a duplication problem.** That trade is usually correct, but only if the consumer is idempotent.
- **A dead-letter queue is a decision to stop, not a fix.** Something must consume it or it is a silent data loss with extra steps.
- **ACID 2.0 as a design target**: if an operation is commutative and idempotent, order and duplicates stop being your problem. Reshape the operation before building machinery to protect a fragile one.

## Anti-patterns

- **Infinite retry on a poison event**: blocks the queue and turns one bad message into an outage.
- **Acknowledging before the work is durable**: converts at-least-once into at-most-once without saying so.
- **Building exactly-once delivery**: the coordination cost between broker and store is high; exactly-once _effect_ via idempotency is the affordable version.

## Reference Tables

| Failure                            | What the sender knows | Result                                      |
| ---------------------------------- | --------------------- | ------------------------------------------- |
| Cannot reach broker                | publish failed        | retry is safe, nothing was stored           |
| Ack lost after broker stored       | ambiguous             | retry duplicates the message                |
| Broker cannot deliver              | nothing consumed      | redelivery later                            |
| Consumer ack lost after processing | ambiguous             | redelivery, second effect unless idempotent |

## Key Takeaways

1. Duplicates come from lost acknowledgements, not from broker malice.
2. Acknowledge only after the effect is durable.
3. A poison event needs an exit from the hot path, whether a dead-letter queue or a rewind-and-fix.
4. Reshape operations to be idempotent and commutative before building coordination machinery.

## Connects To

- **Ch 7**: the same ambiguity stated in Node terms with concrete error codes.
- **Ch 4**: the delivery-semantics vocabulary and the "pick the lowest sufficient guarantee" rule.
