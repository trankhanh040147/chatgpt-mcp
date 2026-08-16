# Stitch prompt — Ops Dashboard 0.1 (short)

Paste below the line into Stitch.

---

Localhost **ops console** for chatgpt-mcp dashboard 0.1. Desktop **1440×900**. Read-only. Light industrial (bg `#F3F1EC`, panel `#FBFAF7`, text `#172126`, teal `#087F78`, fonts Sora + IBM Plex Mono).

**Never:** sidebar/top nav, avatar/admin, action buttons (New/Retry/Recover/View All/Refresh), Redis/CPU/AWS/systemctl/docker, footer Docs/Logs/Support.

**Always:** workers `w1|w2|w3`, task ids `ho_…`, same layout on every screen, footer only `Polling every 2s · 127.0.0.1 only · read-only 0.1`.

## Layout (all screens)

1. Header: eyebrow `chatgpt-mcp · dashboard 0.1` + title **Ops** | pill API OK/DOWN | Updated | clock ICT  
2. Control plane strip (not KPI cards): Health · Lease reaper · Last tick · Requeued · Timed out · Failed  
3. Workers: 3 equal cards — id, status pill, healthy?, PID, Heartbeat, Current task, Error  
4. Split 8/4: **Recent tasks** table `Task ID|Status|Owner|Type|Age|Error` + **Troubleshoot** (2–3 hints + dark commands with copy):
   ```
   curl -s http://127.0.0.1:8787/health | jq
   make doctor
   npm run recover
   ./scripts/start-broker-stack.sh
   ```
5. Footer one line

## 5 screens = same skeleton, different data

1. **Healthy** — API OK; w1/w3 READY; w2 BUSY + task `ho_01M047SACSTCR99M6RH3J83YX2`; tasks PROCESSING + WAITING_APPROVAL + COMPLETED  
2. **Degraded** — w2 ERROR, PID dead, `WORKER_PID_DEAD`; FAILED task on w2; hint run doctor  
3. **Session lost** — w3 SESSION_LOST, PID alive, `CHAT_SESSION_LOST`; process up / session down  
4. **API down** — pill API DOWN + last seen; replace plane/workers/tasks with “Status API is unreachable” for `127.0.0.1:8787`; keep Troubleshoot commands; no Retry  
5. **Empty** — no workers / no tasks copy; keep Troubleshoot; no Create worker

Design **Healthy first**, then duplicate for the other four. Output exactly these 5 screens, ready to implement.
