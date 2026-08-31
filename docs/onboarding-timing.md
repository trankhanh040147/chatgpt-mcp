# Fresh-user onboarding timing

**Goal:** A new developer reaches `gptmcp status` exit 0 and one successful handoff in **≤15 minutes** after prerequisites (Node **22.14+**, Chrome, ChatGPT plan with Developer Mode).

## Protocol (freeze)

1. Use a **clean** machine or a throwaway `CHATGPT_MCP_HOME` (do not reuse the maintainer DB).
2. Start timer at `git clone` (or unzip) complete.
3. Follow README Quick Start only — no maintainer vault notes.
4. Stop timer when:
   - **T_check:** `gptmcp status` exits **0**, **and**
   - **T_handoff:** first `handoff_get_result` returns a non-empty result (optional second mark).
5. Record wall-clock minutes, OS, Node version, blockers, and whether Secure Tunnel or public tunnel was used.
6. Do **not** count prior ChatGPT login time if the tester already had an account; **do** count first-time Developer Mode + MCP connector + write approval.

## Prerequisites (not on the clock)

- Node.js ≥**22.14**, git, Google Chrome (broker stack is Node-only)
- ChatGPT account with Developer Mode / MCP write available
- Network able to reach chatgpt.com

## Result log

| # | Tester | Date | OS | Node | T_check (min) | T_handoff (min) | Tunnel | Pass ≤15? | Notes |
|---|--------|------|-----|------|---------------|-----------------|--------|-----------|-------|
| 1 | maintainer-warm | 2026-08-13 | macOS | v26.5.0 | ~0.01 (0.74s) | — | existing stack | yes* | Warm setup only; **Not** a stranger cold start. |
| 2 | _open_ | | | | | | | | Need independent tester |
| 3 | _open_ | | | | | | | | Need independent tester |

\*Do not publish “≤15 min” as proven until rows 2–3 (or three independent cold starts) are filled. Connector / Developer Mode time dominates strangers.

Fill rows after each run. Publish a median only after **≥3** independent testers; until then README must not claim a fixed “10 minutes”.

## Maintainer dry-run recipe

```bash
export CHATGPT_MCP_HOME=/tmp/chatgpt-mcp-timing-$$
git clone https://github.com/trankhanh040147/chatgpt-mcp.git /tmp/chatgpt-mcp-src-$$
cd /tmp/chatgpt-mcp-src-$$
# start timer
./scripts/install.sh --yes --home "$CHATGPT_MCP_HOME"
# paste MCP JSON; connect ChatGPT — docs/connect-chatgpt.md
gptmcp start
gptmcp open   # Assign URL / New chat
gptmcp status # stop timer at T_check when exit 0
```
