# Device Telemetry Processing — Project Guidance for Claude

Take-home assignment (`main-spec/Domácí úkol BE.pdf`): a scalable pipeline that ingests telemetry from many devices over long-lived socket connections, validates it, queues it through RabbitMQ, and maintains a consistent current state per device in MongoDB. Submission is followed by a technical discussion of the architecture, message metadata, race-condition handling, scaling, failure modes and test strategy — every decision must be explainable.

## Where to start in a new session

1. **`TODO.md`** — the ordered work ledger. The first unchecked item is the next action (the SessionStart hook prints it). Tick items only when they are done and verified.
2. **`main-spec/Domácí úkol BE.pdf`** — the assignment. `TODO.md` mirrors it; when in doubt, the PDF wins.
3. **`docs/specs/`** — design specs (`/design-spec` output). The consistency spec from TODO step 0 is the source of truth for message metadata, freshness, dedup and atomicity once written.
4. **`docs/plans/`** — implementation plans (`/plan` output), carrying a `STATUS: SHIPPED` header once executed.

## Stack

**Fixed by the assignment (do not re-litigate):** Node.js, strictly typed TypeScript, pnpm monorepo, RabbitMQ, MongoDB, Docker Compose (development only), long-lived socket connections between devices and ingest, automated tests with at least part of them integration tests against real MongoDB and RabbitMQ instances.

**To be decided and recorded in `docs/specs/` (TODO steps 0–2):** socket protocol and framing, validation library, AMQP client, MongoDB driver, test runner, logger, config loading. Once a library is chosen, pin its version and cite the docs it was verified against. Never pick or use a library from memory: look its documentation up for the version being pinned — `/find-docs` where that user-scope skill is installed, otherwise directly (Ref MCP → Context7 MCP → web fetch). Wherever a skill or agent in this repo says `/find-docs`, it means this lookup.

## Repo layout (target — created in TODO step 1)

```
apps/emulator/      configurable number of emulated devices; socket clients; event generator
apps/ingest/        socket server; validates messages; publishes to RabbitMQ; stateless, horizontally scalable
apps/processing/    RabbitMQ consumer; stores events and maintains current device state in MongoDB; horizontally scalable
packages/shared/    message contract (types + validation schema), device-state type, queue/collection naming, config, logging
docs/specs/         design specs (/design-spec)          docs/plans/   implementation plans (/plan)
main-spec/          the assignment                  TODO.md       ordered work ledger
```

Workspace packages are named `@telemetry/<dir>` (`@telemetry/ingest`, …). `apps/*` depend on `packages/*`, never the reverse; `packages/shared` holds the contract and cross-cutting helpers, not business decisions.

## Invariants (from the assignment — every design, plan and review checks them)

1. **Logical order wins.** The final state of a device reflects the logical order of the unique events that device produced. Older telemetry never overwrites newer known state.
2. **Duplicates have no effect.** A redelivered or duplicated message never causes a second business effect: no double counter increment, no repeated alert, no inconsistent state.
3. **Atomic state updates.** Every write to device state is a single conditional operation (or transaction) that enforces 1 and 2 at the storage boundary — no unguarded read-modify-write.
4. **Parallel across devices, serial within one.** Different devices are processed concurrently by many processing instances; events of one device never conflict with each other.
5. **Minimal throughput cost.** Race-condition handling must not serialise the whole pipeline.
6. **Both services scale horizontally**; ingest holds no per-device state.

The mechanism (message metadata, freshness rule, dedup key, atomic update shape, delivery semantics) is decided in TODO step 0 and recorded as the first spec in `docs/specs/`. Until it exists, treat it as open and ask instead of assuming.

## Conventions (load-bearing)

- **pnpm only** — never `npm install` / `yarn`. `workspace:*` for cross-package deps; every workspace package has `"private": true`; frozen lockfile in Docker builds.
- **Strict TypeScript everywhere.** `strict: true`; no `any`, no non-null assertions without a comment explaining why; types derived from the validation schema, not redeclared.
- **Language:** code, comments, commit messages, specs and plans in English. `README.md` in Czech (the assignment's language).
- **Commit style:** imperative subject, no Conventional Commits prefix, small atomic commits (the commit history is part of the assessment). Footer: `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- **Logging:** the shared structured logger, never `console.*` in service code; every log line about a message carries the device id and the message identity.
- **Configuration:** env vars validated at startup; a missing or invalid variable fails fast with a message naming it. Dev credentials live only in `docker-compose.yml` / `.env.example`. No secrets in code or logs.
- **Resilience:** every socket / AMQP / MongoDB operation has a timeout; reconnect with backoff; graceful shutdown on SIGTERM drains in-flight work; malformed input is rejected and logged, never crashes a service.
- **Tests:** unit tests co-located as `*.test.ts`; integration tests run against real MongoDB and RabbitMQ from Docker Compose, never mocks of the broker or the database. Scoped verify per package: `pnpm --filter @telemetry/<pkg> test && pnpm --filter @telemetry/<pkg> typecheck && pnpm --filter @telemetry/<pkg> lint`.

## Writing and deciding (load-bearing)

### Answers

- Reply in the language the user writes in. Code, comments, commits, specs and plans stay in English.
- Plain language: short sentences, everyday words, one idea per sentence. No filler, no hedging, no marketing tone, no restating the question.
- Keep established technical terms — race condition, idempotency, at-least-once delivery, dead-letter queue, backpressure, prefetch. Renaming them into "simpler" words is worse than using them; if the reader may not know a term, explain it once in a sentence and then use it.
- Say what was done, what was found and what is still open. Commands, code and numbers go into code blocks or tables, not into prose.

### Decisions

- **KISS wins.** The simplest solution that meets the assignment is the default. Add a layer, an abstraction, a library or an infrastructure component only when a requirement demands it.
- **Name the trade-off.** When the simple solution gives something up compared with a more complex one — throughput, exactly-once effects, operational safety, future flexibility — say so explicitly in the spec, the plan or the README: what is lost, when it would start to matter, and what the upgrade path is. A trade-off that is not written down does not exist for the reviewer or for the technical discussion.
- **No premature optimisation.** Optimise only against a bottleneck that is measured or clearly reasoned and named in a spec. Caching, batching, pooling, custom binary protocols or "for scale" indirection without such a reason do not go in; the reviewers treat them as over-engineering findings.

## Working rules (portable — they do not depend on anyone's personal Claude configuration)

These rules travel with the repository so that Claude behaves the same for every user who opens it. They are copied from the author's personal setup on purpose; if a personal configuration says otherwise, the rules here win inside this repository.

### End-of-turn report (hard rule)

The last message of every turn that did work ends with this block and nothing after it. Plain language, one line per item, each line a full sentence that says what and where. Never bury a status inside a paragraph.

**Done** — only what actually landed _and_ was verified, with the proof on the line (a commit sha, a test count, a file path). Partial work does not go here; it goes under To do with what is missing.
**To do** — what remains, in the order it should happen, each line naming who moves it next (Claude next turn, a later plan, a named skill) and what it waits on.
**Your actions** — everything only the user can do: console steps, merges, decisions, physical steps. Imperative phrasing, with the exact input or link needed. If there are none, write `none`.

- Keep it short: at most six lines per section; lead-in above the block at most two sentences; no other headers in the report.
- An item is done or it is not. "Mostly done", "should work", "pending confirmation" are To do items.
- When a skill prescribes its own hand-off block (Output / Next step / Session hygiene), render its content inside these three sections, not in addition to them.
- Mid-turn progress notes stay short and never repeat the block; the block appears once, at the end.

### Secrets

- A secret value never appears in the conversation, on a command line, or in a log. Inspect files that hold secrets with redaction only (key names, never values).
- Dev credentials live only in `docker-compose.yml` and `.env.example` (empty values). If a secret does leak into the chat, say so at once and treat it as compromised.

### Verification after changes

Run the scoped verify of every touched package, and the full pre-flight (`pnpm lint && pnpm typecheck && pnpm test`) before reporting anything as done. When imports or types change across packages, check the consumers as well.

### Debugging

Before proposing any fix: read the full error output and stack trace, trace the path from the entry point to the failure, identify the exact line or condition, and explain the root cause. Only then apply the minimal fix, with a test that reproduces the bug first. Never jump to the first plausible fix; if other tests break, revert and re-analyse.

### Adding a dependency

Before proposing or installing any npm package: check maintenance (last publish, maintainers, open issues), adoption (weekly downloads) and known advisories, verify the current API in its documentation, and record the findings with the pinned version in the spec or plan before the package lands.

### Walking the user through steps

When a procedure needs the user's own actions (console steps, pushes, decisions), present one step at a time and wait for confirmation before the next one. Never dump the whole remaining list as instructions to execute.

### Honest correction over agreement

Treat the user's stated view as open to correction. Say plainly where it is right, partly right or wrong, with reasoning and sources; steelman the other side before critiquing it; flag confirmation bias or anchoring when you see it. Praise for directness is not a reason to soften the next answer.

## Commands (root, once TODO step 1 lands)

```bash
pnpm install --frozen-lockfile
pnpm lint && pnpm typecheck && pnpm test                     # full pre-flight
pnpm --filter @telemetry/<pkg> test                          # one package
docker compose up -d --build                                 # whole system: RabbitMQ, MongoDB, ingest, processing, emulator
docker compose up -d --scale ingest=2 --scale processing=3   # horizontal scaling check
```

## Workflow

### Skills (`.claude/skills/`) — invoke with `/<name>`

| Skill          | When                                                                                                 | Output                                    |
| -------------- | ---------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| `/design-spec` | Approach not yet decided — one question at a time, 2–3 approaches with trade-offs, spec.             | `docs/specs/YYYY-MM-DD-<topic>-design.md` |
| `/plan`        | Approach is clear — reviewed implementation plan with tasks, verify commands, verification criteria. | `docs/plans/YYYY-MM-DD-<topic>-plan.md`   |
| `/implement`   | Plan approved — per-task execution (inline or fresh subagent), two-stage review, atomic commits.     | Code + commits                            |
| `/verify`      | After `/implement` — run every verification criterion, report pass/fail with evidence.               | Verification report                       |
| `/test-review` | After writing tests outside `/implement` — audit for meaningfulness.                                 | `test-quality-reviewer` report            |

**Default loop:** `/design-spec` → `/plan` → `/implement` → `/verify`. Skip `/design-spec` only when the approach is already locked in a spec. Each flow skill ends with a fixed hand-off block (output path, next step, session-clear signal), and `/design-spec` and `/plan` end with a **Backbrief** (end-state, critical constraints, latitude) so the delegation to the next step is visible.

User-scope skills the author uses alongside, not part of this repo and not required: `/debug` (root-cause-first bug fixing — the Debugging rule below is the fallback), `/find-docs` (current library docs — see Stack for the fallback), `/grill-me` (stress-testing a design before it is written down).

### Review agents (`.claude/agents/`) — spawned by the skills, not user-invoked

| Agent                      | Model  | Spawned by                           | Role                                                                                            |
| -------------------------- | ------ | ------------------------------------ | ----------------------------------------------------------------------------------------------- |
| `design-reviewer`          | sonnet | `/design-spec`                       | Adversarial review of the spec against the assignment's questions and invariants before `/plan` |
| `plan-reviewer`            | sonnet | `/plan`                              | Adversarial review of the plan before `/implement`                                              |
| `spec-compliance-reviewer` | haiku  | `/implement` Stage 1                 | Binary "does the code match the plan task?"                                                     |
| `code-reviewer`            | sonnet | `/implement` Stage 2                 | Code quality, resilience, invariants, security, test _existence_                                |
| `test-quality-reviewer`    | sonnet | `/implement` Stage 2, `/test-review` | Test _meaningfulness_: rejects tautology, mock-only, framework and sleep-driven tests           |

Findings are `BLOCKING` (must fix) or `SUGGESTION`. BLOCKING findings loop the parent skill back, max 2 iterations. Reviewers have no doc tools: an unverifiable API claim is flagged `needs docs: <library>` and the parent skill resolves it with `/find-docs`.

**Don't skip the reviewers.** The review loop is cheaper than rework, and the technical discussion will probe exactly what the reviewers check.
