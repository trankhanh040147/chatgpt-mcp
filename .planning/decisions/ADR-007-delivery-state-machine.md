# ADR-007 — Delivery state machine (point of no return)

**Status:** Accepted  
**Date:** 2026-08-29

## States (logical)

```text
CLAIMED              (DISPATCHING, lease held)
  ↓
PREPARING_RESOURCES  (attach attempt in UI mutex)
  ↓
RESOURCES_VERIFIED   (PrepareResult.ok)
  ↓
DISPATCH_STARTED     (markDispatchStarted — POINT OF NO RETURN)
  ↓
TASK_ID_SENT         (submitTaskId succeeded)
```

## Point of no return

`markDispatchStarted()` immediately before `submitTaskId()`.

**Before fence:** cleanup + requeue allowed (if `isClean()`).  
**After fence:** no automatic redispatch; late submit / TIMED_OUT semantics per existing lease rules.

If browser crashes after fence but before send → task may strand. Accepted tradeoff: **at-most-once TASK_ID** beats duplicate conversation turns.

## Implementation

- Comment at fence call site: `// POINT OF NO RETURN`
- Logs should include state transitions where practical
- Do not add new DB columns for v0.6 unless needed — logical states in worker + existing `dispatch_started_at` suffice

## Relation to ADR-004

Fence placement unchanged: after verify, before TASK_ID.
