---
name: design-spec
description: >
  Explore a problem space through collaborative questioning, propose approaches
  with trade-offs, and produce a design spec. Use when the approach is not yet
  decided. Outputs to docs/specs/.
---

# Design Workflow

**Announce:** "Using /design-spec to explore the problem and produce a spec."

## Scope

This skill is for work where the right approach hasn't been decided. If the approach is already clear and the user just needs a plan, skip to `/plan`.

## Phase 1: Understand the Problem

1. Read the user's request: $ARGUMENTS
2. Read project context:
   - `AGENTS.md` — stack, invariants, conventions
   - `TODO.md` — which step this design serves and what is already done
   - `main-spec/Domácí úkol BE.pdf` — the assignment; its "Technické požadavky" section lists the questions every design must answer
   - `docs/specs/` — prior specs; the consistency spec (message metadata, freshness, dedup, atomicity) binds every later design once it exists
   - `apps/` and `packages/` — scan structure for what ships today
3. Search the codebase for related code, existing patterns, and prior decisions.
4. **Scope check:** If the request spans multiple independent subsystems (e.g. the socket protocol AND the state model), flag this immediately. Propose decomposition into separate design cycles. Each subsystem gets its own spec → plan → implement cycle.
5. **TODO mapping:** Name the `TODO.md` section and items this design covers. If it fits none, flag it and ask whether it is in scope.

## Phase 2: Surface Gray Areas

Before proposing anything, identify what you don't know.

1. List every assumption you'd need to make to design a solution.
2. Check which are already answered by `AGENTS.md`, the assignment, existing code, or prior specs.
3. For each remaining gray area — **ask the user**. Rules:
   - **One question per message.** Do not batch.
   - **Multiple-choice preferred.** Present 2-4 options with your recommendation marked. Open-ended only when options can't be enumerated.
   - **Include your recommendation and reasoning** with each question.
   - **Stop when you have enough clarity** to propose approaches. Don't interrogate.
4. Record each decision as you go — these become the **Decisions Log** in the spec.

## Phase 3: Research

Never design against a library from memory.

1. For every library, driver, or external service the design depends on, run `/find-docs` (Ref → context7 → web) for the version you intend to pin. Confirm the exact API the design relies on (e.g. the conditional-update semantics of the MongoDB driver, consumer prefetch and ack semantics of the AMQP client).
2. Record each verified fact with its version and source link — they become the spec's Research section.
3. If docs are unavailable or contradictory — ask the user rather than guessing.

Every technical claim in the design MUST cite a source link.

## Phase 4: Propose Approaches

Present **2-3 concrete approaches**. For each:

- **What:** Brief description
- **Trade-offs:** What you gain and lose — throughput, consistency guarantees, operational complexity
- **Fits with:** How it aligns with the monorepo (`apps/*`, `packages/shared`), the message contract, the RabbitMQ topology and the MongoDB model
- **Risk:** What could go wrong — ordering violations, duplicate effects, lost messages, broker or database outage, hot devices, scaling limits
- **Source:** Documentation links

End with a clear recommendation and reasoning.

### Pushback Rules

- If the request conflicts with the assignment's invariants or with well-established practice — push back with a source link.
- If there's a simpler way — propose it, even if the user described a specific approach.
- If the scope is too large — say so and propose a split.
- After pushing back, if the user insists with reasoning — accept and document the deviation.

## Phase 5: Write the Design Spec

Write to `docs/specs/YYYY-MM-DD-<topic>-design.md`.

### Spec Structure

```markdown
# [Feature Name] Design Spec

**Date:** YYYY-MM-DD
**Status:** Draft
**TODO items:** [section and items from TODO.md]
**Scope:** [Which packages/areas this affects]

## Problem

[What problem does this solve? Why now?]

## Decisions Log

| #   | Question | Decision | Reasoning |
| --- | -------- | -------- | --------- |
| 1   | ...      | ...      | ...       |

## Chosen Approach

[Description of the selected approach]

**Why this over alternatives:** [Brief justification]

## Research (source links)

- [Decision 1](source-url) — library@version, what was verified

## Design

### [Component/Area 1]

[Details — enough for /plan to produce a plan without guessing]

### [Component/Area N]

...

## Consistency & Failure Modes

[Required whenever the design touches ingest, the queue, or device state. Answer explicitly: which message metadata carries identity and order; how "newer" is decided; what the dedup key is and where it is enforced; which operation is atomic and what guarantees it; what happens on redelivery, out-of-order delivery, processor crash mid-message, broker outage, database outage; the delivery semantics (at-least-once delivery, exactly-once effect) and their consequences. Delete this section only if N/A.]

## Scaling

[How many instances of each service can run, what limits it, how load spreads across devices, what the throughput cost of the consistency mechanism is.]

## Alternatives Considered

### [Alternative 1]

[What it was, why it was rejected]

## Open Questions

[Any unresolved items — if none, delete this section]
```

### Spec Rules

- Every technical claim must have a source link.
- No placeholders: no TBD, TODO, or "to be decided".
- The design must be detailed enough for `/plan` without guessing.
- The six invariants in `AGENTS.md` are addressed by name wherever the design touches them.

## Phase 6: Self-Review

Before dispatching the reviewer, scan the spec yourself:

1. **Placeholder scan:** Any TBD, TODO, incomplete sections? Fix them.
2. **Internal consistency:** Do sections contradict each other?
3. **Scope check:** Is this focused enough for one implementation plan?
4. **Ambiguity check:** Could any requirement be interpreted two ways? Pick one.
5. **Assignment check:** Does the spec answer the assignment's four design questions (message metadata, "current state" and freshness, atomic operations, parallelism across devices) wherever they apply?

Fix issues inline. No need to loop — just fix and move on.

## Phase 7: Review Loop

Launch a **design-reviewer** subagent (`subagent_type: "design-reviewer"`, `model: "sonnet"`) to critically evaluate the spec.

1. Address every `BLOCKING` finding. A `needs docs: <library>` finding is resolved by running `/find-docs` and adding the source link. Update the spec.
2. Re-run the reviewer on the updated spec.
3. **Maximum 2 iterations.** If still not clean: present the spec to the user WITH remaining issues.

## Phase 8: Backbrief

Before handing off to the user, write a **Backbrief** synthesizing the spec in your own words. This is borrowed from Auftragstaktik (mission-type tactics): the goal is to make the delegation visible — what is locked, what is negotiable, what `/plan` and `/implement` will decide on their own.

The backbrief is three to five sentences, structured as three elements:

1. **End-state.** What the spec describes in one or two sentences. What the finished work looks like in the codebase and what capability it produces.
2. **Critical constraints.** The two or three things that must not be wrong. These are the parameters where a mistake means a redesign, not a revision (e.g. "the dedup key is the message id enforced by a unique index", "state is updated only through the conditional sequence guard", "ingest stays stateless").
3. **Latitude.** Where `/plan` and `/implement` will exercise judgment without coming back to ask. Name these explicitly so the user can reclaim control on specific dimensions before the plan is written (e.g. "module decomposition inside `apps/processing/src/`", "test file naming", "log field names").

**Rules:**

- Synthesize in your own words. If the backbrief reads like the spec rearranged, it hasn't demonstrated understanding — it's a transcript.
- Three to five sentences total. Longer means the spec is doing the synthesis poorly.
- Do not introduce new requirements. Backbrief is read-only on the spec.

## Phase 9: Present to User

> "Spec written to `docs/specs/<path>`. Backbrief follows. Please review the backbrief — if any of the _critical constraints_ are wrong or any _latitude_ item should be locked down, say so before we move to `/plan`."

Then print the backbrief inline. Wait for approval. If changes requested, update and re-run review (Phase 7).

## Phase 10: Handoff & Session Hygiene

Fires after Phase 9 approval. Purpose: tell the user the relative path of the next step's input document and confirm the session can be cleared without losing resume context.

Print this block exactly:

```
**Output:** `docs/specs/<file>.md`

**Next step:** `/plan` — input doc: `docs/specs/<file>.md`

**Session hygiene:** ✅ Safe to clear session — the spec is on disk and TODO.md points at the next step.
```

If the spec completed any `TODO.md` item outright (typically the step 0 design decisions), tick those boxes in `TODO.md` and leave the edit **unstaged** so the user controls when it lands; say so in the block. Never tick an item the spec only partially covers.
