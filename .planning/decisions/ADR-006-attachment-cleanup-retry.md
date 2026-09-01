# ADR-006 — Attachment failure, cleanup, and retry

**Status:** Accepted  
**Date:** 2026-08-29

## Context

Native attach mutates ChatGPT composer UI. Pre-fence failure is **not** automatically safe to retry:

- Partial upload may leave orphan chips
- `CHIP_MISMATCH` with stale chips from prior attempts
- `UPLOAD_REJECTED` may be permanent

## Decision

### 1. Classify prepare failures

```ts
type PrepareFailureReason =
  | "INPUT_NOT_FOUND"
  | "UPLOAD_TIMEOUT"
  | "CHIP_MISMATCH"
  | "UPLOAD_REJECTED";

type PrepareFailure = {
  ok: false;
  expected: string[];
  observed: string[];
  added?: string[];       // chips newly added this attempt
  reason: PrepareFailureReason;
  retryable: boolean;
};
```

Default classification:

| Reason | retryable | Notes |
|--------|-----------|-------|
| `INPUT_NOT_FOUND` | true | DOM not ready |
| `UPLOAD_TIMEOUT` | true | May succeed on retry |
| `CHIP_MISMATCH` | true* | Only after cleanup + `isClean()` |
| `UPLOAD_REJECTED` | false | Quota/policy — fail task |

\* `CHIP_MISMATCH` retry requires cleanup path below.

### 2. Cleanup before retry

`ResourceDeliveryTarget` exposes:

```ts
cleanup(): Promise<void>;
isClean(): Promise<boolean>;
```

Worker on `!prepared.ok`:

```text
await transport.cleanup()
if !(await transport.isClean()) → failHard (no requeue)
if retryable → markDispatchFailed → requeue
else → fail task
```

**Ship-bar invariant:** retry allowed only when composer attachment state is clean.

### 3. Verify added chips, not composer superset

Before upload: capture chip multiset `before`.  
After upload: capture `after`.  
`added = multisetDifference(after, before)`.

Pass iff `added` matches expected resource display names exactly (multiset equality).

Not: `expected ⊆ all chips` (stale chips cause false pass).

## Consequences

- Phase B implements before/after capture + multiset verify
- Phase C implements cleanup + retry classification
- E2E partial-failure scenario required

## Alternatives rejected

- Blind requeue on any pre-fence failure — duplicate/orphan chips
- Subset chip matching — false pass when stale chip names collide
