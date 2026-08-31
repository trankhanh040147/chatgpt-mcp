---
name: chatgpt-mcp-browser-debugger
description: >-
  Debug ChatGPT worker browser automation (CDP :9222) using Chrome DevTools MCP
  plus repo Playwright scripts. Use when create-chat attach fails, + menu freezes,
  Cursor selector wrong, New chat stuck, or user asks to live-debug ChatGPT UI
  before changing create-chat.ts. Invoke with /chatgpt-mcp-browser-debugger.
---

# chatgpt-mcp-browser-debugger

Development/debug plane for **chatgpt-mcp** worker browser automation. Production remains `browser-worker` → Playwright `connectOverCDP` → Chrome `:9222`. MCP does **not** replace production.

## Prerequisites

1. Env: `/Users/vulcanlabs/src/gh/obsidian-vault/vault-mac-1/configs/chatgpt-mcp-env.md`
2. CDP Chrome logged in (profile `$HOME/chrome-chatgpt-debug`, **not** Default Chrome)
3. Stack up: `npm run build && node dist/gptmcp.js restart` (or `./scripts/start-broker-stack.sh`)
4. **Chrome DevTools MCP** in `.cursor/mcp.json` → `chrome-devtools` with `--browser-url=http://127.0.0.1:9222`
5. Reload MCP in Cursor after config change

Verify:

```fish
curl -s http://127.0.0.1:9222/json/version | head -1
curl -s http://127.0.0.1:8787/health
```

## Two layers (do not collapse)

| Layer | Tool | Role |
|-------|------|------|
| Exploration | **Chrome DevTools MCP** (`take_snapshot`, `take_screenshot`, `click`, `evaluate_script`) | See real DOM/a11y, disambiguate nodes, prove interaction |
| Regression | **Repo scripts** (`diagnose-plus-menu`, `e2e-create-chat`) | Deterministic exit code, JSON artifacts, CI-adjacent repeatability |

MCP finds the truth. Scripts encode the truth.

## Autonomous debug loop

```
START
  gptmcp status / doctor
       │
  verify :9222 and :18788 (broker)
       │
  Chrome DevTools MCP ──► select ChatGPT worker tab (Chat surface)
       │
  snapshot BEFORE action
       │
  ONE action (e.g. click composer-plus-btn)
       │
  snapshot + screenshot AFTER
       │
  Expected UI state?
    YES ──► encode locator in create-chat.ts
    NO  ──► inspect a11y tree, bbox, console; do NOT patch selector from screenshot alone
       │
  npm run build
       │
  node dist/gptmcp.js restart
       │
  npm run e2e:create-chat  (or dashboard New chat)
       │
  LIVE RETEST ──► loop until pass
```

## Chrome DevTools MCP workflow (composer + → Cursor)

**Do not modify code until steps 1–9 succeed via MCP.**

1. Attach to existing Chrome: `--browser-url=http://127.0.0.1:9222`
2. List pages / select active **ChatGPT** tab (`chatgpt.com`, Chat not Work if possible)
3. `take_snapshot` — record UIDs
4. Find `composer-plus-btn` (or equivalent in a11y tree)
5. Click `+`
6. `take_snapshot` + `take_screenshot` — menu open
7. Find **every** visible node containing text `Cursor`
8. For each: note UID, parent chain, position — separate **sidebar Plugins** vs **composer + menu**
9. Click the **composer-menu** Cursor (anchor discovery to `composer-plus-btn` / composer bbox, not global `getByText`)
10. `take_snapshot` — verify Cursor **chip on composer** (not sidebar link)
11. Only then edit `src/browser/create-chat.ts` to match proven interaction
12. Run `npm run diagnose:plus-menu` and `npm run e2e:create-chat` to regression-lock

### Example agent prompt (copy)

```text
Use Chrome DevTools MCP connected to http://127.0.0.1:9222.
Do not modify code yet.

1. Locate the active ChatGPT Chat page.
2. Take an accessibility snapshot.
3. Locate composer-plus-btn.
4. Click it.
5. Take another snapshot and screenshot.
6. Find every visible node containing "Cursor".
7. Determine which belongs to the opened composer menu vs sidebar
   (ancestry, a11y, position).
8. Click the composer-menu Cursor.
9. Verify the Cursor connector chip appears on the composer.
10. Only after proving the interaction via DevTools MCP,
    update create-chat.ts with equivalent Playwright locators.
11. build → restart → e2e:create-chat → dashboard New chat until pass.
```

## Hard rules

- **NEVER** assume ChatGPT DOM structure (no radix popper, no `role=menu` on current UI — verify live).
- **NEVER** introduce a selector before proving it on the **currently running** ChatGPT UI.
- **NEVER** use global `getByText("Cursor")` — sidebar Plugins also has Cursor.
- **NEVER** modify production selectors from screenshot alone — snapshot + bbox + click proof required.
- Always: **snapshot → interact → snapshot → verify**.
- For composer plugins: anchor discovery to `composer-plus-btn` and composer bounding box (`x` typically > 280px from left edge on desktop).
- After successful discovery: encode in `scripts/diagnose-plus-menu.ts` and `scripts/e2e-create-chat.ts`.
- **Do not** auto-approve MCP permissions in ChatGPT.
- **Do not** close failed worker tabs — broker leaves them open for diagnosis.

## Repo scripts

```fish
cd /Users/vulcanlabs/src/gh/chatgpt-mcp
npm run diagnose:plus-menu   # JSON → logs/plus-menu-dom.json, screenshot
npm run e2e:create-chat      # new chat + handoff; exit 0 = COMPLETED
```

Artifacts: `logs/plus-menu-dom.json`, `logs/diagnose-plus-menu.png`

## Production vs debug separation

```
DEVELOPMENT                    PRODUCTION
Cursor Agent                   browser-worker
  ├─ terminal / repo              └─ Playwright connectOverCDP
  ├─ Chrome DevTools MCP              └─ Chrome :9222
  └─ this Skill
```

## Playwright MCP (P1, optional)

If DevTools MCP is insufficient for long flows, add `@playwright/mcp` with `--cdp-endpoint=http://127.0.0.1:9222`. CDP fidelity is lower than native Playwright; prefer encoding discoveries into repo Playwright code.

## Do not use for P0

- **cursor-ide-browser** — wrong Chrome/profile risk vs dedicated CDP Chrome
- Chrome DevTools MCP as production executor — debug only

## Related files

- `src/browser/create-chat.ts` — attachCursorPlugin, bootstrap
- `src/browser/broker.ts` — tab lifecycle, uiWriteMutex
- `scripts/diagnose-plus-menu.ts` — deterministic DOM probe
- `scripts/e2e-create-chat.ts` — E2E gate
- `docs/testing-create-chat-browser.md` — operator commands
