# T4 — Research Secure MCP Tunnel vs public tunnel

**Type:** research · **Expect B helpful:** yes

## Fixture

Product docs in-repo: `docs/connect-chatgpt.md`, README security section. Agent may use live web search where available.

## Operator prompt

```text
For a developer connecting ChatGPT to a local chatgpt-mcp remote MCP server,
compare OpenAI Secure MCP Tunnel vs a public no-auth tunnel (e.g. ngrok).
Recommend a default for private code. Mention what port/path must never be exposed.
Keep under one page.
```

## HANDOFF_POINT (Arm B only)

```text
type: research
prompt: Current best practice for exposing a local MCP server to ChatGPT (Secure MCP Tunnel vs public tunnels). Security tradeoffs; what not to expose. Be concrete for a loopback Node MCP on :8790/mcp.
```

Call this handoff **before** finalizing the recommendation (one shot).

## Done when

Clear default recommendation, explicit “don’t tunnel :8787”, and honest limits of public tunnels.
