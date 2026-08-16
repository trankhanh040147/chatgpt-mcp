# Design review #3 — after final Make pass (2026-08-16)

**File:** https://www.figma.com/design/gEbvBwguU9ZO3Oywv8fZGi/ChatGPT-MCP  
**Frames:** Empty `15:1878`, API `15:1977`, Healthy `15:2054`, Degraded `15:2342`, Session lost `15:2593`

## Verdict

**Not ready as a 5-frame SSOT.** Make did **not** clone Healthy into the other states.  
**Healthy alone is good enough to implement** layout + live data; derive Degraded / Session / API-down / Empty in code.

| Frame | SideNav gone? | Clone of Healthy? | Pass? |
|-------|---------------|-------------------|-------|
| Healthy `15:2054` | Yes | — | **Yes for implement** (minor nits) |
| Degraded `15:2342` | Yes | No — new SaaS “Worker Nodes” page | No |
| Session lost `15:2593` | Yes | No — banner + 4 workers + emergency CTAs | No |
| API unreachable `15:1977` | Yes | No — hero card + systemctl fiction | No |
| Empty `15:1878` | Yes | No — KPI cards + wrong commands | No |

All frames still **1280** wide (not 1440×900).

## Healthy — good enough

Keep as engineering source of truth:
- No left sidebar
- Control plane KV present
- w2 BUSY + `ho_…`
- Troubleshoot OK/neutral hints + correct four commands
- ~8 `ho_…` task rows

Nits (fix in code, optional in Figma):
- Footer still has Documentation / Logs / Support → drop
- Task columns should be Task ID · Status · Owner · Type · Age · Error (design has ID/STATUS/WORKER/DURATION)
- Worker cards thinner than earlier (missing explicit PID/heartbeat rows in places) — restore from prior Healthy if possible
- Resize 1440×900 nice-to-have

## Other frames — still inventing (ignore for eng)

- **Degraded:** top nav DASHBOARD/WORKERS/TASKS, + NEW WORKER, RUN DOCTOR, systemctl/kill, syslog viewer
- **Session lost:** RECOVER SESSION, DISPATCH ALL / EMERGENCY STOP, w4, VIEW ALL
- **API down:** `systemctl` / `journalctl` instead of project commands
- **Empty:** Active Workers/Events KPI strip; commands `docker-compose`, wrong health port `:8080`

## Recommendation

**Implement now from Healthy only.** Do not wait for another Make loop unless you want pixel-perfect state variants in Figma first.
