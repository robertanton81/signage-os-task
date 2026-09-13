# Chapter 11: Testing Event-Driven Systems

**Source:** Bellemare, _Building Event-Driven Microservices_, O'Reilly 2020, ch. 15
**Caveat:** Tooling examples are Kafka-flavoured. The strategy taxonomy transfers directly.

## Core Idea

Integration testing for an event-driven service splits into local (a replica of production on your machine) and remote (the service runs against an external environment). Decide which questions you need answered before choosing, because the two answer different ones.

## Frameworks Introduced

- **Local vs remote integration testing**
  - _Local_: spin up a temporary environment, either inside the test process or as an external process the test controls. Fast, hermetic, reproducible; can diverge from production.
  - _Remote_: run against a real external environment. Realistic; slower, shared, harder to isolate.
  - _Hybrid_: some dependencies local, some remote.
- **Four local strategies**, in increasing distance from your code: temporary environment inside the test runtime; temporary environment external to the test code; hosted services replaced with mocks or simulators; remote services with no local option.
- **The questions that pick the strategy**, stated by the author: What are you hoping to get out of integration testing — "does it run", a smoke test with production data, or validation of complex workflows? And: must the service support restarting from the beginning of the input stream, as after data loss or a bug-driven reprocess?
- **Testing schema evolution and compatibility**: the contract changes over time; a test that only exercises today's schema will not catch tomorrow's break.

## Key Concepts

- **Local integration testing** — a localised replica of the production environment.
- **Remote integration testing** — execution against an environment outside the local system.
- **Topology test** — exercising the wiring between processing steps, not just one function.
- **Schema compatibility test** — verifying old and new producers and consumers interoperate.
- **Reprocessing from the start** — replaying the whole input to rebuild state.

## Mental Models

- **Split the tests by the question they answer.** "Does the function compute correctly" is a unit test. "Does the wiring deliver and acknowledge correctly" needs a real broker. Mocking the broker answers neither honestly.
- **Reprocessing is a testable requirement, not an emergency procedure.** If you may ever need to rebuild state from the stream, test that path deliberately.

## Anti-patterns

- **Mocking the broker and the store in an integration test**: the test then verifies your mock, not the system. The failures that matter — redelivery, acknowledgement timing, unique-constraint violations, ordering — live in the real components.
- **Testing only the happy path of a stateful function**: the interesting cases are duplicate, out-of-order and restart.
- **Shared remote environments as the only integration layer**: other people's data makes failures unreproducible.

## Reference Tables

| Strategy                               | Speed   | Realism | Isolation |
| -------------------------------------- | ------- | ------- | --------- |
| Temporary env in test runtime          | fastest | lowest  | total     |
| Temporary env external to test         | fast    | good    | total     |
| Mocks / simulators for hosted services | fast    | partial | total     |
| Shared remote environment              | slow    | high    | poor      |
| Production environment                 | slow    | highest | none      |

## Key Takeaways

1. Choose the integration strategy from the question you need answered, not from habit.
2. A temporary external environment the test controls is usually the best cost/realism point.
3. Mocking the broker defeats the purpose of the integration test.
4. Test duplicate, out-of-order and restart explicitly; they are the behaviours the design exists for.
5. If reprocessing from the beginning is a requirement, it needs its own test.

## Connects To

- **Ch 3**: the failure modes worth testing are the four broker failure points.
- **Ch 2**: the duplicate and out-of-order cases are the ones the freshness rule must survive.
