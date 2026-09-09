# Cheatsheet — decision rules

## The first question: what shape is the event?

| Event carries     | Idempotent | Duplicate | Gap in sequence | Consequence                  |
| ----------------- | ---------- | --------- | --------------- | ---------------------------- |
| Absolute state    | yes        | harmless  | harmless        | last-write-wins is enough    |
| Delta / increment | **no**     | corrupts  | corrupts        | needs real dedup and no loss |

**Rule:** decide this in the contract. Every downstream cost follows from it. (Ch 2, Ch 9)

## Choosing the ordering carrier

- Need to detect a **missing** event → sequence number. Only it is contiguous.
- Need no producer state → timestamp, and accept that ordering is approximate.
- Ordering across **different** producers → approximate at best; do not promise more.
- Broker offset orders **receipt**, not creation. Never use it for logical order.

## Concurrency: which mechanism

```
Is the operation expressible as ONE conditional write?
├─ yes → optimistic: conditional write. Stop here.
└─ no  → is it a delta/counter?
         ├─ yes → route by entity key (serial within entity), or make it absolute
         └─ no  → transaction; distributed lock only if nothing else fits
```

**Rule:** a distributed lock is the last option, not the first — on expiry it produces the race it was preventing. (Ch 2)

## Conditional-write trap

- Filter on the field you are **changing**, not only on the identity.
- Filtering on identity alone lets both concurrent writes match; the second silently overwrites the first and nobody is told.
- Counters: an atomic increment is safe against concurrency, **not** against duplication.
- Uniqueness: enforce with a unique constraint, not with a check-then-insert.

## Delivery guarantee ladder — climb only when forced

| Rung                  | Cost                      | Use when                           |
| --------------------- | ------------------------- | ---------------------------------- |
| At-most-once          | lowest                    | the data is droppable              |
| At-least-once         | duplicates to handle      | default                            |
| + idempotent effect   | constrains the contract   | counters, alerts, state            |
| Exactly-once delivery | broker/store coordination | almost never; say why you declined |

## Tells and smells

- "This will probably never happen" → at 100 msg/s a one-in-a-million race fires ~9 times a day.
- Ordering the whole pipeline to protect one entity → you have thrown away the throughput.
- A projection that needs history to answer "what is true now" → the event shape is wrong.
- Two services writing one stream → lineage and order are undefined.
- Rekeying a stream → you just manufactured out-of-order events.
- A dead-letter queue with no consumer → silent data loss.
- Acknowledging before the work is durable → your at-least-once is really at-most-once.
- Mocking the broker in an "integration" test → the test verifies the mock.

## Partition-key sanity check

- High cardinality, evenly spread → good key.
- Category-like, few distinct values → hotspot.
- One producer far busier than the rest → hotspot even with a good key; the fix is not more consumers.

## What must a consistency test prove

1. Same message twice → one effect.
2. Version 3 then version 2 → state stays at 3.
3. N consumers, interleaved messages for one entity → correct final state.
4. Kill mid-processing → no loss, no double effect.
5. Malformed input → rejected and logged, connection and process survive.
