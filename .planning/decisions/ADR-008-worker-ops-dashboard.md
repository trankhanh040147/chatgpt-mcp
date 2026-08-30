# ADR-008 — Worker ops via dashboard (v0.6)

**Status:** Accepted  
**Date:** 2026-08-30

## Context

Changing ChatGPT account or worker chat URL requires editing multiple surfaces (`CHATGPT_WORKER_URL`, `workers.a1s.json`), approving MCP, clearing `CONSENT_REQUIRED` in SQLite, and restarting broker — error-prone and blocks E2E.

Rotation CLI (`rotate-worker`) and `create-worker` exist but are terminal-only and do not clear consent automatically.

## Decision

1. **Single operator surface:** dashboard mutations on loopback `:8787` (same CSRF/origin model as recover/fail-task).
2. **Broker-primary config:** `HANDOFF_WORKERS_FILE` is authoritative; dashboard writes registry atomically (`upsertWorkerRegistryEntry`).
3. **Lite control plane (frozen 2026-08-30):** imperative `POST /ops/workers/*` → `enqueueOperation` → `worker_operations` journal → idempotent `reconcile()` → broker HTTP ([ADR-009](./ADR-009-runtime-cdp-ownership.md)). Not full desired-state PATCH in v0.6.0.
4. **URL change pipeline:** assign or create chat → ensure registry + DB + broker bind → **SYSTEM_PROBE** → clear `readiness_reason`. Normal dashboard flow must **not** set `RESTART_REQUIRED`.
5. **SESSION_LOST heal:** dashboard detects → operator confirms modal → kill+recreate (not silent).
6. **Dynamic N workers:** registry length drives bind attempts; unbound workers show BLOCKED/UNBOUND; fleet continues (G3).

## Consequences

- Reuse `createWorkerChat`, `commitRotatedWorker` patterns; new `WorkerOpsService` orchestrates.
- Broker exposes rebind API callable from status-api (in-process or IPC — see impl plan).
- v0.7 Handoff Resources E2E depends on this for CONSENT/URL recovery.

## Alternatives rejected

- **Manual sqlite only** — does not solve frustration.
- **Full silent auto-heal** — risk loop on wrong account/login.
- **`.env` as SSOT** — conflicts with multi-worker broker.
