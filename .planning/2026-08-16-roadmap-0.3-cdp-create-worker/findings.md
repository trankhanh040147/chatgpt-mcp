# Findings — 0.3.0

## From 0.2.0 ops
- Dual E2E needs 2 composers; sharing one Chrome without a dispatcher causes cross-talk.
- Idle Chrome often loses “composer visible” until reload — on-demand CDP must reopen chat reliably.
- Cursor agent shells reap detached Node children; prefer Terminal/`nohup` for long-lived workers.
- Playwright `connectOverCDP` + type seed message can create a `/c/…` chat when already logged in (not a product API).

## Open design questions
1. Prefer **A1 multi-tab** (one process) vs **A2 on-demand** (cold start) for default macOS path?
2. Should create-worker wizard live as `npm run worker:add` CLI, MCP tool, or both?
3. Stretch: reject `handoff_create_task` when zero READY/idle workers — product or skill policy?
