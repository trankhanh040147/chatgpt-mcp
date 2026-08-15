# Progress — portable core 0.2

## Session 2026-08-13 (pm)

### Fix: `/chatgpt-mcp` / other-workspace handoff
- Root cause: hook matcher `MCP:handoff_create_task` did **not** match Cursor’s `MCP:chatgpt-mcp:handoff_create_task` / `MCP:user-chatgpt-mcp:…` → inject skipped
- Fix: matcher → `handoff_create_task`; inject both `clientSessionId` + `cursorConversationId`
- Skill refreshed; alias `/chatgpt-handoff`; project copy under `.cursor/skills/chatgpt-mcp/`
- Killed stale stdio MCP processes; rebuild dist
- Smoke create `ho_01KZX3XQN9ZXRY313NW50FJDSJ` → COMPLETED `SMOKE_OK`
