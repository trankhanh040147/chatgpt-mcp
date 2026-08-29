# ADR-004 — Dispatch fence placement vs resource attachment

**Status:** Accepted (pending PR #5 implementation)  
**Date:** 2026-08-29

## Context

Today (`worker.ts`):

```text
openWorkerConversation()
markDispatchStarted()     ← fence: DISPATCHING → DISPATCHED + dispatch_started_at
waitUntilComposerIdle()
withUiWrite → submitTaskId()
```

`markDispatchStarted` is documented as an **irreversible dispatch fence** before UI send. Post-fence failures call `markDispatchFailed` → `markSubmitTimedOut` (fail closed, **no requeue**).

v0.6 adds **resource attachment** (UI mutation) before `TASK_ID`. If attachment runs post-fence, transient attach failures become permanent `TIMED_OUT`/`FAILED` too aggressively.

## What the fence protects today

1. **Duplicate TASK_ID** — once `dispatch_started_at` is set, the worker will not re-dispatch the same task id to chat (idempotent skip in `submitTaskId`).
2. **Late submit window** — post-fence tasks accept `handoff_submit_result` even after lease expiry (`TIMED_OUT` → `COMPLETED`).
3. **Pre vs post failure policy** — pre-fence → requeue (up to 3); post-fence → timed out, not requeued.

The fence is **not** a generic “any ChatGPT UI mutation” lock — it specifically marks “we are committed to this dispatch attempt.”

## Decision

**Move the fence to immediately before `submitTaskId`, after attachment verification succeeds.**

Target ordering inside one claim cycle:

```text
CLAIMED (DISPATCHING)
  ↓
PREPARING_RESOURCES        ← attach attempt(s), outside or inside mutex per design
  ↓
RESOURCES_VERIFIED         ← PrepareResult.ok === true
  ↓
DISPATCH_FENCED            ← markDispatchStarted() HERE
  ↓
TASK_ID_SENT               ← submitTaskId()
```

Attachment failure **before** fence → `markDispatchFailed` with lease opts → **requeue** (existing pre-fence path).

Attachment failure **after** fence should not occur if ordering is correct.

## Attachment retry / duplicate chips

- Do **not** retry attach inside the same UI-write pass after partial chip success (risk duplicate chips).
- Failed attach pre-fence: requeue whole task; next claim starts fresh composer state.
- If ChatGPT retains orphan chips from a failed attempt, chip matcher must not treat stale chips as satisfying **new** expected resources unless names match exactly (see per-file verification in active spec).

## Consequences

- PR #5 must refactor `worker.ts` ordering — not only add `composer-attach.ts`.
- `markDispatchStarted` name may stay; semantics = “TASK_ID send imminent,” not “any prep started.”
- E2E and unit tests must cover pre-fence requeue on `CHIP_MISMATCH` / `UPLOAD_TIMEOUT`.

## Alternatives rejected

- Keep fence before attach — attach failures too often permanent.
- Silent MCP fallback when attach fails — violates fail-closed production invariant (ADR-003).
