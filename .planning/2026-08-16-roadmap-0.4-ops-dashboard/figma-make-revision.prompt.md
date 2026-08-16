# Figma Make — REVISION prompt (paste below the line)

Target file already exists: ChatGPT-MCP / page Dashboard.  
Rewrite all five desktop frames to match this brief exactly. Prefer regenerating the Healthy frame first, then clone layout for the other four states.

---

Revise the **chatgpt-mcp Ops Dashboard 0.1** designs. The current frames drift into a generic SaaS admin product. Rebuild them as a **single-page localhost ops console** with NO sidebar and NO mutating actions.

## Hard deletes (remove from every frame)

- Entire **SideNavBar** (Dashboard / Workers / Tasks / Terminal links)
- **System Operator** / Admin avatar / account row
- Buttons: Manage Pool, View All, Refresh (large), Initialize Agent, Retry Connection, View Logs
- Footer links: Documentation, Logs, Support
- Invented infra: AWS region/node labels, Database OK, Redis cache, CPU %, “agents”
- Fake task domains: sync_repo, build_index, clean_cache, run_metrics, `#892`-style IDs

## Canvas

- Exactly **five** desktop frames at **1440 × 900**
- Names: Healthy · Degraded · Session lost · API unreachable · Empty
- Same layout skeleton on all five (data/severity only changes)
- Everything critical fits the first viewport — no long scroll

## Composition (top → bottom)

### A. Utility header (~64px)

- Left: eyebrow `chatgpt-mcp · dashboard 0.1` + title **Ops**
- Right: live pill `API OK` (or `API DOWN`), `Updated 09:42:16`, clock `09:42:18 ICT`
- No breadcrumbs, no region chip

### B. Control plane strip (full width, compact KV — not KPI cards)

Label **Control plane**. Horizontal groups:

`Health` · `Lease reaper` · `Last tick` · `Requeued` · `Timed out` · `Failed`

### C. Workers — one row, three equal cards

Header: **Workers** + `3 registered · 3 healthy` (adjust per state).

Each card: mono ID (`w1`/`w2`/`w3`), status pill, Healthy/Unhealthy, rows:

- PID → `48291 · alive` | dead
- Heartbeat → `fresh · 1.2s` | stale
- Current task → middle-truncated `ho_…` or `—`
- Error → code or `—`

Healthy sample:

- w1 READY healthy, no task
- w2 BUSY healthy, current task `ho_01M047SACSTCR99M6RH3J83YX2`
- w3 READY healthy, no task

### D. Lower workspace — ~8/4 split

**Left — Recent tasks** (`Last 10`): table columns  
`Task ID | Status | Owner | Type | Age | Error`  
Use real handoff IDs `ho_…`, statuses from the domain enum, types like `second_opinion` (not invent repo jobs). Include one PROCESSING (w2), one WAITING_APPROVAL, rest COMPLETED on Healthy. No filters/pagination/create.

**Right — Troubleshoot**: short OK/warn/neutral hints + dark command block with **per-row copy** for:

```
curl -s http://127.0.0.1:8787/health | jq
make doctor
npm run recover
./scripts/start-broker-stack.sh
```

### E. Footer one line

`Polling every 2s · 127.0.0.1 only · read-only 0.1`

## State rules (keep layout fixed)

1. **Healthy** — as above
2. **Degraded** — w2 ERROR / unhealthy / PID dead / heartbeat stale / `WORKER_PID_DEAD`; count `3 registered · 2 healthy`; matching FAILED task owned by w2; local red only; hint about `make doctor`
3. **Session lost** — w3 SESSION_LOST, PID alive, error `CHAT_SESSION_LOST`; distinguish process-up vs ChatGPT session-down
4. **API unreachable** — header `API DOWN` + last seen; replace control-plane/workers/tasks content with unreachable message for `127.0.0.1:8787`; **keep** Troubleshoot commands; no mascot, no Retry button
5. **Empty** — API OK; workers empty panel (“No workers registered…”); tasks empty (“No handoff tasks yet”); Troubleshoot stays; **no** Initialize/Create worker button

## Visual

Light industrial: stone `#F3F1EC`, panel `#FBFAF7`, text `#172126`, teal accent `#087F78`. Fonts: **Sora** + **IBM Plex Mono**. No purple glow, no cream/terracotta editorial, no dark-mode default.

## Deliverable check

Before finishing, confirm each frame has: no sidebar, 1440×900, read-only, correct vocabulary (`ho_`, worker statuses, task statuses), and Troubleshoot commands present.
