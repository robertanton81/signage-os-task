# Chapter 6: Messaging and Integration Patterns in Node.js (AMQP)

**Source:** Casciaro & Mammino, _Node.js Design Patterns_, 3rd ed., Packt 2020, ch. 13
**Caveat:** Targets Node 12/14 and the `amqplib` client. The chapter contains **no coverage of prefetch/QoS, dead-letter exchanges, or publisher confirms** — get those from RabbitMQ docs for the pinned client version. This is the only source here that is both our language and our broker.

## Core Idea

Reliable delivery in AMQP comes from making the queue outlive the consumer. A durable subscriber is a durable queue bound to an exchange, so messages published while the consumer is down are still there when it returns.

## Frameworks Introduced

- **Message types**: Command Message (do this), Event Message (this happened), Document Message (here is data). Naming the type disciplines the contract — telemetry is an Event Message, not a Command.
- **Durable subscriber with AMQP**: bind a durable, non-exclusive queue to an exchange so the subscription survives disconnection; contrast with exclusive queues that are destroyed on disconnect and are correct for consumers that do not care about missed messages.
  - When to use durable: any consumer whose purpose is broken by a gap (a store, a projection).
  - When to use exclusive: fan-out to live clients that only care about now.
- **Competing consumers over one queue (pipelines)**: point-to-point delivery where each message goes to exactly one of N consumers. This is the horizontal-scaling shape for a stateless processing step.
- **Correlation Identifier**: attach an id to a message so a later message can be matched back to it. Generalises beyond request/reply into any cross-service correlation, including tracing a message through the pipeline.
- **Return Address**: carry the reply destination in the message rather than hardcoding it.

## Key Concepts

- **Exchange** — the routing element; producers publish to it, never directly to a queue.
- **Binding** — the rule connecting an exchange to a queue.
- **Fanout exchange** — copies every message to all bound queues; no routing logic.
- **Durable queue** — survives broker restart and consumer disconnection.
- **Exclusive queue** — destroyed when its connection closes.
- **Acknowledgement (`noAck` false)** — the consumer tells the broker when the message is safely handled.

## Code Examples

```js
// Shape of the amqplib connection used throughout the chapter
const amqp = require('amqplib');
const connection = await amqp.connect('amqp://localhost');
const channel = await connection.createChannel();
await channel.assertExchange('chat', 'fanout');
// durable subscriber: a named, durable queue that survives disconnects
const { queue } = await channel.assertQueue('chat_history');
await channel.bindQueue(queue, 'chat');
await channel.consume(queue, (msg) => {
  /* handle */ channel.ack(msg);
});
```

- **What it demonstrates**: publish to an exchange, bind a durable queue, acknowledge explicitly. The acknowledgement is what makes redelivery possible and therefore what makes idempotency necessary.

## Mental Models

- **Publish to exchanges, consume from queues.** A producer that names a queue has coupled itself to a topology it does not own.
- **Durability is a property of the queue, not of the message alone.** A persistent message in a transient queue is still lost.
- **Competing consumers is the scaling knob**; the number of consumers on a queue is how you add throughput, provided each message is independent.

## Anti-patterns

- **Acknowledging on receipt rather than after the work**: silently downgrades the guarantee.
- **One queue per message type when a routing key would do**: topology sprawl.
- **Treating this chapter as complete**: it omits prefetch, dead-lettering and publisher confirms, all of which a production consumer needs.

## Reference Tables

| Need                                       | AMQP construct                           |
| ------------------------------------------ | ---------------------------------------- |
| Every consumer sees every message          | fanout exchange, one queue per consumer  |
| Each message handled once, by any consumer | one durable queue, N competing consumers |
| Survive consumer downtime                  | durable, non-exclusive queue             |
| Only care about live traffic               | exclusive queue                          |
| Match a later message to an earlier one    | correlation identifier                   |

## Key Takeaways

1. A durable subscriber is a durable queue, not a durable consumer.
2. Competing consumers on one queue is the horizontal-scaling primitive.
3. Explicit acknowledgement after durable work is the contract that makes at-least-once work.
4. This chapter is a starting point; prefetch and dead-lettering must come from the broker docs.

## Connects To

- **Ch 4**: Producer-Consumer pattern is competing consumers under another name.
- **Ch 3**: acknowledgement timing is where at-least-once is won or lost.
