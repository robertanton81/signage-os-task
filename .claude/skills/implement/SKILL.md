---
name: implement
description: >
  Execute an approved implementation plan task by task — inline or with an
  isolated subagent per task — with two-stage review (spec compliance, then
  code quality + test quality) and atomic commits. Use after /plan produces
  an approved plan.
---

# Implementation Workflow

**Announce:** "Using /implement to execute the approved plan."

## Golden Rule

Never assume. If a plan step is unclear, an API behaves differently than expected, or a test fails for an unexpected reason — ask the user.

## Phase 1: Load Plan

1. Read the approved plan file. If no path was provided via $ARGUMENTS, ask the user.
2. Read project context:
   - `CLAUDE.md` — stack, invariants, conventions
   - `TODO.md` — which step this plan executes
   - The design spec the plan cites (the consistency spec whenever the plan touches state)
3. **Build project snapshot** (reused by all subagents in Phase 2):
   ```bash
   git branch --show-current
   git log --oneline -3
   ```
   Collect: current branch, last 3 commit summaries, list of packages affected by this plan, key file paths from the plan's File Changes table. Store as a `<project_snapshot>` text block — do not re-derive per subagent.
4. Review the plan critically before starting. Raise issues with the user.
5. Count tasks. Determine execution mode:
   - **1-2 tasks:** Inline mode (execute in main context)
   - **3+ tasks:** Per-task decision (see Phase 2)
6. **Seed the todo list.** If the harness offers a task/todo tool, create one item per plan task using the plan's task title. This gives the user live progress visibility alongside the plan file. Skip silently if no such tool exists or the plan has one task.

### Confirm Constraints

- **Branch:** Correct branch? Check with `git branch --show-current`.
- **Scope:** Which packages? Do NOT touch files outside the boundary.
- **Dependencies:** All required packages installed? `pnpm install` if needed.
- **Infrastructure:** Integration tests need `docker compose up -d rabbitmq mongodb`. Check it is up before the first integration task.

## Phase 2: Execute Tasks

### Per-task: dispatch subagent OR inline?

This decision is **per-task**, not per-plan. A 16-task plan where every task is a 5-line edit should NOT spawn 16 subagents — subagent overhead (prompt + tool result + summary) routinely costs more tokens than the work saves, and the overhead lands in the main session's context window.

**Do the work inline** (in the main session) when ANY of these holds:

- Hand-edited surface is < ~30 lines AND lives in a single file
- Plan tag is `[mechanical]` AND the content is provided verbatim in the plan body (copy-paste with placeholder substitution)
- Task is purely verification (grep, ls, file inspection, `pnpm` script run)
- Task is a config add, single-section append, or one-line replacement
- Same file was just edited a few turns ago and the relevant context is already cached

**Dispatch a subagent** ONLY when:

- Task changes ≥ 30 lines of hand-written content (not counting copy-paste from the plan), OR
- Task spans multiple unrelated files where staging discipline matters across boundaries, OR
- Task needs a fresh context (review against a large plan/spec, big-codebase introspection), OR
- Task blocks on a slow operation the main session shouldn't sit through (multi-minute integration run against Compose), OR
- Plan tag is `[integration]` AND the task involves real judgment (not just copy-paste)

When in doubt, default inline. Re-dispatch only when the inline pass actually surfaces a need for isolation.

**When doing inline, you still respect** every contract a subagent would:

- Mark the task in progress before starting; completed after the commit lands.
- Stage explicitly named files only — never `git add -A` or `git add .`.
- Same scoped verify command as the plan specifies.
- Atomic commit per task with the imperative subject + Co-Authored-By footer.

### Subagent Mode (when dispatch is justified by the rule above)

For each task that justifies a subagent:

1. Mark the task in progress before dispatching the subagent.
2. Dispatch a fresh implementation subagent (see below).
3. After the atomic commit lands and both review stages pass, mark the task completed.

Dispatch shape:

```
Agent(
  subagent_type: "general-purpose",
  model: "[haiku for mechanical, sonnet for integration]",
  prompt: [task text + context below]
)
```

**What to include in the subagent prompt:**

- The `<project_snapshot>` block from Phase 1 step 3 (verbatim — do not re-derive)
- Full task text from the plan (the subagent never reads the plan file)
- Relevant file paths and current content summaries
- Project conventions (reference `CLAUDE.md`)
- Project rules (verbatim, every dispatch):
  - The six invariants from `CLAUDE.md` "Invariants" — quote the ones the task touches, with the mechanism the consistency spec prescribes (freshness guard, dedup key, atomic update shape, ack after write)
  - pnpm only — no `npm install` / `yarn`; `workspace:*`; `"private": true`
  - Strict TypeScript — no `any`, no `@ts-ignore`, types inferred from the shared schema
  - Shared structured logger, never `console.*`; every message log line carries device id + message identity
  - Every socket / AMQP / MongoDB operation has a timeout; malformed input is rejected and logged, never crashes
  - Unit tests co-located as `*.test.ts`; broker/DB paths get integration tests against the Compose services, never mocks of the client
  - Commit message: imperative, no Conventional Commits prefix, `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>` footer
- Scoped verify command (per-package): `pnpm --filter @telemetry/<pkg> test && pnpm --filter @telemetry/<pkg> typecheck && pnpm --filter @telemetry/<pkg> lint`
- Instruction to commit atomically when done and to report `DONE` / `DONE_WITH_CONCERNS` / `NEEDS_CONTEXT` / `BLOCKED`

**What NOT to include:**

- Other tasks' details
- Session history
- The full plan file

**Model selection per task:**

- `[mechanical]` tag → Haiku (1-2 files, clear spec, checklist-following)
- `[integration]` tag → Sonnet (multi-file, judgment needed)
- If no tag, default to Sonnet
- **Do NOT pass `model: "opus"` as a blanket override.** Reserve it for subagents that genuinely need a very large context (e.g. a reviewer reading a long plan + spec + many files at once) and justify it inline in the dispatch prompt so the cost is visible.

**Subagent status handling:**

- **DONE:** Proceed to review
- **DONE_WITH_CONCERNS:** Read concerns. If correctness/scope, address before review. If observations, note and proceed.
- **NEEDS_CONTEXT:** Provide missing context, re-dispatch
- **BLOCKED:** Assess: context problem → re-dispatch with more context. Task too complex → re-dispatch with Sonnet. Plan wrong → ask the user.

### Inline Mode

Execute sequentially in the main context. For each task:

1. Mark the task in progress (skip if the todo list wasn't seeded).
2. Follow the plan's steps exactly.
3. Follow `CLAUDE.md` conventions and the project rules listed above.
4. Write co-located `*.test.ts` files for every module with logic; integration tests for every broker/DB path.
5. Run scoped verification after completing:
   ```bash
   pnpm --filter @telemetry/<package> test \
     && pnpm --filter @telemetry/<package> typecheck \
     && pnpm --filter @telemetry/<package> lint
   ```
6. Create an atomic commit (imperative subject, Co-Authored-By footer).
7. Mark the task completed.

### Debugging Protocol

If a test fails for a non-obvious reason:

1. **Read** the full error output and stack trace.
2. **Trace** the execution path from entry point to failure.
3. **Identify** the EXACT line/condition causing the failure.
4. **Explain** your root cause analysis before proposing a fix.
5. **Regression test:** Write a test that reproduces the exact bug. Verify it fails.
6. **Minimal fix:** Change as few lines as possible.
7. **Verify:** Regression test passes, full suite has no regressions.
8. **If other tests break:** REVERT immediately — the root cause was wrong. Re-analyze.
9. **If 3+ fixes fail:** Stop. The issue is architectural. Ask the user.

## Phase 3: Two-Stage Review (per task)

**Skip review** if the task changed fewer than 30 lines (`git diff --stat`) AND touched no state-writing, queue, or socket code. State, queue and socket changes are always reviewed.

Otherwise, run two sequential reviews:

### Stage 1: Spec Compliance (fast, cheap)

Launch a **spec-compliance-reviewer** subagent (`subagent_type: "spec-compliance-reviewer"`, `model: "haiku"`).

Prompt includes: plan task text + list of changed files + `git diff`.

This reviewer answers ONE question: does the code match what the plan specified? Nothing extra, nothing missing. Binary pass/fail.

- If FAIL: fix the gaps, re-run Stage 1.
- If PASS: proceed to Stage 2.

### Stage 2: Code Quality + Test Quality (parallel)

Launch **two reviewer subagents in parallel** in a single message (separate `Agent` tool calls in the same response):

1. **code-reviewer** (`subagent_type: "code-reviewer"`, `model: "sonnet"`) — conventions, resilience, invariants, security, error handling, test *existence/coverage*, everything except plan adherence (already verified in Stage 1) and test *meaningfulness* (delegated to the test-quality-reviewer below).

2. **test-quality-reviewer** (`subagent_type: "test-quality-reviewer"`, `model: "sonnet"`) — runs whenever the diff touches **any** test file (`*.test.ts`, `*.spec.ts`, anything under `test/` or `tests/`) **or** when source files with logic were added/modified without paired tests. This reviewer rejects tautology tests, mock-only tests, framework tests, sleep-driven integration tests, skipped/todo tests, and any other form that always passes regardless of SUT behavior. **This stage is non-skippable** — every implementation that touches tests is audited for meaningfulness, not just existence.

Each prompt includes: changed files + `git diff` + (for the test-quality-reviewer) the list of source files in the diff so it can cross-check coverage of new logic.

Merge the two reports. Address every `BLOCKING` finding from either reviewer, re-run scoped verification, then re-dispatch **only the reviewer that flagged the issue** (don't re-run the other). A `needs docs: <library>` finding is resolved with `/find-docs` before re-dispatch.

- **Maximum 2 iterations per reviewer per task.** If still not clean: present to the user.

If the diff has zero test-file changes AND zero source files with logic added/modified (e.g. a docs-only or config-only task), skip the test-quality-reviewer.

## Phase 4: Finalize

After all tasks are implemented, reviewed, and committed:

1. Run the full pre-flight:
   ```bash
   pnpm lint && pnpm typecheck && pnpm test
   ```
2. Fix any issues found.

## Phase 5: Present to User

Summary:

- Tasks completed (with check marks)
- Files created/modified
- Commits made (list with hashes)
- Test count and pass status
- Review iterations and what was caught
- Any deviations from the plan with justification
- Any remaining `SUGGESTION` findings

Do not push unless the user asks.

## Phase 6: Cleanup

After the user confirms the implementation is complete:

1. **Tick the `TODO.md` items** this plan completed. Only items that are done and verified; partial items stay unchecked.

2. **Add a `STATUS: SHIPPED` header to the plan file.** Plans are NOT moved to an `archived/` subdirectory; they stay in `docs/plans/` with a top-of-file blockquote that warns future readers not to re-execute and documents plan-vs-reality drift. Required structure:

   ```markdown
   > **STATUS: SHIPPED <YYYY-MM-DD>.** Landed as <N> commits ending at `<sha>`. The unchecked `- [ ]` boxes below are historical — work is done. **Do not re-execute this plan.** If you're modifying <area>, work directly in <code paths>.
   >
   > **Plan-vs-reality corrections discovered during execution:**
   >
   > **Library/version drift:** (pinned versions vs. installed, missing deps that had to be added)
   >
   > **Plan code prescriptions that needed adjustment:** (code samples in the plan that didn't compile/run as written, with the fix that shipped)
   >
   > **Corrections applied during review (commit `<sha>`):** (every BLOCKING finding from Stage 2 and how it was fixed)
   >
   > **Deferrals worth tracking:** (SUGGESTION findings that didn't ship; what to do, where, when — these feed the README's "known limits" and "what we'd do with more time" sections)
   >
   > **Plan history below is preserved as-written for context. Treat the live code as authoritative.**
   ```

   The drift bullets are the load-bearing payload. Think: "what would a future plan author copy-pasting from this plan need to know to not waste a day?" Be specific (file paths, exact symbols) — vague entries like "fixed a typecheck issue" rot fast.

3. **Commit both updates in a single commit** with subject `Mark <plan-name> shipped and update TODO`.

4. **Do NOT** move or rename the plan file. The path stays stable so references in commit messages remain valid.

## Phase 7: Handoff & Session Hygiene

Purpose: tell the user the relative path of the next step's input document and either confirm session-clear safety or block clearing until the in-session context (Phase 6 drift bullets) has been captured.

### Between Phase 5 and Phase 6

Phase 6 needs this session's review findings to write good drift bullets. Print:

```
**Output:** commits `<first-sha>..<last-sha>` on `<branch>`.

**Next step:** `/verify` — input doc: `docs/plans/<plan-file>.md`. (Or run Phase 6 cleanup first, then `/verify`.)

**Session hygiene:** ⏳ NOT safe to clear yet — Phase 6 (TODO tick + STATUS: SHIPPED header) needs the in-session review findings for the drift bullets. Run Phase 6 before clearing.
```

### After Phase 6

Print:

```
**Output:**
- Commits `<first-sha>..<last-sha>` on `<branch>`
- TODO tick + STATUS: SHIPPED header — committed in `<sha>`

**Next step:** `/verify` — input doc: `docs/plans/<plan-file>.md`. (Or the next unchecked item in TODO.md.)

**Session hygiene:** ✅ Safe to clear session — TODO.md and the plan header reflect the shipped state.
```
