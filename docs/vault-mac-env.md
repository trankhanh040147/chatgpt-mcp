# Maintainer env inventory (optional)

Operator-specific secrets and live URLs belong in a **private** notes store
(e.g. a local Obsidian vault `configs/` note) — not in this repository.

Public install path: `./scripts/install.sh` (or `npm run setup`) → `~/.chatgpt-mcp` + `$CHATGPT_MCP_HOME/data/workers.json` + printed Cursor MCP JSON.

Do not commit `.env`, tokens, or personal absolute paths.
