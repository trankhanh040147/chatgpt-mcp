# Figma Make — FINAL pass before engineering implement

Paste everything below the line into Figma Make.  
Target file: **ChatGPT-MCP** → page **Dashboard**.

Goal: one last correction so all five frames share the **Healthy · Ops Dashboard** skeleton. After this pass we implement in code.

---

## Context (do not ignore)

We already have a nearly-correct frame: **`Healthy · Ops Dashboard`**.

- **KEEP** that frame’s information architecture, spacing rhythm, typography, colors, worker cards, task table, and command block.
- **DO NOT** invent a new SaaS layout.
- **DO NOT** regenerate Healthy from scratch unless you only resize it to 1440×900 and apply the small polish listed below.
- The other frames (`Degraded · Ops Dashboard`, `Session lost · Ops Dashboard`, `API unreachable · Ops Dashboard`, `Empty · Ops Dashboard`) are WRONG. Replace them by **duplicating Healthy** and changing only data + severity styling.

There should be exactly **five** top-level desktop frames when done. No leftover SideNav variants.

---

## Non-negotiable rules (every frame)

1. **No left sidebar** — delete any `SideNavBar` / Dashboard·Workers·Tasks·Terminal nav.
2. **No account chrome** — no System Operator / Admin / avatar.
3. **Read-only 0.1** — no buttons except tiny **copy** icons on commands.  
   Forbidden: Force Sync, Manage Pool, View All, View Logs, Retry, Initialize Agent, Initiate Recovery, Refresh (large), Create worker.
4. **No invented product surface** — forbid: AWS/region chips, Redis/DB/CPU/Memory metrics, System Logs stream, `tsk-…` IDs, `DONE` status, `w2-node-beta` names, Load %, Pending Tasks KPI, `systemctl`, `mcp-cli`, `npm run start:agent`, Documentation/Logs/Support footer links.
5. Canvas size for all five: **1440 × 900** (not 1280).
6. Same component positions and column widths on all five frames. State = data + color only.

### Exact vocabulary

- Workers: `w1`, `w2`, `w3` only  
- Worker statuses: `READY` | `BUSY` | `SESSION_LOST` | `RATE_LIMITED` | `ERROR`  
- Task statuses: `QUEUED` | `DISPATCHING` | `DISPATCHED` | `PROCESSING` | `WAITING_APPROVAL` | `COMPLETED` | `FAILED` | `TIMED_OUT`  
- Task IDs: `ho_…` (middle-truncate; annotate full ID on hover)  
- Task types: e.g. `second_opinion`, `architecture_review` — never repo/CI job names

---

## Keep / polish Healthy (source of truth)

Frame name: **`Healthy · Ops Dashboard`**

Keep current structure:

1. Utility header — eyebrow `chatgpt-mcp · dashboard 0.1` + title **Ops** | pill `API OK` | `Updated 09:42:16` | `09:42:18 ICT`
2. Control plane strip — KV: `Health` · `Lease reaper` · `Last tick` · `Requeued` · `Timed out` · `Failed`
3. Workers row — three equal cards; count `3 registered · 3 healthy`  
   - w1 READY healthy, no task  
   - w2 BUSY healthy, task `ho_01M047SACSTCR99M6RH3J83YX2` (truncated)  
   - w3 READY healthy, no task  
   Card rows: PID · Heartbeat · Current task · Error
4. Lower 8/4: **Recent tasks (Last 10)** + **Troubleshoot**
5. Footer only: `Polling every 2s · 127.0.0.1 only · read-only 0.1`

Healthy polish only:

- Resize frame to **1440 × 900**
- Troubleshoot: replace the single “System Normal” banner with 2–3 short hint rows, e.g.  
  - OK: `All worker heartbeats are fresh`  
  - OK: `Lease reaper ticked within threshold`  
  - Neutral: `Use doctor before restarting the stack`  
  Then the dark command block with four copyable lines:
  ```
  curl -s http://127.0.0.1:8787/health | jq
  make doctor
  npm run recover
  ./scripts/start-broker-stack.sh
  ```
- Aim for ~8 task rows (PROCESSING on w2, one WAITING_APPROVAL, rest COMPLETED). Columns exactly:  
  `Task ID | Status | Owner | Type | Age | Error`

---

## Rebuild the other four frames FROM Healthy

**Method:** duplicate the polished Healthy frame four times. Rename. Change only labels/data/severity. Do not rearrange sections.

### 1) Degraded · Ops Dashboard

- API still OK
- Control plane visible (same KV strip — not a “DEGRADED” marketing banner, not Active/Failed/Pending KPI cards)
- Workers count: `3 registered · 2 healthy`
- **w2**: `ERROR`, unhealthy, PID `dead`, heartbeat `stale · 46s`, current task present, error `WORKER_PID_DEAD` (local red border/rail only)
- w1 + w3 remain READY healthy
- Recent tasks: one `FAILED` row owned by `w2` with error `WORKER_PID_DEAD`; other rows `ho_…` / COMPLETED
- Troubleshoot hints: warn/bad about w2 + `make doctor`
- Commands: same four commands only — **no** `make restart`, **no** Force Sync, **no** System Logs panel

### 2) Session lost · Ops Dashboard

- Same skeleton as Healthy; **no sidebar**
- **w3**: `SESSION_LOST`, unhealthy, PID **alive**, heartbeat may be fresh, error `CHAT_SESSION_LOST`
- Make the contrast obvious: process up, ChatGPT session down
- Affected task: `DISPATCHED` or `TIMED_OUT`, owner `w3`, id `ho_…`
- Hint: recover browser session before redispatch
- Commands: same four only — **no** Initiate Recovery / View Logs / mcp-cli

### 3) API unreachable · Ops Dashboard

- Header pill: `API DOWN` + `Last seen 2m 14s ago`
- Keep page chrome (header + footer + Troubleshoot commands)
- Inside the content region (control plane / workers / tasks area), show a quiet unreachable state:  
  - Title: `Status API is unreachable`  
  - Body: `Cannot load control-plane, worker, or task data from 127.0.0.1:8787.`  
- **Keep** the Troubleshoot command block; emphasize the health `curl`
- No cloud mascot, no Connection Lost hero, no Retry / View Logs, no `systemctl` fiction

### 4) Empty · Ops Dashboard

- API OK; control plane strip still visible (values may be quiet/zero)
- Workers region: one empty panel — `No workers registered` / `Start the broker stack, then wait for worker heartbeats.`
- Tasks table header remains; body: `No handoff tasks yet`
- Troubleshoot stays with the same four commands
- **No** sidebar, **No** Initialize Agent, **No** CPU/Memory/Conns widgets, **No** `npm run start:agent`

---

## Visual lock

- Background `#F3F1EC`, panels `#FBFAF7`, text `#172126`, teal `#087F78`
- Fonts: **Sora** + **IBM Plex Mono**
- Status must include text (not color alone)
- No purple glow, glassmorphism, dark-mode default, or cream/terracotta editorial look

---

## Acceptance checklist (Must pass before you finish)

- [ ] Exactly 5 frames, each **1440 × 900**
- [ ] Zero `SideNavBar` layers in the file’s keepers
- [ ] Zero mutating CTAs; only copy on commands
- [ ] Healthy / Degraded / Session lost share identical section order and widths
- [ ] All task IDs are `ho_…`; worker IDs are `w1`/`w2`/`w3`
- [ ] Degraded uses `WORKER_PID_DEAD`; Session lost uses `CHAT_SESSION_LOST` with PID alive
- [ ] API unreachable keeps Troubleshoot commands and has no Retry button
- [ ] Empty has no create/initialize worker control
- [ ] Footer is only: `Polling every 2s · 127.0.0.1 only · read-only 0.1`

When this checklist passes, stop. Engineering will implement from these five frames.
