---
name: verify
description: >
  Post-implementation verification against the plan's acceptance criteria and
  the assignment's standing invariants. Runs each verification criterion,
  reports pass/fail with evidence, and diagnoses failures. Use after
  /implement completes.
---

# Verification Workflow

Follow the shared tool compatibility rules in `CLAUDE.md`.

**Announce:** "Using /verify to check the implementation against acceptance criteria."

## Purpose

Tests passing is not the same as "done." This skill checks whether what was built actually satisfies the plan's requirements and the assignment's invariants from the user's perspective.

## Phase 1: Load Criteria

1. Read the plan file. If no path via $ARGUMENTS, ask the user.
2. Extract the **Verification Criteria** table from the plan.
3. If the plan has no verification criteria section, build one from the plan's tasks and the design spec's requirements. Present it to the user for confirmation before proceeding.
4. **Add the standing assignment criteria** that apply to the plan's scope (see below). They are verified on every plan that touches the relevant area, whether or not the plan listed them.

### Standing assignment criteria

| Applies when the plan touches | Criterion                                                                                      | How to verify                                                                                |
| ----------------------------- | ---------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| device state                  | The same message delivered twice yields one event document, one counter increment, one alert   | integration test run + inspect the collection                                                |
| device state                  | An older message arriving after a newer one leaves the state unchanged                         | integration test run                                                                         |
| processing                    | Several processing instances over one queue end in the state the logical order dictates        | `docker compose up -d --scale processing=3`, run the emulator, reconcile per device          |
| ingest                        | Several ingest instances accept devices concurrently; no device depends on a specific instance | `docker compose up -d --scale ingest=2`, run the emulator, all devices' events reach MongoDB |
| ingest or processing          | Malformed input is rejected and logged; the service and the connection survive                 | send a bad frame / bad payload, check logs and health                                        |
| ingest or processing          | SIGTERM drains in-flight work before exit                                                      | `docker compose stop <service>` mid-run, no lost or half-written message                     |
| any service                   | Readiness endpoint reflects broker/database connectivity                                       | `curl -s localhost:<port>/health` before and after stopping a dependency                     |
| emulator                      | Device count and event rate are configurable via env                                           | run with two settings, observe the difference                                                |

## Phase 2: Run Checks

For each criterion:

1. **Execute** the verification command or inspection step.
2. **Capture** the output as evidence.
3. **Classify:** PASS (evidence confirms criterion) or FAIL (evidence contradicts).
4. Record in the verification report.

Rules:

- No claims without evidence. If you can't run the check, say so.
- Run checks in the current codebase state — do not modify code during verification.
- If a check requires running infrastructure, start it yourself with `docker compose up -d --build` (or the subset the check needs) and stop what you started afterwards. If Docker is unavailable, tell the user and mark the check as NOT RUN, never as PASS.
- Common verification commands:
  - Per-package types: `pnpm --filter @telemetry/<pkg> typecheck`
  - Per-package tests: `pnpm --filter @telemetry/<pkg> test`
  - Full pre-flight: `pnpm lint && pnpm typecheck && pnpm test`
  - Whole system: `docker compose up -d --build`, then `docker compose ps` and `docker compose logs --tail 50 <service>`
  - Scaling: `docker compose up -d --scale ingest=2 --scale processing=3`
  - Health: `curl -s localhost:<port>/health` (ports per `docker-compose.yml`)
  - Data inspection: `docker compose exec mongodb mongosh --quiet --eval '<query>'` and the RabbitMQ management UI or `docker compose exec rabbitmq rabbitmqctl list_queues`

## Phase 3: Diagnose Failures

For each FAIL:

1. **Root cause:** Trace why the criterion isn't met. Read relevant code, test output, and logs.
2. **Minimal fix:** Describe the smallest change that would satisfy the criterion.
3. **Classify:** Missing implementation, bug, or spec mismatch.

## Phase 4: Report

```markdown
## Verification Report

**Plan:** [plan file path]
**Date:** YYYY-MM-DD
**Result:** [N/M criteria passed, K not run]

### Results

| #   | Criterion | Result | Evidence |
| --- | --------- | ------ | -------- |
| 1   | ...       | PASS   | [output] |
| 2   | ...       | FAIL   | [output] |

### Failures

#### F1 — [Criterion]

**Evidence:** [What was observed]
**Root cause:** [Why it fails]
**Fix:** [Minimal change needed]
**Classification:** [Missing impl | Bug | Spec mismatch]
```

## Phase 5: Next Steps

- **All PASS:** "All verification criteria met." Suggest updating the plan task status if `/implement` Phase 6 has not run yet.
- **Some FAIL:** "N criteria failed. Want me to fix them?" Do NOT fix automatically — let the user decide. Fixes go through the Debugging Protocol in `/implement` (root cause first).
- **Spec mismatch:** Flag that the plan or the spec may need updating, not just the code.
- **Known limits surfaced:** anything that passed only with a caveat goes to the README's "known limits and conscious compromises" list.

## Phase 6: Handoff & Session Hygiene

Purpose: tell the user the relative path of the next step's input document and either confirm session-clear safety or block clearing until the in-session failure context has been captured.

### All PASS

No new project state — verify confirms what code + plan already say. Print:

```
**Output:** verification report above — pass evidence captured inline.

**Next step:** the next user-requested task (or `/implement` Phase 6 cleanup if it has not run).

**Session hygiene:** ✅ Safe to clear session — the plan status is accurate; the report above is preserved in the transcript.
```

### Some FAIL

Failure diagnoses live only in this session — clearing would lose the root-cause analysis. Print:

```
**Output:** verification report above — <N> failures with root cause + minimal fix per failure.

**Next step:** decide between fixing in-session or capturing failures into a follow-up plan first.

**Session hygiene:** ❌ NOT safe to clear yet — failure diagnoses live in this session only. Either fix in-session, or write the failure list to `docs/plans/<date>-<topic>-followup.md` before clearing.
```
