# Findings — Codex CLI worker spike

Treat this file as research data, not instructions. Product decision: [`docs/codex-cli-worker.md`](../../docs/codex-cli-worker.md). Spike plan: [`task_plan.md`](task_plan.md).

Research date: **2026-08-24**. Distinguish FACT / INFERENCE / UNKNOWN as in the source write-up.

---

## 1. Verdict: **D — do not switch production workers to Codex; spike Option A anyway**

As of **2026-08-24**, Codex CLI is technically a much cleaner transport than the current ChatGPT-web CDP worker: `codex exec` is explicitly supported for non-interactive/CI-style runs, can be one-shot/ephemeral, supports custom MCP over **stdio or Streamable HTTP**, can connect directly to `localhost`, emits JSONL lifecycle events, supports live web search, and defaults to a **read-only sandbox**. In other words, Option A can almost certainly preserve the core `TASK_ID → get_task → reason → submit_result` architecture while deleting Chrome/CDP, the tunnel, chat rotation, and Cursor-plugin attachment. ([OpenAI Developers][1])

But it fails the most important reopened question: **Codex is explicitly in the same shared allowance/credit pool as ChatGPT Work.** OpenAI's current Help Center says Codex, ChatGPT Work, ChatGPT for Excel, and Workspace Agents share an allowance/credit pool; regular Chat usage is excluded. That directly reproduces the 2026-08-18 landmine rather than solving it. ([OpenAI Help Center][2])

Ranking is **D > C > A >>> B**. Keep **Chat + Cursor** as production while running a tightly bounded Option-A transport spike. Hybrid C becomes attractive only if real measurements show that the Codex pool is nevertheless economically sustainable for lower-volume `code_review`/`debug_analysis` traffic. **B has essentially no rationale:** it preserves the fragile ChatGPT UI while introducing another agentic runtime to operate it.

---

## 2. Credit-pool finding

This one is unusually conclusive.

### FACT — Codex CLI/Desktop uses the Codex/Work shared allowance when authenticated through ChatGPT

OpenAI says Codex is included across ChatGPT plans and can be used by signing the Codex client into the user's ChatGPT account. Usage limits vary by plan. ([OpenAI Help Center][2])

More importantly, the current Help Center explicitly states:

> “Codex, ChatGPT Work, ChatGPT for Excel, and Workspace Agents use a shared allowance and credit pool…”

It further says ordinary Chat usage is **not included** in the Work/Codex credit accounting displayed by ChatGPT Desktop. ([OpenAI Help Center][2])

Purchased flexible credits likewise work across supported features including **Codex and ChatGPT Work**. ([OpenAI Help Center][3])

**Therefore: FACT:** moving the Chat worker to Codex CLI does **not** preserve the quota isolation obtained by moving Work → Chat on August 18. It moves the worker straight back onto the pool that was deliberately escaped.

### FACT — ChatGPT auth and API-key auth are distinct billing paths

`codex login` uses a browser-based ChatGPT sign-in. Codex does **not** simply reuse the existing Chrome Pro cookie; it conducts its own authentication flow and stores credentials for the CLI. ([OpenAI Developers][4])

Alternatively:

```bash
printenv OPENAI_API_KEY | codex login --with-api-key
```

but OpenAI explicitly says that path is billed at normal API rates rather than consuming included ChatGPT-plan credits. ([OpenAI Developers][4])

That API-key mode violates the primary-worker constraint, so it is excluded from the production comparison.

### INFERENCE — `--n=3` is exposed to exactly the problem already observed

No current OpenAI guarantee reserves three independent Codex worker slots or gives each CLI process an isolated quota.

Given that concurrent Codex tasks consume the same shared pool, three processes can drain the common allowance faster. The flexible-credit documentation even discusses a task beginning with positive balance and completing after **concurrent usage** has depleted it, potentially creating a negative balance. ([OpenAI Help Center][3])

So: **≥3 Codex processes are technically feasible, but quota isolation is not.**

### UNKNOWN

No documented conversion of the form “a Pro subscriber gets X concurrent Sol workers or Y `codex exec` tasks/day.” Usage depends on model, complexity, context, reasoning, speed, tools, and execution location. OpenAI directs users to the live Usage Dashboard and `/status` for actual allowance state. ([OpenAI Help Center][2])

Burst capacity needs measurement.

---

## 3. Feasibility answers

### 1. Headless/non-interactive CLI: **YES — FACT**

First-class supported mode, not a hack.

OpenAI documents:

```bash
codex exec "TASK_ID=ho_..."
```

`codex exec` runs non-interactively; progress goes to stderr and the final agent message to stdout. ([OpenAI Developers][1])

For machine observability:

```bash
codex exec --json "TASK_ID=ho_..."
```

produces JSONL containing events including `thread.started`, `turn.started`, `item.*`, `turn.completed`, `turn.failed`, `error`. ([OpenAI Developers][1])

And:

```bash
codex exec --ephemeral "TASK_ID=ho_..."
```

avoids persisting rollout/session files. ([OpenAI Developers][1])

The CLI docs explicitly describe `codex exec` as intended for scripted or CI-style work that finishes without human interaction. ([OpenAI Developers][5])

This is substantially better suited to the worker protocol than persistent Chat threads.

### 2. Codex Desktop headless: **UNKNOWN / effectively NO documented equivalent**

Documentation exists for a graphical ChatGPT desktop app, including Codex mode, on macOS, Windows, and Linux. The documented flow is install → open → sign in → select ChatGPT/Codex → send a message. ([OpenAI Developers][6])

No documented “headless Codex Desktop” mode comparable to `codex exec` was found.

**CLI is the candidate. Desktop is not.** Replacing headed Chrome with another visible desktop application gives away much of Option A's operational advantage.

### 3. Custom MCP / localhost: **YES — major win**

**FACT:** Codex CLI and ChatGPT Desktop support custom MCP servers and share MCP configuration. ([OpenAI Developers][7])

Supported local MCP transports include **stdio**:

```toml
[mcp_servers.handoff]
command = "node"
args = ["dist/index.js", "mcp"]
```

And **Streamable HTTP**:

```toml
[mcp_servers.handoff]
url = "http://127.0.0.1:8790/mcp"
```

The docs even give a localhost MCP example `url = "http://localhost:3000/mcp"`. ([OpenAI Developers][7])

For local Codex CLI there is **no ChatGPT-cloud-to-laptop hop**. **Secure MCP Tunnel disappears for Option A.** That is probably the largest operational improvement after eliminating Playwright.

---

## 4. MCP approvals and tool annotations

**FACT:** Codex supports MCP approval modes `auto`, `prompt`, `writes`, `approve`, and per-tool overrides. `writes` specifically prompts for tools not marked read-only. ([OpenAI Developers][7])

A worker can expose only:

```toml
enabled_tools = [
  "handoff_get_task",
  "handoff_get_task_status",
  "handoff_submit_result",
  "handoff_read_file"
]
```

Codex supports MCP `enabled_tools`/`disabled_tools` allow/deny lists. ([OpenAI Developers][8])

**Architectural difference:** there is no need to reproduce ChatGPT Developer Mode's per-chat approval ceremony. For a dedicated worker configuration, Handoff MCP tool policy can be explicit. That is much better for near-zero-touch than re-approving MCP writes after chat rotation.

**INFERENCE:** configure reads automatic; `handoff_submit_result` deliberately allowed; every other Handoff write tool absent from the worker allowlist. Authorization moves from fragile conversation state to durable worker configuration.

---

## 5. Can Codex be prevented from writing the repository?

**Mostly YES, sufficiently for a spike — but harden it.**

**FACT:** `codex exec` defaults to a **read-only sandbox**. OpenAI documents `default: read-only`, `--sandbox workspace-write`, `--sandbox danger-full-access`. ([OpenAI Developers][1]) Configuration supports `sandbox_mode = "read-only"`. ([OpenAI Developers][8]) The shell tool is configurable via `[features] shell_tool = false` (defaults to true). ([OpenAI Developers][8])

Do **not** run Codex from the repository. Empty dedicated directory `~/.chatgpt-mcp/codex-worker/`, then:

```bash
codex exec \
  --ephemeral \
  --sandbox read-only \
  --json \
  --cd ~/.chatgpt-mcp/codex-worker \
  "TASK_ID=ho_..."
```

and disable shell in its dedicated config. The model gets task evidence through MCP, not filesystem discovery.

**Caveat:** complete elimination of all non-MCP local capabilities is a **live-probe requirement** before production. Admin-enforced permission profiles/allowed sandbox modes may make this policy rather than convention. ([OpenAI Developers][8])

---

## 6. Research / web search

**FACT — Codex has real web search.** Config exposes `web_search = "disabled" | "cached" | "indexed" | "live"` with `"cached"` as default and `"live"` providing unrestricted live retrieval. ([OpenAI Developers][8]) CLI also provides `codex --search` for live search. ([OpenAI Developers][5]) Option A is **not** inherently offline.

**UNKNOWN — equivalence to ChatGPT Chat research.** No OpenAI documentation establishes that Codex's research behavior is equivalent for citation quality, current news, maps/local search, login-walled sources, Figma, complex interactive sites, or paywalls.

Do **not** claim research-quality parity from docs alone. For ordinary documentation/web research, Codex looks viable. For `type=research`, Chat remains the baseline until an A/B eval proves otherwise. Strongest argument for **C** if credit economics become acceptable.

---

## 7. Context and one-shot operation

One of Codex's biggest architectural advantages.

**FACT:** `codex exec` creates a non-interactive run. `--ephemeral` avoids persisting session rollout files. Resume is optional rather than required. ([OpenAI Developers][1])

So each `ho_…` is a new Codex run that exits, rather than a persistent Chat that must rotate after `HANDOFF_MAX_TASKS_PER_CHAT`. Context pollution, idle-only chat rotation, new Chat URL creation, reattaching Cursor, and MCP reapproval after rotation all become irrelevant for Option A.

---

## 8. Models

**FACT:** Models can be selected explicitly (`codex -m gpt-5.6-luna`); explicit model overrides take precedence for new threads. ([OpenAI Developers][9]) Current Codex guidance says the default “Power” setting uses **GPT-5.6 Sol with medium reasoning**; other models/settings are available. ([OpenAI Developers][9]) Pinning improves reproducibility but introduces a model-retirement maintenance task (`gpt-5.2` and `gpt-5.3-codex` already marked deprecated for ChatGPT-authenticated Codex).

---

## 9. MCP submit reliability

**FACT:** Nothing in the docs proves Codex MCP submit reliability > ChatGPT Chat MCP submit reliability. Do not score this as established.

**INFERENCE:** fresh invocation + dedicated worker prompt + MCP allowlist + no unrelated chat history + no Chat/Work toggle + no plugin-attachment state should reduce the “please approve sending” failure mode. Only the spike can establish it.

Real metric: `P(submit_result called before process exits)`, not whether Codex's final stdout looks good.

---

## 10. Latency / generation state / observability

Instead of DOM stop-button / composer-idle heuristics, JSONL events include `turn.started`, `item.*`, `turn.completed`, `turn.failed`, `error`. ([OpenAI Developers][1]) Heartbeat can be tied to the Codex process and event stream.

Proposed semantics:

```text
spawn succeeded     → DISPATCHED
turn.started        → PROCESSING
JSONL activity      → heartbeat
submit_result       → COMPLETED
process exit w/o submit
  ├─ timeout        → TIMED_OUT
  └─ other          → FAILED
```

**UNKNOWN:** actual TASK_ID→COMPLETED latency relative to Chat. Measure it.

Preserve the Chat property that SQLite can complete independently of the dispatcher process afterward. A Codex process exiting zero must **not** mean COMPLETED.

---

## 11. Multi-worker / platforms

Option A: N `codex exec` children. No browser broker, no shared composer mutex. Crash recovery is child-process supervision.

**FACT:** Codex's current ecosystem supports local Codex on multiple platforms; ChatGPT/Codex documentation includes macOS, Windows and Linux desktop support, and the CLI documentation includes native Windows sandboxing/WSL-specific behavior. ([OpenAI Developers][6]) Materially better than the current macOS-first headed-Chrome requirement.

**BUT:** concurrency becomes **quota-bound rather than UI-mutex-bound**. Excellent transport improvement coupled to a potentially fatal economic regression.

---

## 12. Desktop versus CLI

| Property | Codex CLI | Codex Desktop |
|----------|-----------|---------------|
| One-shot worker | **FACT: yes** | UNKNOWN |
| Headless | **FACT: `exec`** | No documented equivalent found |
| JSON lifecycle | **FACT: yes** | not documented equivalently |
| localhost MCP | **FACT: yes** | FACT: MCP supported |
| Dedicated visible UI | No | Yes |
| Good fit for broker worker | **Excellent** | Poor |
| Shared Codex credits | **Yes** | **Yes** |

Do not spend spike time on Desktop unless CLI fails something fundamental.

---

## 13. Option B — Codex as dispatcher

**Reject.**

It creates Cursor → Codex → browser → ChatGPT Chat → MCP instead of Cursor → Codex → MCP. Retains ChatGPT UI churn, login state, Chat/Work selection, browser availability, MCP attachment/approval state, while adding another agent and consuming Codex allowance.

Codex Desktop now has browser/CDP functionality, and OpenAI documents explicit approval around full CDP access. ([OpenAI Help Center][2]) Useful for browser debugging — not a reason to replace the tiny deterministic Playwright dispatcher with an LLM-controlled browser dispatcher.

**B is strictly worse for this design.**

---

## 14. ToS

**FACT:** Current consumer Terms of Use prohibit automatically or programmatically extracting data or Output. ([OpenAI][10]) That makes automation around ChatGPT-web output legally/product-policy awkward, even though this architecture **doesn't scrape the assistant DOM**.

OpenAI explicitly documents `codex exec` for scripted/CI-style non-interactive workflows. ([OpenAI Developers][5]) ChatGPT-authenticated Codex is governed by the applicable ChatGPT Terms of Use for individual accounts. ([OpenAI Help Center][2])

**INFERENCE:** Option A is substantially better aligned with intended product behavior because it invokes an official automation interface as documented, rather than automating a consumer web composer. That is **not** a legal safe harbor. The consumer Terms still apply, and the broad programmatic-extraction clause remains.

- Codex CLI automation: **documented product use**
- CDP automation of chatgpt.com: **less clearly intended**
- Formal ToS blessing for this exact subscription-worker architecture: **UNKNOWN**

If this becomes distributed software rather than a personal workflow, obtaining explicit OpenAI clarification would be prudent.

---

## 15. 0.6 file evidence

The task-scoped `handoff_read_file(taskId, fileId, offset?, maxBytes?)` design survives. Codex can invoke custom MCP tools; offset/maxBytes are ordinary schema parameters. ([OpenAI Developers][7])

**Keep the invariant:** Codex gets task-scoped `fileId`; it does not receive arbitrary workspace access. Do **not** replace `handoff_read_file` with “Codex can already read the repo.”

---

## 16. Recommended production architecture: **D now**

No production changes. Alongside Chat+Cursor, a spike lane:

```text
Cursor → same SQLite + MCP → lease →
  codex exec --ephemeral --sandbox read-only --json TASK_ID=ho_…
    → localhost MCP get_task / read_file / submit_result → SQLite → Cursor hook
```

If A eventually passes, CDP Chrome, browser-broker, UI mutex, Secure MCP Tunnel (for local Codex), chat rotation, Cursor plugin, Developer Mode, and per-chat MCP approval can be deleted. SQLite, MCP contract, taskId, stop-hook, claim lease, dispatch fence, hard timeout, and fileId boundary stay.

That is a very attractive architecture — **if the credits work**.

---

## 17. ≤1-day spike

Prove only the unknown things. Do not build a second production worker yet.

### Step 1 — authenticate with subscription

```bash
codex login
codex login status
```

Require ChatGPT auth, **not API-key auth**. ([OpenAI Developers][4]) Kill immediately if it requires Platform billing for the desired model/workflow.

### Step 2 — isolated worker home/workdir

Empty directory unrelated to the repo. Configure Handoff MCP as stdio or:

```toml
[mcp_servers.handoff]
url = "http://127.0.0.1:8790/mcp"
required = true

enabled_tools = [
  "handoff_get_task",
  "handoff_get_task_status",
  "handoff_submit_result",
  "handoff_read_file"
]
```

`required = true` is useful because `codex exec` then fails rather than silently running without the MCP server. ([OpenAI Developers][1])

Also:

```toml
sandbox_mode = "read-only"
web_search = "live"

[features]
shell_tool = false
```

### Step 3 — simplest wakeup

```bash
codex exec \
  --ephemeral \
  --sandbox read-only \
  --json \
  --cd "$HOME/.chatgpt-mcp/codex-worker" \
  "TASK_ID=ho_..."
```

No prompt body, diff, repo, or output parsing as the authoritative result. **Only `handoff_submit_result` counts as success.**

### Test matrix

At least 5 × `second_opinion`, 5 × `code_review`, 5 × `debug_analysis`, 5 × `research`, then 3 simultaneous workers × 5 rounds.

### Success criteria

- 100% exact taskId fetch; 0 enumeration/guessing
- 0 repo writes; 0 shell execution; 0 human approval during task
- 0 final-answer-only-without-submit; 0 duplicate semantic submissions
- 100% COMPLETED or explainable task failure
- localhost MCP works; live research includes usable sources
- 3 simultaneous processes work; JSONL exposes running/completed/failed
- Record p50/p95 TASK_ID → submit_result; credits/task; credits by type; credits n=1 vs n=3

### Kill criteria

Stop evaluating A as a production replacement if: API billing required; repo mutation possible despite enforced profile; submit_result requires interactive approval; MCP localhost unreliable; >1/20 missing submit_result; research clearly worse; n=3 repeatedly quota-blocked; credit/task makes normal burst unsustainable.

---

## 18. Comparison score

Scores: **5 best, 1 worst**. Credits receive extra decision weight.

| Criterion | CDP Chat+Cursor | A Codex worker | B Codex dispatcher | C Hybrid |
|-----------|----------------:|---------------:|-------------------:|---------:|
| Technical feasibility | 4 | **5** | 3 | 5 |
| Credits | **5** | **2** | 1 | 3 |
| Research quality | **5** | 3? | 5 | **5** |
| Coding-review quality | 4 | **5?** | 4 | **5?** |
| ToS/product alignment | 2–3 | **4?** | 2 | 3–4 |
| Multi-worker mechanics | 3 | **5** | 2 | 4 |
| Headless | 1 | **5** | 1 | 3 |
| Consent automation | 2 | **5?** | 1 | 3 |
| Maintenance | 1 | **5** | 1 | 3 |
| Time-to-spike | — | **5** | 2 | 4 |
| Meets known credit constraint | **YES** | **NO** | **NO** | **PARTIAL** |

Question marks mean inference/live validation required. **A wins almost every engineering dimension and loses the one economic dimension that already caused a production rollback.**

---

## 19. Risks that keep D in place

The biggest risk is already a fact: **Codex re-enters the shared Work/Codex credit pool.** ([OpenAI Help Center][2])

Other keep-CDP risks: research regression, subscription concurrency throttling, Codex terminating successfully without `submit_result`, unexpected approval behavior in non-interactive MCP writes, or read-only sandbox still exposing more local repo information than spec §30 permits.

---

## 20. Unknowns worth live-probing

1. Does `handoff_submit_result` run unattended with the exact MCP annotations/config?
2. Does the model reliably fetch the task when the entire prompt is literally `TASK_ID=ho_…`?
3. Can shell truly be absent from the model-visible tool inventory?
4. Can the worker run from an empty directory with no repository visibility?
5. Does `web_search="live"` under **read-only** execution behave as expected?
6. Are Codex research citations good enough compared with the Chat worker?
7. What does one `research`, `code_review`, and `debug_analysis` cost against the actual Pro allowance?
8. What happens to credit consumption and throttling with **three simultaneous `codex exec` processes**?
9. Does quota exhaustion produce a clean JSONL failure that maps safely to `FAILED`/`TIMED_OUT`?
10. Does killing `codex exec` reliably kill the turn, or can server-side work continue?
11. Does MCP submission occur before `turn.completed`, giving a deterministic completion event?
12. Can `handoff_read_file` repeatedly paginate a large file without Codex seeking filesystem alternatives?
13. How does p50/p95 TASK_ID→COMPLETED compare against the existing worker?
14. After days/weeks, does ChatGPT OAuth require interactive reauthentication often enough to become an ops issue?
15. **Does this Pro account's included Codex allowance make n=3 economically viable despite the shared pool?**

---

## Bottom line

Technical reversal of the original spec `NO Codex` line: Codex CLI is almost exactly the worker runtime this architecture would have wanted. The August 18 lesson remains valid: **Codex and Work share the same allowance/credit pool, while regular Chat usage sits outside that accounting.** Do **not** replace Chat+Cursor production workers today.

Highest-value next action is not an A migration; it is a **one-day A spike whose primary experiment is credits/concurrency, not MCP feasibility**. If `n=3` proves sustainable, reconsider **C first**, then A after a research-quality A/B. If the shared pool reproduces August 18 exhaustion, close the Codex branch and keep D.

[1]: https://developers.openai.com/codex/noninteractive
[2]: https://help.openai.com/en/articles/11369540-using-codex-with-your-chatgpt-plan
[3]: https://help.openai.com/articles/12642688
[4]: https://developers.openai.com/codex/auth
[5]: https://developers.openai.com/codex/cli/reference
[6]: https://developers.openai.com/codex/app
[7]: https://developers.openai.com/codex/mcp
[8]: https://developers.openai.com/codex/config-reference
[9]: https://developers.openai.com/codex/models
[10]: https://openai.com/policies/terms-of-use/
