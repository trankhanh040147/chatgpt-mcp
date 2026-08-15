# Security Policy

## Supported versions

This project is a **developer preview**. Only the latest published preview on `main` receives fixes.

## Trust boundary

chatgpt-mcp runs a local Node worker, attaches to a dedicated Chrome profile via CDP, and may expose an MCP HTTP endpoint for ChatGPT (Secure Tunnel preferred; public tunnels are evaluation-only).

- Tasks and results are stored in local SQLite under `$CHATGPT_MCP_HOME`
- Do **not** expose the status API (`:8787`) through a public tunnel
- Do **not** hand off secrets, credentials, or regulated data unless you accept browser + tunnel risk
- Prefer OpenAI Secure MCP Tunnel for private workloads

## Reporting a vulnerability

Please open a [private security advisory](https://github.com/trankhanh040147/chatgpt-mcp/security/advisories/new) if available, or email the maintainer via the GitHub profile contact for `trankhanh040147`.

Do not file public issues with exploit details, tokens, or private task contents.
