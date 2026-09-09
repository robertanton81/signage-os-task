# Chapter 8: Distributed Primitives and the ID Generation Problem

**Source:** Hunter II, _Distributed Systems with Node.js_, O'Reilly 2021, ch. 9
**Caveat:** The atomicity and transaction material is demonstrated with Redis commands and Lua scripting. Map the _concept_ to your own store; the commands do not transfer. **This is the thinnest chapter in this skill** — its value is one problem statement, not a toolkit.

## Core Idea

Generating identifiers that are unique across independent processes, without a central coordinator, is a genuine distributed-systems problem. Whichever answer you pick constrains your deduplication strategy, because the identifier is what makes a duplicate recognisable.

## Frameworks Introduced

- **The ID generation problem**: several strategies, each trading coordination against properties.
  - _Central allocator_: a single source hands out ids. Unique and compact; a coordination point and a failure point.
  - _Random / UUID_: no coordination, effectively unique, not ordered, larger.
  - _Composite_: combine a producer identity with a locally increasing counter. No coordination, unique per producer, and **ordered within a producer** — which is the property an event pipeline usually wants.
  - When to use composite: when the identity must double as an ordering carrier, which is exactly the event-pipeline case.
- **Seeking atomicity**: an operation composed of a read and a later write is not atomic, and something else can interleave between them. The fix is either a primitive that does the whole operation in one step, or a transaction.

## Key Concepts

- **Coordination point** — a shared resource every producer must consult; correctness is easy, scaling and availability are not.
- **Composite identifier** — producer id plus local counter.
- **Read-modify-write hazard** — the classic race: read a value, compute, write back, and lose a concurrent update.
- **Atomic primitive** — an operation the store performs indivisibly.

## Mental Models

- **A good message identity is derived, not generated.** If the producer already carries an identity and a counter, the message id is a function of those two, and no id-generation service is needed.
- **Every read-then-write in application code is a race waiting for load.** Push the condition into the store.

## Anti-patterns

- **A central id service on the hot path**: adds a synchronous dependency to every message.
- **Read-modify-write across a network**: correct in a test, wrong under concurrency.

## Key Takeaways

1. The identifier scheme and the deduplication scheme are the same decision.
2. Producer id plus local counter gives uniqueness and ordering with no coordination.
3. Any read-modify-write across a network boundary is a race condition under load.

## Connects To

- **Ch 2**: the composite identifier is the version comparison's input.
- **Ch 9**: the entity event's key is the producer-side half of that composite.
