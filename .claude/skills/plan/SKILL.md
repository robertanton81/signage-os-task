---
name: plan
description: >
  Create a reviewed implementation plan for a feature or task. Proactively
  surfaces assumptions and asks before proceeding. Takes a design spec
  (from /design-spec) or a clear user request as input. Outputs to docs/plans/.
---

# Planning Workflow

Follow the shared tool compatibility rules in `CLAUDE.md`.

**Announce:** "Using /plan to create a reviewed implementation plan."

## Golden Rule

Never assume. If requirements are ambiguous, API behavior is unclear, or there are multiple reasonable approaches — ask the user before proceeding.

## Phase 1: Understand

1. Read the user's request: $ARGUMENTS
2. If a design spec exists in `docs/specs/`, read it — it is the primary input. The consistency spec binds every plan that touches ingest, the queue, or device state.
3. Read project context:
   - `CLAUDE.md` — stack, invariants, conventions
   - `TODO.md` — which step this plan executes and what is already done
   - `apps/` and `packages/` — scan structure for what ships today
4. Search the codebase for related code, existing patterns, and reusable functions.
5. **TODO mapping:** Name the `TODO.md` section and items this plan executes. Existing plans in `docs/plans/` are the naming reference.

## Phase 2: Surface Assumptions

Before drafting, proactively identify what you're about to assume.

1. List every assumption needed to write this plan (branch, scope, boundaries, dependencies, integration points, which services must be running).
2. Check which are already answered by the design spec, `CLAUDE.md`, or codebase.
3. For remaining assumptions — **ask the user**. Rules:
   - **One question per message.** Do not batch.
   - **Multiple-choice preferred** with your recommendation marked.
   - **Propose, don't just ask.** Instead of "What branch?" say: "I'd commit to `main` directly — small atomic commits, no PR overhead for a solo repo. Sound right?"
   - **Stop when constraints are locked.** Don't over-question.

## Phase 3: Research

For every library, driver, or API the plan will reference:

1. Reuse the source links the design spec already records. Trust a pattern that has a link and a version.
2. For anything the spec did not cover, run `/find-docs` for the pinned version and record version + source link in the plan's Research section. Never write a code step against an API from memory.
3. If docs are unavailable or contradictory — ask the user.

## Phase 4: Draft

Write the plan to `docs/plans/YYYY-MM-DD-<topic>-plan.md`.

### Planner Persona

You are a non-biased technical planner. Your job is to find the best approach, not to please the user. Push back with sources when needed.

### Plan Document Structure

```markdown
# [Feature Name] Implementation Plan

**Goal:** [One sentence]
**Approach:** [2-3 sentences about the chosen approach and why]
**Design spec:** [Link to docs/specs/ if one exists, or "N/A"]
**TODO items:** [section and items from TODO.md]
**Branch:** [Target branch]
**Scope:** [Which packages are affected]

## Research (source links)

- [API/library decision 1](source-url) — library@version, what was verified

## File Changes

| Action | Path                     | Purpose              |
| ------ | ------------------------ | -------------------- |
| Create | `exact/path/file.ts`     | What it does         |
| Modify | `exact/path/existing.ts` | What changes and why |

## Tasks

### Task 1: [Component Name] [mechanical|integration]

**Files:** Create `path/to/file.ts`, Test `path/to/file.test.ts`
**Invariant:** [which CLAUDE.md invariant this task upholds and which test proves it — or "none touched"]
**Verify:** `pnpm --filter @telemetry/<package> test && pnpm --filter @telemetry/<package> typecheck && pnpm --filter @telemetry/<package> lint`

- [ ] Write failing test for [behavior]
- [ ] Verify test fails
- [ ] Implement minimal code to pass
- [ ] Verify test passes
- [ ] Commit — imperative subject, no assistant attribution

### Task N: ...

## Verification Criteria

For each requirement, define what "done" looks like beyond "tests pass":

| #   | Criterion                                                                       | How to verify                                                       |
| --- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| 1   | A message published twice yields one event document and one counter increment   | integration test `<path>` against the Compose RabbitMQ + MongoDB    |
| 2   | An older message arriving after a newer one leaves the device state unchanged   | integration test `<path>`                                           |
| 3   | Three processing instances over one queue end in the same state as one instance | `docker compose up -d --scale processing=3` + reconciliation script |
| 4   | Ingest readiness endpoint returns 200 once the broker channel is open           | `curl -s localhost:<port>/health`                                   |

## Test Plan

- Scoped test commands per task
- Which integration tests need `docker compose up -d rabbitmq mongodb` first
- Full pre-flight at end: `pnpm lint && pnpm typecheck && pnpm test`

## Checkpoint Recovery

If interrupted mid-implementation, resume by:

1. Read this plan
2. Check git log for completed commits
3. Pick up from first uncompleted task
```

### Plan Rules

- Exact file paths always — never "somewhere in src/"
- Complete code in steps — no "implement the logic here"
- No placeholders: no TBD, TODO, "similar to Task N"
- Every step actionable by an engineer with zero context
- Each task tagged `[mechanical]` or `[integration]` for model selection
- Each task has a scoped verify command (per-package, not full monorepo)
- Each task ends with an atomic commit (imperative subject, no Conventional Commits prefix, no assistant attribution)
- Bite-sized steps: write test → verify fail → implement → verify pass → commit
- Every task that writes device state, consumes the queue, or publishes to it names the invariant it upholds and the test that proves it (duplicate case and out-of-order case at minimum)
- Every path that talks to RabbitMQ or MongoDB gets an integration test against the real service, not a mocked client
- pnpm only; `workspace:*`; `"private": true`; strict TypeScript; shared logger, never `console.*`

## Phase 5: Self-Review

Before dispatching the reviewer, scan the plan:

1. **Spec coverage:** Skim each requirement. Can you point to a task? List gaps.
2. **Placeholder scan:** Any TBD, TODO, vague steps? Fix them.
3. **Type consistency:** Do names used in later tasks match earlier definitions?
4. **Verification criteria:** Does every requirement have a criterion?
5. **Invariants:** Does every state-touching task name its invariant and its proving test?

Fix inline. No need to loop.

## Phase 6: Review Loop

Launch a **plan-reviewer** subagent (`subagent_type: "plan-reviewer"`, `model: "sonnet"`). Pass the plan file path and the design spec path (if it exists).

1. Address every `BLOCKING` finding. A `needs docs: <library>` finding is resolved by running `/find-docs` and adding the source link. Update the plan.
2. Re-run the reviewer.
3. **Maximum 2 iterations.** If still not clean: present to the user WITH remaining issues.

## Phase 7: Backbrief

Before handing off, write a **Backbrief** synthesizing the plan in your own words. This is borrowed from Auftragstaktik (mission-type tactics): the goal is to make the delegation to `/implement` visible — what is locked, what is negotiable, what the implementation subagents will decide on their own.

The backbrief is three to five sentences, structured as three elements:

1. **End-state.** What the plan delivers in one or two sentences — both what gets committed and what capability works after the last commit.
2. **Critical constraints.** The two or three things that must not be wrong during implementation. These are the parameters where a mistake means scrapping the branch, not amending a commit (e.g. "the state update is one conditional `updateOne`, never find-then-save", "ack only after the write resolved", "integration tests hit the Compose broker, not a mock", "pnpm only").
3. **Latitude.** Where `/implement` subagents will exercise judgment without coming back to ask. Name these explicitly so the user can reclaim control before implementation begins (e.g. "exact test file naming", "internal helper decomposition inside the listed task files", "log field names", "how to split a task into 1-2 commits if the implementation suggests it").

**Rules:**

- Synthesize in your own words. A backbrief that paraphrases the Goal/Approach lines is a restatement, not a synthesis.
- Three to five sentences total. Longer means the plan structure is doing the synthesis poorly — fix the plan, not the backbrief.
- Do not introduce new requirements. The backbrief is read-only on the plan.

## Phase 8: Present to User

After zero BLOCKING findings (or max iterations hit):

1. Summary: what it builds, key decisions, review iterations, remaining suggestions.
2. Print the **Backbrief** inline (from Phase 7).
3. Wait for explicit approval before `/implement`. If the user wants changes — update and re-run review.

## Phase 9: Handoff & Session Hygiene

Fires after Phase 8 approval. Purpose: tell the user the relative path of the next step's input document and confirm the session can be cleared.

Print this block exactly:

```
**Output:** `docs/plans/<file>.md`

**Next step:** `/implement` — input doc: `docs/plans/<file>.md`

**Session hygiene:** ✅ Safe to clear session — the plan is on disk and its Checkpoint Recovery section makes it resumable.
```
