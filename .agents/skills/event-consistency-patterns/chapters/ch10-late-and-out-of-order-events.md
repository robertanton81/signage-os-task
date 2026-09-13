# Chapter 10: Deterministic Processing, Late and Out-of-Order Events

**Source:** Bellemare, _Building Event-Driven Microservices_, O'Reilly 2020, ch. 6
**Caveat:** Watermarks and stream time are streaming-platform constructs with no RabbitMQ equivalent. Take the causes and the reasoning; leave the machinery.

## Core Idea

Out-of-order events are not an exception to handle but a structural consequence of parallelism. Understanding _how_ disorder is created tells you where it can be prevented and where it must be tolerated.

## Frameworks Introduced

- **Causes of out-of-order events**
  1. **Sourcing from already-disordered data** — the upstream was out of order, or an external system's timestamps were.
  2. **Multiple producers writing to multiple partitions** — the decisive one. Repartitioning a stream by a new key means several independent instances write to several outputs, each with its own notion of progress and no synchronisation between them. Slight skew between instances turns previously ordered data into disordered data.
  - When to use: audit your topology for step 2 before blaming the network.
- **Event time vs processing time vs ingestion time**: when the event happened, when it was handled, when it entered the system. Choosing which one your logic uses is a correctness decision, not a detail.
- **Watermark**: an assertion that no event older than time T will arrive, letting a time-windowed computation close. **Stream time**: the highest event time observed so far in a stream.
- **Handling late events**: drop, process anyway, or reprocess a window. The right answer depends on whether the function is time-sensitive.

## Key Concepts

- **Late-arriving event** — arrives after the processor has moved past its time.
- **Repartitioning / shuffle** — rekeying a stream, the main manufacturer of disorder.
- **Time skew** — independent instances progressing at different rates.
- **Windowing** — tumbling, sliding and session windows over event time.

## Mental Models

- **Disorder is manufactured by your own parallelism**, not just inherited from the network. Every rekeying step is a disorder source.
- **Unbalanced partitions and backlogs make it worse.** Skew grows with unequal processing rates.
- **Ask whether the function is time-sensitive.** A last-write-wins projection is not; a windowed aggregate is. Only the latter needs watermarks.

## Anti-patterns

- **Synchronising producer clocks and calling the ordering problem solved**: clock sync bounds the error, it does not make timestamps unique or contiguous.
- **Applying windowing machinery to a projection that only needs the newest value**: cost with no benefit.
- **Rekeying a stream without acknowledging you just introduced disorder.**

## Reference Tables

| Function type           | Needs ordering                  | Late-event policy              |
| ----------------------- | ------------------------------- | ------------------------------ |
| Latest-state projection | no, needs freshness comparison  | drop the older event           |
| Counter from deltas     | yes, must not skip or duplicate | must not drop; needs dedup     |
| Windowed aggregate      | yes, within the window          | watermark, then repair or drop |
| Threshold alert         | often no                        | process regardless of order    |

## Key Takeaways

1. Repartitioning is the main source of out-of-order events in a system you control.
2. Event time, processing time and ingestion time are three different clocks; name which one your logic uses.
3. Whether disorder matters is a property of the function, not of the pipeline.
4. Clock synchronisation reduces error; it does not deliver ordering.

## Connects To

- **Ch 5**: Buffered Event Ordering is one policy for late events, with its own cost.
- **Ch 2**: the freshness comparison is the cheapest late-event policy when only the newest state matters.
