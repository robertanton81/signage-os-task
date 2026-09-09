# Chapter 9: The Contents and Structure of an Event

**Source:** Bellemare, _Building Event-Driven Microservices_, O'Reilly 2020, ch. 2
**Caveat:** Zero RabbitMQ mentions in the entire book, 88 for Kafka. The event-contract reasoning transfers; the broker machinery (partitions, changelogs, compacted topics) does not.

## Core Idea

Events come in three structural shapes, and the shape you choose decides whether downstream state can be rebuilt from the stream at all. This is the contract decision that everything else inherits.

## Frameworks Introduced

- **The three event structures**
  - **Unkeyed event** — a singular statement of fact with no key. Example: a user opened a product page. Use when nothing downstream needs to aggregate or route by identity.
  - **Entity event** — keyed on the unique id of a thing, and the value carries the properties and state of that thing at a point in time. **Only the latest entity event is needed to determine the current state.** Use when downstream must maintain current state.
  - **Keyed event** — carries a key but does not describe an entity. Its job is routing and data locality: everything with the same key lands in the same partition. Use when you need co-location without full state.
- **Materializing state from entity events**: apply entity events in order, upserting each into a key/value table, and the table holds current state. Publishing every table update back out produces the stream again — the **table-stream duality**.
  - Why it works: the entity event is self-contained, so the table needs no history, only the newest row per key.
- **Single writer principle**: each event stream has exactly one producing service, which owns every event on it. Makes the authoritative source knowable and data lineage traceable.

## Key Concepts

- **Entity event** — keyed, self-contained, latest-wins.
- **Table-stream duality** — a stream folded into a table, and a table's changes unfolded into a stream.
- **Upsert** — insert if absent, update if present.
- **Data locality** — arranging that related events are handled together.
- **Single writer** — one producer owns one stream.

## Mental Models

- **"Only the latest entity event is needed"** is the property that makes last-write-wins projections legitimate rather than lossy. If your event does not have it, you have chosen a delta and inherited its costs.
- **Choose the event shape before the storage schema.** The projection is downstream of the contract, not the other way round.
- **Keyed and entity events answer different questions**: keyed is about _where it is processed_, entity is about _what is true_. An event can be both.

## Worked Example

A book publisher's stream, keyed on ISBN:

| Shape   | Key           | Value                                  | What downstream can do                                   |
| ------- | ------------- | -------------------------------------- | -------------------------------------------------------- |
| Unkeyed | —             | `ISBN 372719, timestamp`               | count interactions; cannot build state                   |
| Entity  | `ISBN 372719` | full book record: author, title, price | upsert into a table; table _is_ current state            |
| Keyed   | `ISBN 372719` | `UserId A537FE`                        | co-locate all events for one book; aggregate into a list |

Materialising the entity stream: read events in order, upsert each by key. After processing, the table's row for each key reflects the newest event seen for that key. No history is retained and none is needed. That is the whole mechanism behind a current-state projection.

## Anti-patterns

- **Multiple services writing to one stream**: destroys the ability to name the authoritative source and makes ordering meaningless.
- **Partial entity events**: an "entity" event that omits fields is a delta in disguise; downstream cannot rebuild state from the latest event alone.
- **Choosing unkeyed for something that has an identity**: forecloses projection and routing later.

## Key Takeaways

1. Entity events are the shape that makes current-state projections sound.
2. If only the latest event is needed, ordering and deduplication both get much cheaper.
3. One stream, one writer — otherwise lineage and ordering are undefined.
4. The key is doing two jobs at once: identity and routing. Choose it knowing both.

## Connects To

- **Ch 2**: entity events plus a version give you the optimistic path.
- **Ch 5**: the key that identifies the entity is usually the right partition key.
