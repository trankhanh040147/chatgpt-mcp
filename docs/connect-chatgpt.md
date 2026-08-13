# Connect ChatGPT → chatgpt-mcp (remote MCP)

chatgpt-mcp exposes ChatGPT tools on **loopback** `http://127.0.0.1:8790/mcp` (`npm run remote-mcp`). ChatGPT Cloud cannot reach localhost directly — you need a private bridge.

## Recommended: OpenAI Secure MCP Tunnel

Use [Secure MCP Tunnels](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels) so ChatGPT reaches your local MCP **without** opening a public URL.

1. Enable **Developer Mode** in ChatGPT (web).
2. Start local remote MCP: `npm run remote-mcp`
3. Follow OpenAI’s tunnel-client docs to attach to `127.0.0.1:8790` path `/mcp`
4. In the worker chat, approve write tools (`handoff_get_task`, `handoff_submit_result`)

This is the default path for **private / real code** handoffs.

## Fallback: public HTTPS tunnel (evaluation only)

Tools such as ngrok can expose `:8790`, but:

- Prefer **no-auth** only for non-sensitive demos (ChatGPT connector UIs often support OAuth / No Auth / Mixed — not a custom “paste bearer” field).
- If you enable `HANDOFF_REMOTE_MCP_TOKEN`, generic MCP clients can send `Authorization: Bearer …`; do **not** assume ChatGPT’s UI can configure that header.
- Never tunnel `:8787` (status/worker diagnostics). The remote MCP process listens only on `:8790` and only serves `/mcp`.
- Do not put tokens in the URL query string.
- Prefer a tunnel/proxy that path-restricts to `/mcp` only.

## Worker chat

After the connector works:

1. Open a dedicated ChatGPT conversation in the **CDP Chrome** profile
2. Set `CHATGPT_WORKER_URL` to that chat URL
3. Paste worker instructions from [spec.md §17](spec.md)
4. `npm run worker` types only `TASK_ID=ho_…` into that chat
