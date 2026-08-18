---
name: chatgpt-mcp
description: >-
  Create ChatGPT handoffs via MCP (handoff_create_task / handoff_get_result).
  Use when the user types /chatgpt-mcp, asks to hand off to ChatGPT, runs a
  ChatGPT worker task, or needs web research, architecture review, independent
  code review, second opinion, or debug after failed attempts.
---

# chatgpt-mcp (Cursor ↔ ChatGPT MCP)

Normative policy: `.cursor/rules/chatgpt-mcp.mdc` (same invariants below).

## Before invoke

1. Env (vault): `/Users/vulcanlabs/src/gh/obsidian-vault/vault-mac-1/configs/chatgpt-mcp-env.md`
2. Architecture: `/Users/vulcanlabs/src/gh/chatgpt-mcp/docs/architecture.md`
3. Worker: `curl -s http://127.0.0.1:8787/health` → `{"ok":true}` (else start CDP Chrome + `npm run worker`)
4. Chrome CDP profile with ChatGPT Pro (not Default)

## Pick depth first (required)

A **decision** is the bounded user/engineering choice being resolved. Related subquestions belong to the same decision; rephrasing does not reset the budget. One decision → at most **one** `handoff_create_task`. State the tier in one sentence before calling MCP.

| Tier | Handoffs | Use when |
|------|----------|----------|
| **Light** | **0** — do locally; Light must not call MCP (`handoff_create_task`) | Answer is already explicit and low-risk in context; trivial fix; ≤3 confident tool calls |
| **Standard** | **at most 1** (optional — only when independent reasoning materially helps; not mandatory) | Bounded independent review/research; single deliverable |
| **Deep** | **at most 1** (optional). Deep changes reasoning depth, not handoff count | Arch fork, prod-critical stakes, or failed attempts |

Production-critical or security decisions stay Standard/Deep even if some facts are already in context.

### Anti-loop

- If the handoff result is insufficient for the **same decision** (substantially same unresolved issue) → continue locally or ask the user. **Do not** immediately create another handoff for the same decision.
- Several subquestions supporting **one** release decision → **one bundled** handoff, not one per subquestion.

Scenarios: `.planning/2026-08-18-roadmap-0.5-agent-ux-rotation/scenarios-agent-ux.md`

## User explicit override

If the user **explicitly requests** a handoff — `/chatgpt-mcp`, "handoff to ChatGPT", "bắt buộc gọi mcp", "gửi qua ChatGPT", or similar — treat as **Standard** (or Deep) regardless of Light classification. The user's intent overrides the agent's tier.

## Invoke (every Cursor workspace)

1. **Light → stop** — Light must not call MCP (`handoff_create_task`), unless user explicitly overrode (see above).
2. Standard/Deep: if a handoff would materially help, call `handoff_create_task` on `chatgpt-mcp` / `user-chatgpt-mcp` with `type` + `prompt` (optional `context`). Skip if local context became sufficient.
3. Do **not** write SQLite yourself.
4. **End the turn immediately** after create succeeds.
   - Do **not** poll `handoff_get_task_status`.
   - Stop hook resumes with followup.
5. On resume: `handoff_get_result` only → evaluate critically → continue. Never poll after resume.
6. Exception: `scoped: false` outside Cursor → poll by `taskId`.

### Soft-refuse (ChatGPT UI)

If the worker chat says *“Submission was blocked… approve sending…”*, that is **model policy**, not the handoff server. Ensure remote-mcp was rebuilt/restarted (MCP `instructions` + `submitPolicy`). Then approve in the worker chat or re-dispatch after §17 policy paste.

## When / when not (quick)

**Standard/Deep (at most 1, optional):** architecture review, code review, live research, second opinion, hard debug after local work.

**Light (skip):** trivial coding, formatting, facts already in context (and remaining work is low-risk).
