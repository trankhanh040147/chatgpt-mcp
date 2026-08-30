# ADR-008 — Worker ops via dashboard (v0.6)

**Status:** Accepted  
**Date:** 2026-08-30

## Context

Changing ChatGPT account or worker chat URL requires editing multiple surfaces (`CHATGPT_WORKER_URL`, `workers.a1s.json`), approving MCP, clearing `CONSENT_REQUIRED` in SQLite, and restarting broker — error-prone and blocks E2E.

Rotation CLI (`rotate-worker`) and `create-worker` exist but are terminal-only and do not clear consent automatically.

## Decision

1. **Single operator surface:** dashboard mutations on loopback `:8787` (same CSRF/origin model as recover/fail-task).
2. **Broker-primary config:** `HANDOFF_WORKERS_FILE` is authoritative; dashboard writes registry atomically (`upsertWorkerRegistryEntry`).
3. **URL change pipeline:** assign or create chat → commit topology + `commitChatRotation` semantics → broker rebind tab → **auto-canary** until `handoff_submit_result` succeeds → clear `readiness_reason`.
4. **SESSION_LOST heal:** dashboard detects → operator confirms modal → runs kill+recreate (not silent).
5. **Dynamic N workers:** registry length drives broker bind attempts; unbound workers show `UNBOUND` not perpetual ERROR.

## Consequences

- Reuse `createWorkerChat`, `commitRotatedWorker` patterns; new `WorkerOpsService` orchestrates.
- Broker exposes rebind API callable from status-api (in-process or IPC — see impl plan).
- v0.7 Handoff Resources E2E depends on this for CONSENT/URL recovery.

## Alternatives rejected

- **Manual sqlite only** — does not solve frustration.
- **Full silent auto-heal** — risk loop on wrong account/login.
- **`.env` as SSOT** — conflicts with multi-worker broker.
