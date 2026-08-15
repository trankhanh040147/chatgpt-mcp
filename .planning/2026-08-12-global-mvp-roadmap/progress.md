# Progress — MVP release implementation

## 2026-08-13

### Implemented
- Cross-platform CDP launcher `scripts/start-chrome-cdp.mjs` (+ `.sh` wrapper)
- Legacy profile auto-prefer `~/chrome-chatgpt-debug`; CDP ready poll
- MCP tool annotations, bounds, server instructions; shared `registerHandoffTools`
- Conditional `saveResultIfOpen` + idempotent/conflict `submitResult`
- SDK pin `1.30.0`; package `0.1.0-preview.1`
- `docs/connect-chatgpt.md` Secure Tunnel first; README platform badges + migration
- `npm run check` platform/sdk/desktop

### Self-review
- Handoff `ho_01KZW6HQG7JQT6KZ0YQMW35PS4` → ship-with-fixes → applied

### README SOTA rewrite
- Handoff `ho_01KZW701SBZRV104CGM1773D6V` → rewrite recommended
- Applied: outcome-first README, Mermaid, security/troubleshooting, SECURITY.md + CONTRIBUTING.md
- Demo GIF pending (`docs/assets/README.md` checklist)

### Easy path + evidence scaffolding
- `npm run start` → CDP + remote-mcp + worker supervisor (`scripts/start.ts`)
- `docs/onboarding-timing.md` — protocol; 1 warm maintainer row; 2 stranger slots open
- `docs/benchmark/` bench-v1 frozen (T1–T5, rubric, results template)
- README links suite; scores explicitly pending

### Stop-hook latency
- `GET /tasks/:id/wait` long-poll (`HANDOFF_WAIT_TICK_MS=250`); disable HTTP request timeouts
- `wait-handoff.py` uses wait route (fallback local poll)
- Skill/rule: end turn after create when stop hook present; `agentHint` on create_task
- Worker restarted on :8787 with new build

### Still deferred / next
- Commit/push local preview batch (README/start/long-poll/SECURITY…)
- Record README demo GIF
- 2+ independent cold onboarding timings
- Execute bench-v1 20 runs + blind score → then README table
- Ubuntu live E2E; ≥18/20 transport gate; OAuth / SDK v2; Windows
- Future ladder: `.planning/2026-08-13-future-versions.md` (portable core → Claude → static multi-worker → assisted provisioning)
