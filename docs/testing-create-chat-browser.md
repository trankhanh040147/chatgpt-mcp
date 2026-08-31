# Testing create-chat browser automation

Live ChatGPT UI changes frequently. Do not fix `create-chat.ts` selectors without proving them on the running CDP Chrome session.

## Stack

| Port | Service |
|------|---------|
| 9222 | CDP Chrome (`$HOME/chrome-chatgpt-debug`) |
| 18788 | browser-broker ops |
| 8787 | status-api health |

```fish
cd /Users/vulcanlabs/src/gh/chatgpt-mcp
npm run build
node dist/gptmcp.js restart
curl -s http://127.0.0.1:8787/health
```

Env: vault `configs/chatgpt-mcp-env.md`.

## Layer 1 — Chrome DevTools MCP (exploration)

Project MCP: `.cursor/mcp.json` → `chrome-devtools` with `--browser-url=http://127.0.0.1:9222`.

Reload MCP in Cursor after edits.

Skill: `/chatgpt-mcp-browser-debugger` (`.cursor/skills/chatgpt-mcp-browser-debugger/SKILL.md`).

Workflow: snapshot → click + → snapshot → disambiguate Cursor nodes → click menu Cursor → verify chip → then edit code.

## Layer 2 — Repo scripts (regression)

```fish
npm run diagnose:plus-menu
# writes logs/plus-menu-dom.json + logs/diagnose-plus-menu.png

npm run e2e:create-chat
# full: new chat → bind worker → handoff canary → COMPLETED
# browser only: npm run e2e:create-chat -- --skip-handoff
```

`npm run test:worker-ops` mocks the broker — it does **not** validate ChatGPT DOM.

## Connector setup

- Plugin name in ChatGPT: **Cursor** (not `cursor-handoff`)
- Surface: **Chat** (not Work)
- Remote MCP via ngrok → `remote-mcp` :8790
- Operator must **Always allow** write tools manually

## Known UI facts (2026-08-31 probe)

On current ChatGPT web, composer `+` menu may **not** use:

- `data-radix-popper-content-wrapper`
- `role=menu` / `role=dialog`

`Cursor` appears as `<span>` text; sidebar Plugins also contains `Cursor`. Use composer bbox anchoring, not global text search.
