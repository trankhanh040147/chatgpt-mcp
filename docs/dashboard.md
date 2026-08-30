# Ops dashboard

Local read/ops UI for workers and tasks. Bind is **loopback only** (`127.0.0.1:8787`). Do **not** tunnel `:8787` — that is the status API, not ChatGPT MCP.

ChatGPT still connects via [connect-chatgpt.md](connect-chatgpt.md) on `:8790/mcp`.

## Open

```bash
make dashboard-up          # A1-S stack: status-api + remote-mcp + broker
make dashboard             # print URL only (stack already running)
```

URL: `http://127.0.0.1:8787/dashboard/`

`make dashboard` does not start services. If the page shows API unreachable, start the stack (`make dashboard-up` or `npm run start`) and confirm `make status`.

## What it covers (0.6 worker ops)

| Area | Notes |
|------|--------|
| Control plane | Health, lease reaper, last tick, requeued / timed out / failed |
| Workers | id, status, ops health (`READY` / `DEGRADED` / `BLOCKED` / `OFFLINE`), pid, heartbeat, current task |
| Worker ops | Assign URL (inline in ops modal), create chat, kill+recreate, retry verify, enable/disable, add/remove worker — confirm modal + CSRF; CDP setup guide when binding is missing |
| Conditions | PROCESS / BROKER / BINDING / URL / SESSION / MCP per worker (`GET /workers/health`); `chatAccessDenied` when ChatGPT shows “don't have access to this conversation” |
| Chat budget | `tasks_on_chat / max` (default 20); warn at N−1; rotation readiness chips |
| Tasks | Recent list + drawer (timing, indicators, optional redacted content) |
| Recover / fail-task | Preview → one-click confirm modal (no typed phrase); CSRF + origin allowlist |
| Usage | Estimated visible-text tokens; optional reference $ vs Cursor scenario (off by default) |

URL and chat changes run through the **worker control plane** (`POST /ops/workers/*` → journal → broker HTTP on `:18788` by default). Normal dashboard flow: `CONSENT_REQUIRED` → probe → `READY` — **not** `RESTART_REQUIRED`.

**Access denied:** If workers point at chats the CDP Chrome account cannot open, health shows `chatAccessDenied` and the UI recommends **Assign URL** with a new chat URL from that Chrome session.

**Broker down:** If broker ops port is unreachable, worker ops show `BROKER:UNKNOWN` and a banner — use `make restart` (broker stack, not legacy `browser-worker`). Default port is **18788** (not 8788) to avoid clashes with other local dashboards. Check: `lsof -i :18788`.

CLI rotation remains available: [rotation.md](rotation.md).

Tests: `npm run test:ops`, `npm run test:worker-ops`, `npm run test:usage`. Backfill snapshots: `npm run usage:backfill`.

## Broker control token

`browser-broker` and `status-api` must share `HANDOFF_BROKER_OPS_TOKEN`. `./scripts/start-broker-stack.sh` persists a generated token to `logs/broker-ops.token` when unset. For manual runs, set the same value in `.env` for both processes.

## Optional flags

| Env | Default | Effect |
|-----|---------|--------|
| `HANDOFF_DASHBOARD_TASK_CONTENT` | off | `redacted` enables on-demand prompt/result in the drawer |
| `HANDOFF_REFERENCE_PRICING` | `off` | `on` shows comparison $ (not ChatGPT invoices) |
| `HANDOFF_REFERENCE_SCENARIO` | `claude-sonnet-5` | Cursor-alternative price row |
| `HANDOFF_BROKER_OPS_PORT` | `18788` | Broker control HTTP (loopback) |
| `HANDOFF_BROKER_OPS_TOKEN` | (generated in stack script) | Auth between status-api and broker |
| `HANDOFF_RECONCILE_INTERVAL_MS` | `5000` | Worker journal reconcile tick |

## Out of this surface

Hosted SaaS, SSO, history charts, and auto-scaling stay deferred. Mutations never run from a silent GET. Full desired-state `PATCH WorkerSpec` is deferred — v0.6 uses imperative ops only.
