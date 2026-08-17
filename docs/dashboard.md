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

## What it covers (0.4.0)

| Area | Notes |
|------|--------|
| Control plane | Health, lease reaper, last tick, requeued / timed out / failed |
| Workers | id, status, healthy, pid, heartbeat, current task, error |
| Tasks | Recent list + drawer (timing, indicators, optional redacted content) |
| Recover / fail-task | Preview → typed confirm (`RECOVER <n>` / `FAIL <id>`); CSRF + origin allowlist |
| Usage | Estimated visible-text tokens; optional reference $ vs Cursor scenario (off by default) |

Tests: `npm run test:ops`, `npm run test:usage`. Backfill snapshots: `npm run usage:backfill`.

## Optional flags

| Env | Default | Effect |
|-----|---------|--------|
| `HANDOFF_DASHBOARD_TASK_CONTENT` | off | `redacted` enables on-demand prompt/result in the drawer |
| `HANDOFF_REFERENCE_PRICING` | `off` | `on` shows comparison $ (not ChatGPT invoices) |
| `HANDOFF_REFERENCE_SCENARIO` | `claude-sonnet-5` | Cursor-alternative price row |

## Out of this surface

Hosted SaaS, SSO, history charts, create-worker GUI, and auto-scaling stay deferred. Mutations never run from a silent GET.
