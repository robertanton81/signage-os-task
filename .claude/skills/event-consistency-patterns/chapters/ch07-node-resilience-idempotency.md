# Chapter 7: Resilience and Idempotency in Node.js Services

**Source:** Hunter II, _Distributed Systems with Node.js_, O'Reilly 2021, ch. 8
**Caveat:** Other chapters of this book cover Travis CI, Heroku, Zipkin and Minikube and are obsolete. This chapter is not.

## Core Idea

On a low-level network failure the sender cannot distinguish "the receiver never got it" from "the receiver processed it and the reply was lost". That single ambiguity is why retries exist, why duplicates exist, and why idempotency is not optional.

## Frameworks Introduced

- **High-level vs low-level errors**
  - _High-level_ (an HTTP status, an application error): the round trip completed, the failure is described, the client can decide.
  - _Low-level_ (connection reset, timeout, DNS failure): the round trip did not complete, and the outcome is unknown.
  - When to use: classify every failure before choosing a retry policy. Retrying a high-level error is usually pointless; retrying a low-level error is usually required and always risks duplication.
- **Three outcomes of a failed call**: (1) request failed before arriving, (2) request arrived and was processed but the response was lost, (3) request never arrived. The caller can distinguish (1) but not (2) from (3).
- **Building stateless services**: no per-client state in the process, so any instance can serve any request and instances can be added or killed freely.
- **Resilience testing**: deliberately fail dependencies and assert the service degrades as designed rather than silently.

## Key Concepts

- **Idempotency** — repeated execution produces the same result as a single execution.
- **Stateless service** — holds no state another instance would need to know.
- **Connection resilience** — automatic reconnection with backoff for database and broker clients.
- **Graceful shutdown** — finish in-flight work and close connections before exiting.

## Mental Models

- **Ambiguity, not unreliability, is the hard part.** Networks that fail loudly are easy; networks that fail silently after doing the work are the reason for idempotency keys.
- **A socket connection is stateful; the service holding it need not be.** Distinguish "this process owns a live connection" from "this process owns data another process would need".

## Anti-patterns

- **Retrying a non-idempotent operation on a low-level error**: this is the textbook way to double-charge, double-count and double-alert.
- **Holding per-client aggregates in process memory**: kills horizontal scaling and loses data on restart.
- **Exiting on SIGTERM without draining**: turns every deploy into a burst of redeliveries.

## Reference Tables

| Error class                | Round trip completed | Safe to retry blindly |
| -------------------------- | -------------------- | --------------------- |
| Application/protocol error | yes                  | usually pointless     |
| Timeout                    | unknown              | only if idempotent    |
| Connection reset / refused | unknown or no        | only if idempotent    |

## Key Takeaways

1. The sender's uncertainty, not the network's failure rate, is what forces idempotency.
2. Classify errors as high-level or low-level before writing a retry policy.
3. Statelessness is about what other instances would need, not about holding no memory at all.
4. Graceful shutdown is part of the delivery guarantee, not an operational nicety.

## Connects To

- **Ch 3**: the same four failure points from the broker's perspective.
- **Ch 8**: generating an identifier that makes retries safe.
