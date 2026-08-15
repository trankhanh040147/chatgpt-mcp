---
name: chatgpt-mcp
description: >-
  Create ChatGPT handoffs via MCP (handoff_create_task / handoff_get_result).
  Use when the user types /chatgpt-mcp, asks to hand off to ChatGPT, runs a
  ChatGPT worker task, or needs web research, architecture review, independent
  code review, second opinion, or debug after failed attempts.
---

# chatgpt-mcp (Cursor ↔ ChatGPT MCP)

## Before invoke

1. Env (vault): `/Users/vulcanlabs/src/gh/obsidian-vault/vault-mac-1/configs/chatgpt-mcp-env.md`
2. Architecture: `/Users/vulcanlabs/src/gh/chatgpt-mcp/docs/architecture.md`
3. Worker: `curl -s http://127.0.0.1:8787/health` → `{"ok":true}` (else start CDP Chrome + `npm run worker`)
4. Chrome CDP profile with ChatGPT Pro (not Default)

## Invoke (every Cursor workspace)

1. Call MCP `handoff_create_task` on server `chatgpt-mcp` / `user-chatgpt-mcp` with `type` + `prompt` (optional `context`).
2. Do **not** write SQLite yourself.
3. **End the turn immediately** after create succeeds.
   - Do **not** poll `handoff_get_task_status`.
   - Stop hook (`~/.cursor/hooks/chatgpt-mcp-wait.sh` and/or project hook) resumes with followup.
4. On resume: `handoff_get_result` only → evaluate critically → continue. Never poll after resume.
5. Exception: response `scoped: false` outside Cursor → poll by `taskId`.

## When / when not

**Use for:** architecture review, code review, live research, second opinion, hard debug.

**Skip for:** trivial coding, formatting, facts already in context.
