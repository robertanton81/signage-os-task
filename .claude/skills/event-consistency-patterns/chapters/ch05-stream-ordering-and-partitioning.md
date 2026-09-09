# Chapter 5: Stream-Processing Patterns — Ordering, Partitioning, Reliability

**Source:** Indrasiri & Suhothayan, _Design Patterns for Cloud Native Applications_, O'Reilly 2021, ch. 6
**Caveat:** Prose is broker-agnostic; the examples assume streaming platforms. Watermarks and stream time have no RabbitMQ equivalent.

## Core Idea

Ordering and parallelism pull in opposite directions. The patterns here are the named ways to buy one without losing all of the other — and each pattern's own "considerations" section says when not to use it.

## Frameworks Introduced

- **Sequential Convoy**: split a stream into substreams by a characteristic of the event (commonly the hash of a key), process substreams in parallel, and optionally merge them back in original order using a sequence number.
  - When to use: you need throughput, and correctness only requires order within a key.
  - How to merge back: take the smallest outstanding sequence number across substreams; hold the rest until the gap fills.
  - Second use the book names: hashing by key raises cache-hit rate, because one key's events always land on the same node.
- **Buffered Event Ordering**: reorder events before processing using an incrementing value, waiting a bounded time for a gap to fill.
  - How: on receiving N+1 after N, emit immediately. On receiving N+2 with N+1 missing, wait a timeout; emit N+1 then N+2 if it arrives, otherwise emit N+2 out of order.
  - Optimisation the book offers: the upstream can send an empty event for a dropped sequence number, or annotate the next event as "all prior processed", so the reorderer decides without waiting.
  - **The book's own limit: use it only when aggregating over time or detecting a sequence of actions. Otherwise it adds latency and becomes a bottleneck.**
- **Watermark / Course Correction**: bound how long you wait for late data, and repair afterwards rather than blocking.
- **Replay and Periodic Snapshot State Persistence**: reliability patterns for rebuilding state after failure.

## Key Concepts

- **Substream** — a partition of the stream that preserves order within itself.
- **Merge sort by sequence number** — the technique for restoring global order after parallel processing.
- **Watermark** — a marker asserting that no event older than a given time will arrive.
- **K-slack / AQ-K-slack** — named algorithms for adaptively growing the reorder timeout when out-of-order events are observed.

## Mental Models

- **Sequence number vs timestamp, stated precisely**: sequence numbers continuously increase and are unique per stream, so a gap is detectable. Timestamps cannot guarantee uniqueness (several events can share a millisecond) and distributed sources are not synchronised, so ordering by timestamp is approximate at best.
- **Order events from one source; approximate across sources.** The book is explicit that high-accuracy reordering is only achievable when the events come from a single source.
- **Adaptive timeout**: when you observe an event 50 seconds out of order, grow the wait window by 50 seconds. The disorder you have seen predicts the disorder to come.

## Anti-patterns

- **Buffering to reorder when you only need the latest state**: pure latency for no benefit — drop the stale event instead.
- **Ordering by timestamp across unsynchronised producers**: produces confident, wrong ordering.
- **Round-robin partitioning when order matters**: the book offers round-robin only for the case where events are independent.

## Reference Tables

| Ordering carrier | Unique | Contiguous | Needs producer state | Cross-source comparable           |
| ---------------- | ------ | ---------- | -------------------- | --------------------------------- |
| Sequence number  | yes    | yes        | yes                  | no                                |
| Timestamp        | no     | no         | no                   | only if clocks synced             |
| Broker offset    | yes    | yes        | no                   | order of receipt, not of creation |

## Key Takeaways

1. Partition by key to get serial-within and parallel-across; that is Sequential Convoy.
2. Reorder buffering is a real pattern with a published "do not use this unless" clause — cite it.
3. Gap detection is the one thing timestamps cannot give you.
4. Reordering across independent sources is approximate no matter how much you spend.

## Connects To

- **Ch 2**: same partitioning idea, plus the hotspot cost the pattern description omits.
- **Ch 10**: Bellemare's treatment of late events and why repartitioning creates disorder.
