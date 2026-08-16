# Findings — 0.2.0 multi-worker

## Round 1 — `ho_01M02X5366F8TBW4GG11E6JSZ6`

**REVISE.** Accepted: pre-send fence, dedicated status API, DB one-task-per-worker, instance_token concept, separate CDP profiles, real migration, topology validation.

## Round 2 — `ho_01M02XB0KPXAAAAW0FCE51X4ZH`

**REVISE (close; no fundamental blocker).** Accepted into v3:

1. `instance_token` on **every** ownership-sensitive CAS (not only startup)
2. Nudge = separate durable fence; **at most one** in 0.2.0; never auto-click approval
3. Migration **offline**; all ambiguous active rows → `TIMED_OUT` (old send-before-DISPATCHED)
4. Partial unique index = **sole** concurrency authority; `current_task_id` diagnostic only
5. `status-api` owns reaper; same binary different mode OK

## Open for later versions

**CDP fan-out cost (2026-08-15):** Dual-worker E2E needs 2 Chrome CDP profiles (`:9222` + `:9223`). Correct isolation, but RAM + workspace clutter. Tracked in [`docs/roadmap.md`](../../docs/roadmap.md) under Deferred → “Fewer CDP windows for N workers”. Do not collapse onto one CDP in 0.2.0.
