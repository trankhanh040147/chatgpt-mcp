# Task plan — 0.4.0 Ops dashboard

**Goal:** Local ops UI to monitor workers/tasks without log diving.  
SSOT: `docs/roadmap.md` §0.4.0.

## Dashboard versioning

| Dash ver | Scope | Status |
|----------|--------|--------|
| **0.1** | Read-only poll console | **Done** |
| **0.2** | Read-only drill-down + truthful observability | **Done** |
| **0.3** | Guarded mutations + topology read-only | **Done** |
| **0.3+** | Usage estimates + metric chips; charts/create-worker UI later | **Usage done** |

## 0.3 shipped

- `src/ops/recover.ts` plan/execute + selective worker reset
- Preview + one-shot planToken; CSRF; Origin allowlist; `failOpen` CLI-only
- Modal blast-radius confirm (`RECOVER <n>` / `FAIL <id>`)
- Topology allowlist/redact; `npm run test:ops`

## Usage estimates shipped

- `task_usage` snapshots; tokens primary
- Optional reference cost vs Cursor scenario (Claude Sonnet 5)
- Metric chips UI; drawer “Compared with” / “Billing not measured”
- `npm run test:usage`, `npm run usage:backfill`

## Next

- **0.6.0** portable core (`taskId` authoritative)
- Dash charts / create-worker UI when needed (deferred past 0.4.0)
