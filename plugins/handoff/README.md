# Handoff plugin (Desktop Chat experiment #1 — `.app.json` only)

Thin **plugin** that references an **existing ChatGPT Custom App** (Developer Mode) via `.app.json`. The App already points at your HTTPS MCP; the plugin does not create MCP or permissions.

**Experiment #1:** `apps` only — no `mcpServers` / `.mcp.json` in the manifest (avoids Desktop-only bundled MCP path and confounds the test).

Kill if Work/Codex meter moves, or Desktop Chat cannot call `handoff_submit_result`.

## Mental model

```text
Cursor → SQLite → (dispatch) → Desktop ChatGPT → Chat → plugin Handoff
                                                      ↓
                                               .app.json
                                                      ↓
                                    existing Custom App (web-created)
                                                      ↓
                                    HTTPS / Secure MCP Tunnel → :8790/mcp
                                                      ↓
                              handoff_get_task → handoff_submit_result
```

Not: `Chat → ~/.codex mcp_servers.handoff` (Codex host).  
Not: `Chat → plugin → .mcp.json → MCP` (experiment #2 only).  
Not: Plugin Creator as prerequisite (optional packaging).

## Placeholder

| File | Field | Source |
|------|--------|--------|
| `.app.json` | `apps.handoff.id` | Web ChatGPT → Plugins → your handoff app → URL id `plugin_asdk_app…` / `asdk_app…` |

MCP URL and tunnel stay on the **web App** you already use for CDP worker. Do not commit tokens.

## Experiment #1 checklist

1. **Web:** Developer mode ON. App exists with `handoff_get_task` + `handoff_submit_result`. Scan tools if needed.
2. Copy **App ID** from app URL into `.app.json`.
3. Record **agentic / Work-Codex meter** (e.g. weekly % UI).
4. Install plugin: `codex plugin marketplace add /path/to/chatgpt-mcp` → restart app → install **Handoff** from **chatgpt-mcp-local**.
5. Desktop → **ChatGPT → Chat** + **Instant**. New chat.
6. Invoke: `@handoff` and/or `+` → **Handoff** (not Codex MCP row, not Work).
7. Disposable `TASK_ID=ho_…` (QUEUED; workers not READY so CDP won't steal).
8. Prompt:

```text
Use handoff to get the pending task TASK_ID=ho_….
Complete it and submit through handoff_submit_result. Do not answer from memory.
```

9. Approve write if asked (once per conversation is OK).
10. **PASS:** SQLite `COMPLETED` + agentic meter unchanged.  
    **FAIL:** no app/tools, read-only, meter up, or must switch to Work.

## Decision tree

| Outcome | Conclusion |
|---------|------------|
| `submit_result` + meter OK | Desktop Chat worker viable (may still keep CDP until dispatch solved) |
| Read works, write blocked | App permission or plan (Business/Edu full MCP write) |
| Plugin visible, no tools | `.app.json` id or workspace app access |
| Web works, Desktop never | Desktop parity blocker — keep W |
| Meter increases | Kill — wrong quota pool |

## Experiment #2 (later, optional)

Re-add `"mcpServers": "./.mcp.json"` to test bundled HTTP MCP (may be Desktop-only). Separate meter test. Do not run together with #1.

## Out of scope

- `~/.codex/config.toml` stdio handoff (Codex host)
- Computer Use, full CDP, Excel, Work, Codex view
- Skill-only (no App reference)
- Plugin Creator required (use marketplace install when manifest is ready)
