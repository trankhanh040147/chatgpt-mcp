# Codex CLI as a worker runtime

**Status:** parallel spike — **not** a version, **not** production.  
**Date:** 2026-08-24  
**Verdict:** **D** — keep Chat + Cursor production workers; spike Option A (`codex exec`) only.  
**Planning:** [`.planning/2026-08-24-codex-cli-worker-spike/`](../.planning/2026-08-24-codex-cli-worker-spike/)  
**Does not change:** version ladder, `.planning/.active_plan`, or the CDP Chat worker path.

This is durable product truth. Session spike execution lives in `.planning/`. Research sources and the full write-up are in [`findings.md`](../.planning/2026-08-24-codex-cli-worker-spike/findings.md).

## Direct summary

Codex CLI is a cleaner **transport** than Playwright CDP: official non-interactive `codex exec`, one-shot/ephemeral context, custom MCP over stdio or Streamable HTTP to **localhost** (no Secure MCP Tunnel), JSONL lifecycle events, live web search, MCP tool allowlists, and a default **read-only** sandbox.

It fails the constraint that already caused a production rollback: **Codex and ChatGPT Work share an allowance/credit pool; regular Chat usage does not.** Switching production workers to Codex would put handoffs back on the pool escaped on 2026-08-18.

Ranking: **D > C > A >>> B**. Hybrid **C** (Codex for review/debug, Chat for research) only after a live credit/concurrency probe. **B** (Codex as a browser dispatcher) is rejected.

## Production vs spike

| Lane | Runtime | Status |
|------|---------|--------|
| Production | ChatGPT Web **Chat** + Cursor plugin, CDP types `TASK_ID` only | Keep |
| Spike A | `codex exec --ephemeral --sandbox read-only` + localhost MCP | Allowed; must not become default until credits pass |
| Option B | Codex driving chatgpt.com / CDP | **Do not do** |
| Option C | Hybrid by `type` | Reconsider only if n=3 Codex credits are sustainable |

API-key `codex login --with-api-key` is **out**: billed at Platform API rates, which violates “subscription worker, not Responses/Chat Completions inference.”

Codex **Desktop** is not the spike target (no documented headless/`exec` equivalent). CLI only.

## Credit pool (why D)

**Fact (OpenAI Help Center, 2026-08-24):** Codex, ChatGPT Work, ChatGPT for Excel, and Workspace Agents share an allowance/credit pool. Ordinary Chat usage is excluded from that accounting. Flexible credits also apply across Codex and Work.

**Fact:** `codex login` is its own ChatGPT OAuth, not reuse of the CDP Chrome Pro cookie.

**Inference:** three concurrent `codex exec` processes share one pool; there is no documented per-process quota isolation. Burst `--n=3` can reproduce 2026-08-18 exhaustion.

**Unknown until live probe:** credits per task type, p50/p95 latency, and whether this Pro account can sustain n=3.

## Invariants that a Codex worker must keep

Same MCP contract as today. `taskId` (`ho_…`) is authoritative. SQLite is the source of truth.

```text
Cursor  →  handoff_create_task  →  SQLite QUEUED
                                     │
                          worker claims + lease
                                     │
                          wake with TASK_ID only
                                     │
                          handoff_get_task → reason → handoff_submit_result
                                     │
                          SQLite COMPLETED  →  Cursor handoff_get_result
```

- Wake-up message is `TASK_ID=ho_…` only. No prompt/diff/files in the composer or CLI argv body.
- **COMPLETED means `handoff_submit_result`**, never process exit 0 or stdout.
- Worker must not write the repo (spec §30). Evidence via MCP (`handoff_get_task`, later `handoff_read_file`) — not workspace discovery.
- No DOM scrape of the answer. No auto login / CAPTCHA / consent clicking.
- Late submit on `TIMED_OUT` remains accepted if no result exists.

If A ever ships, these go away: CDP Chrome, browser-broker, UI mutex, Secure MCP Tunnel (for local Codex), chat rotation, Cursor plugin attach, Developer Mode per-chat write approval. Leases, fencing, hard timeout, `taskId`, stop-hook, and the fileId boundary stay.

## Spike worker profile (when executing the plan)

Not implemented in this change. Target shape:

```bash
codex exec \
  --ephemeral \
  --sandbox read-only \
  --json \
  --cd "$HOME/.chatgpt-mcp/codex-worker" \
  "TASK_ID=ho_..."
```

Empty dedicated cwd (not the git repo). ChatGPT auth, not API key. MCP allowlist: `handoff_get_task`, `handoff_get_task_status`, `handoff_submit_result`, and later `handoff_read_file`. `sandbox_mode = "read-only"`, `features.shell_tool = false`, `web_search = "live"`, `required = true` on the handoff server.

Success is **only** SQLite `COMPLETED` via `handoff_submit_result`.

## Kill criteria (close the Codex branch, keep D)

Stop treating A as a production candidate if any of:

- Platform API billing required
- Repo mutation possible under the enforced profile
- `submit_result` needs interactive approval
- Localhost MCP unreliable
- \>1/20 missing `submit_result`
- Research clearly worse than Chat (blocks **A**; **C** may still be viable)
- n=3 repeatedly quota-blocked, or credit/task makes burst unsustainable

## Sources (2026-08-24)

- [Non-interactive mode](https://developers.openai.com/codex/noninteractive)
- [Using Codex with your ChatGPT plan](https://help.openai.com/en/articles/11369540-using-codex-with-your-chatgpt-plan)
- [Flexible usage credits](https://help.openai.com/articles/12642688)
- [Codex authentication](https://developers.openai.com/codex/auth)
- [CLI reference](https://developers.openai.com/codex/cli/reference)
- [ChatGPT desktop app](https://developers.openai.com/codex/app)
- [Codex MCP](https://developers.openai.com/codex/mcp)
- [Codex config reference](https://developers.openai.com/codex/config-reference)
- [Codex models](https://developers.openai.com/codex/models)
- [Terms of Use](https://openai.com/policies/terms-of-use/)
