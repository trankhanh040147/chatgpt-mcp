# Task plan — 0.4.0 Ops dashboard

**Goal:** Local ops UI to monitor workers/tasks without log diving.  
SSOT: `docs/roadmap.md` §0.4.0.

## Dashboard versioning

| Dash ver | Scope | Status |
|----------|--------|--------|
| **0.1** | Read-only poll console | **Done** |
| **0.2** | Read-only drill-down + truthful observability | **Done** |
| **0.3+** | Guarded mutations; history/charts | Later |

## 0.2 shipped

- Task timing on list + detail (`queueMs` / `processingMs` / `totalMs` / finished)
- `GET /tasks/:id/detail` + `GET /tasks/:id/content` (redacted; `HANDOFF_DASHBOARD_TASK_CONTENT=redacted`)
- Worker `chatUrl` + Open worker chat
- Completed/failed/timeout counts last 24h (lease_owner kept on terminal)
- Derived indicators (no HALLUCINATE / fake OVERLOAD)
- Task drawer UI

## Next

- Package 0.4 smoke/docs/tag
- Dash 0.3 mutations when needed
