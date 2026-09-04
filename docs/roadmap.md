# Roadmap

> **Version ladder + shipped history** (public mirror).  
> **Active spec + experiments + ADRs:** [`.planning/ROADMAP.md`](../.planning/ROADMAP.md)  
> Dates are not commitments.

## Versioning rule

| Pattern | Meaning |
|---------|---------|
| **`0.N.0`** | Feature / milestone release (preview tags: `0.N.0-preview`) |
| **`0.N.M`** (`M ≥ 1`) | Bug fixes / patches on that line only — **not** new features |

Do **not** use `0.N.x` as a feature bucket. Big capabilities each get their own `0.N.0`.

## Product direction

Local-first Cursor/agent ↔ ChatGPT handoff over MCP: independent review, research, and second opinions without scraping the ChatGPT DOM. Priorities: correctness, consent, reproducible evidence — then **more workers**, assisted provisioning, **ops visibility**, agent UX policy, **native file attachments**, then more hosts.

## Support snapshot

| Surface | Status | Evidence |
|---------|--------|----------|
| Cursor + macOS + Chrome CDP | Supported (developer preview) | Transport canary; E2E in-repo |
| Claude Code / other MCP hosts | Experimental | Manual poll by `taskId` |
| Ubuntu desktop | Experimental | Not Snap/WSL/headless |
| Windows / WSL / headless | Not supported | — |
| Multi-worker | **0.2.0** | Leases + fencing + status-api; dual CDP E2E |
| Single-CDP multi-tab (A1-S) + create-worker CLI | **0.3.0** | Broker + UI mutex; dual/burst canary; `npm run create-worker` |
| Ops dashboard | **0.4.0** | Dashboard **0.1–0.3** + usage at `/dashboard/` on status-api |
| Agent UX + chat rotation | **0.5.0** | Light/Standard/Deep; `HANDOFF_MAX_TASKS_PER_CHAT=20`; idle `rotate-worker` |
| Handoff Resources (dispatch materialize + native attach) | **0.7.0** | **Shipped** — [`.planning/active/0.7-handoff-resources.md`](../.planning/active/0.7-handoff-resources.md); exit debt → 0.7.x |
| Worker Ops & Dashboard | **0.6.0** | **Shipped** |

## Sequencing principles

- Correctness does **not** depend on host stop hooks.
- Server-generated `taskId` is authoritative; session ids are optional.
- Evidence precedes support claims (“works with X”).
- UI automation fails closed; login / consent stay manual.
- One `0.N.0` must meet exit criteria before the next feature version is claimed.
- **Leases / fencing before auto-provisioning** — assisted create (0.3.0) assumes multi-worker ops from 0.2.0.

## Version ladder

| Version | Outcome | P0 scope | Exit criteria | Explicitly deferred |
|---------|---------|----------|---------------|---------------------|
| **0.1.0** | Reproducible Cursor/macOS preview | setup/start/check, scrubbed public source, transport canary, honest limitations | Tagged preview; stranger ≤15 min path documented; no secret paths in repo | Multi-host API, concurrency, agent auto-policy |
| **0.2.0** | Static multi-worker + operability | Two+ configured workers; leases, heartbeats, fencing; stable worker IDs; observability | ≥2 workers, concurrency 1 each; crash recovery; usable ops signals (`make status` / health) | Dynamic pool; auto-create chats; single-CDP multi-tab |
| **0.3.0** | CDP optimize + assisted create-worker | A1-S `browser-broker`; create-worker CLI (New chat → registry → MCP pause → canary); doctor shared-CDP | Tagged; dual/burst E2E on one CDP; operator can add worker without hand-editing only | Unattended cookie/login; elastic cloud pool; auto-scale workers on queue depth |
| **0.4.0** | Ops dashboard | Local dashboard **0.1** (health, workers, tasks, troubleshoot); status-api serve + `GET /tasks` | Dashboard 0.1 usable on localhost; diagnose stuck/idle/SESSION_LOST without log diving; tag when hardened | Cloud hosting; auth SSO; create-worker GUI; metrics history DB |
| **0.5.0** | Agent UX + worker chat rotation | Skill/rule handoff policy (Light/Standard/Deep); **self-regulate context** — rotate worker chat over threshold | Scenario set passes; ≤1 handoff/decision; rotation fail-closed | Host-generic “chooser”; unattended login |
| **0.6.0** | Worker Ops & Dashboard + public CLI | Health poll; assign/create URL; auto-canary; kill/recreate; SESSION_LOST heal (confirm); **`gptmcp` ops surface** | Dashboard ops without sqlite; broker registry SSOT; **`gptmcp status` exit 0** onboarding path | Claude host; transport abstraction |
| **0.7.0** | Handoff Resources (P0) | Dispatch-time materialize; native CDP attach; `handoff_read_file` disabled for file tasks | Merged; formal E2E + CI → 0.7.x | Phase 2 items → 0.8+ |
| **0.8.0** | Handoff Resources Phase 2 | Native writeback/artifacts; large-batch observability E2E; v0.7 E2E gate formalized | Writeback E2E; observability evidence; CI/hook reliability | tar.zst pack → 0.9; MCP URI → 0.10 |
| **0.9.0** | tar.zst pack (native path) | Always-one-chip inbound; hybrid `artifacts[]` XOR `archive` outbound | One `handoff-{taskId}.tar.zst` chip; fail-closed unpack; ADR-011 | MCP URI → 0.10 |
| **0.10.0** | MCP Resource URI transport | `mcp_resource` ingress; explicit transport selection; benchmark vs native | No silent MCP fallback; ADR-003 honored | Audit store → 0.11 |
| **0.11.0** | Resource persistence / read APIs | Optional audit store; controlled `handoff_read_file` revival | Evidence-gated only | Claude → 0.12 |
| **0.12.0** | Claude host | Claude skill/hook; E2E by `taskId`; reuse resource contracts | Documented Claude path | Marketplace / Windows |

### 0.3.0 — CDP optimize + assisted create-worker (**shipped**)

1. **CDP fan-out** — A1-S: one headed Chrome + exclusive `browser-broker` + N page actors; UI-write mutex only around assert+type/send.
2. **Assisted create-worker** — `npm run create-worker` / `make create-worker`: CDP New chat → capture `/c/…` → atomic workers file → manual MCP approve → optional canary.

**Evidence:** `spike:a1s`, `test:leases`, `test:create-worker`, live `e2e:dual`, live burst `--n=4` on three workers, live create → `w3` READY.

**Worker profile (2026-08-18):** production workers run on **Chat** surface + **Cursor** plugin (not Work/Codex). `create-worker` switches Work→Chat, attaches Cursor from the + menu, then bootstraps. Avoids shared Codex/agentic credit pool exhaustion. Verified: per-worker canaries + broker burst `--n=3` on w1/w2/w3 all **COMPLETED**.

**Consent model (A):** wizard/CLI guides the human; no auto-login / auto-approve MCP writes.

#### Non-goals for 0.3.0

- Cookie export / password automation / auto-click MCP approve
- Elastic cloud worker pool / auto-create `wN` when queue depth exceeds workers
- Self-regulate context / auto-rotate worker chat → **0.5.0**

### 0.4.0 — Ops dashboard (**shipped**)

Operator pain after multi-worker + broker: diagnosing health, leases, and stuck tasks still means `curl` + logs.

#### Dashboard product line (inside 0.4.0)

| Dash ver | Scope | Status |
|----------|--------|--------|
| **0.1** | Read-only localhost UI: control plane, worker cards, recent tasks, troubleshoot + copyable cmds; poll `/health` `/workers` `/tasks` | **Done** (`/dashboard/`) |
| **0.2** | Read-only drill-down: task timing, on-demand redacted content, chat links, 24h counts, indicators | **Done** |
| **0.3** | Guarded mutations: recover / fail-task (typed confirm); topology read-only | **Done** |
| **0.3+** | Usage estimates (tokens + optional reference $); metric chips UI; history/charts; create-worker UI | **Usage + UI polish done**; charts later |

#### P0 — dashboard 0.1 (**done**)

- Status-api serves static UI at `/dashboard/`
- Control-plane strip: health, lease reaper, last tick, requeued / timed out / failed
- Worker cards: id, status, healthy, pid, heartbeat, current task, error
- Recent tasks list (`GET /tasks?limit=`): id, status, owner, type, age, error
- Troubleshoot hints (stale heartbeat, dead pid, SESSION_LOST / RATE_LIMITED) + copyable `curl` / `make doctor` / `recover` / broker stack
- Empty + API-unreachable states; local bind `127.0.0.1` only
- Design SSOT: Healthy frame (Figma/Stitch); other states derived in code

#### Dashboard 0.2 — operator drill-down (**done**)

Read-only observability (audit `ho_01M04PJWX91DS0C3R07W3WBEPF`):

| Item | Notes |
|------|--------|
| Task lifecycle timestamps / durations | List + detail: queue/processing/total ms, finished |
| On-demand redacted task inspector | `GET /tasks/:id/detail` + `/content`; list never has bodies; enable with `HANDOFF_DASHBOARD_TASK_CONTENT=redacted` |
| Worker ChatGPT chat link | Allowlisted `https://chatgpt.com/…` from worker_url |
| Per-worker 24h outcome counts | Honest counts; **no** max progress bar (0.5 owns budget) |
| Derived indicators | stale HB, long task, recent fail/timeout, session lost — not invented statuses |
| Drill-down UI | Click row → drawer; Load redacted content |

Terminal tasks now **keep `lease_owner`** (clear token/expiry only) so counts work; QUEUED requeue still clears owner.

**Out of 0.2:** recover/clear → **0.3**; capacity bar → package **0.5**.

#### Dashboard 0.3 — guarded mutations (**done**, hardened)

| Item | Notes |
|------|--------|
| Shared recover module | `planRecover` / `executeRecover` / `failTaskById`; CLI uses same path |
| Selective worker reset | Default: stale HB / dead pid / orphan task only; CLI `--reset-all-workers` for legacy wipe |
| Preview → execute | `POST /ops/recover/preview` → one-shot `planToken` + phrase `RECOVER <n>` |
| CSRF + origin | `GET /ops/session`; mutations require `X-Ops-CSRF`; Origin allowlist |
| `POST /ops/tasks/fail` | Confirm `FAIL <taskId>`; 404/409 semantics |
| `GET /ops/topology` | Allowlisted fields; CDP host redacted (no raw endpoint) |
| UI | Blast-radius modal (not `window.prompt`) |
| Tests | `npm run test:ops` |

**Out of 0.3:** full DB purge (CLI `--purge`); HTTP `failOpen` (CLI-only); history/charts; create-worker wizard; SaaS auth.

#### Dashboard usage estimates (0.3+ observability MVP)

Per ChatGPT research `ho_01M04T15ETEKJ3KXKN5F47JAGJ` + framing fix `ho_01M04W2BNFGZE25YAQ6T0Z602W`:

| Item | Notes |
|------|--------|
| Primary | Estimated **visible-text tokens** (`js-tiktoken` / `o200k_base` on stored prompt+result) |
| Optional $ | **Reference API cost** vs Cursor/API list rates — **off by default** |
| Comparison scenario | e.g. `Cursor alternative · Claude Sonnet 5` — **not** ChatGPT runtime model |
| Config | `HANDOFF_REFERENCE_PRICING=on`, `HANDOFF_REFERENCE_SCENARIO=claude-sonnet-5` |
| Snapshot | `task_usage` at submit; aggregates per worker + totals (24h / all-time) |
| UI | Metric chips + drawer “Compared with”; never bare `Model:` for counterfactual |
| Redacted content | `HANDOFF_DASHBOARD_TASK_CONTENT=redacted` (default off) |
| Backfill / tests | `npm run usage:backfill`, `npm run test:usage` |

#### Evidence

- `npm run test:ops`, `npm run test:usage`
- `make dashboard` / `make dashboard-up` → `http://127.0.0.1:8787/dashboard/`
- Connect path: [`docs/dashboard.md`](dashboard.md)
- Tag `v0.4.0`

#### Non-goals for 0.4.0

- Hosted SaaS dashboard / multi-user auth
- Replacing MCP or CDP automation with the UI
- Auto-scaling workers
- Claiming ChatGPT per-handoff invoices or cash savings from estimates

### 0.5.0 — Agent UX + worker chat rotation (**shipped**)

Formerly 0.4.0. Skill/rule handoff policy + self-regulate context (measure → threshold → create-worker → rotate). Depends on 0.3 create-worker.

#### P0 — Agent handoff policy

Light = **0** handoffs; Standard/Deep = **at most 1** per decision; anti-loop (no immediate re-handoff of the same decision). Rule + skill + `npm run test:agent-policy`. Scenarios: `.planning/2026-08-18-roadmap-0.5-agent-ux-rotation/scenarios-agent-ux.md`.

#### P0 — Self-regulate context

1. **Measure** — `tasks_on_chat` at dispatch (includes later FAILED/TIMED_OUT); tied to `{worker_id, chat_url}`.
2. **Threshold** — `HANDOFF_MAX_TASKS_PER_CHAT=20`; at `== N` no further claims.
3. **Replace** — idle-only `npm run rotate-worker` / `make rotate-worker`; Chat + Cursor; topology then DB reset.
4. **Rotate** — `ROTATION_PENDING` reservation; `CONSENT_REQUIRED` / `RESTART_REQUIRED`; operator restarts broker.

Recovery: [`docs/rotation.md`](rotation.md).

#### Evidence

- `npm run test:agent-policy`, `npm run test:rotation`
- Live: rotate `w3` → broker restart → burst `--n=3` PASS (`logs/e2e/burst-3-2026-08-18T00-34-19-139Z.json`)
- Tag `v0.5.0`

#### Non-goals for 0.5.0

- Host-generic “chooser”; unattended login
- Auto self-restart broker; per-worker max override; age/token heuristics
- Dashboard rotation controls (CLI + docs only)

### 0.6.0 — Worker Ops & Dashboard (**active**)

**Spec:** [`.planning/active/0.6-worker-ops.md`](../.planning/active/0.6-worker-ops.md) · **Impl plan:** [`.planning/active/0.6-worker-ops-impl-plan.md`](../.planning/active/0.6-worker-ops-impl-plan.md) · **ADR:** [ADR-008](../.planning/decisions/ADR-008-worker-ops-dashboard.md)

Dashboard health poll; assign/create chat URL; auto-canary clearing `CONSENT_REQUIRED`; kill/recreate binding; SESSION_LOST heal with confirm modal. Registry SSOT via `HANDOFF_WORKERS_FILE` (default `$CHATGPT_MCP_HOME/data/workers.json`).

#### Public ops UX (shipped baseline)

Single public CLI **`gptmcp`** — intent-based commands, strict args, formal exit codes, `--json` where applicable:

| Area | Notes |
|------|--------|
| Lifecycle | `gptmcp start` / `stop` / `restart` — PID ownership under `$CHATGPT_MCP_HOME/logs`, no implicit `npm run build` |
| Observe → diagnose → repair | `gptmcp status` → `doctor` → `recover` |
| Workers | `gptmcp worker add` / `rotate` / `inspect` (ops layer, not raw scripts) |
| Onboarding | `./scripts/install.sh` or `gptmcp setup`; user state under `$CHATGPT_MCP_HOME`; source checkout still seeds repo `.env` via `npm run setup` |
| Packaging | npm-global ships `dist/` + lifecycle shell assets; `npm run package:smoke` |
| Completion | `gptmcp completion fish\|bash` from CLI metadata |

**Developer surfaces:** `make` / `npm run` remain for CI and maintainers — not primary onboarding.

Portable create semantics (`clientSessionId` optional, `taskId` authoritative) shipped in the 0.5.x baseline — see [`.planning/archive/0.6-portable-core.md`](../.planning/archive/0.6-portable-core.md).

**Remaining for 0.6.0 tag:** worker control plane phases A–F (impl plan), `npm run test:worker-ops`, manual M1–M5.

### 0.7.0 — Handoff Resources (P0) (**shipped**)

**Spec:** [`.planning/active/0.7-handoff-resources.md`](../.planning/active/0.7-handoff-resources.md)

Dispatch-time materialize → native CDP buffer attach before fence. Merged PR #15 (2026-09-01).

**Exit debt (0.7.x):** `test:rotation` CI, formal `e2e:files-attach` D1–D3/D1b, issue #18, tag `v0.7.0`. See [test log](../.planning/active/0.7-handoff-resources-test-log-2026-09-01.md).

### 0.8.0 — Handoff Resources Phase 2

**Spec:** [`.planning/active/0.8-handoff-resources-phase2.md`](../.planning/active/0.8-handoff-resources-phase2.md)

Native symmetric writeback (ChatGPT → workspace), large-batch observability E2E, resource lifecycle hardening. Do not raise DOM chip cap without evidence.

### 0.9.0 — tar.zst pack (native path)

**Spec:** [`.planning/active/0.9-zstd-pack.md`](../.planning/active/0.9-zstd-pack.md) · **ADR:** [ADR-011](../.planning/decisions/ADR-011-zstd-pack.md)

Packing adapter on the native path (not a new transport): `files[]` → one `handoff-{taskId}.tar.zst` chip inbound; outbound `archive` XOR `artifacts[]`. Caps 100 / 64 MiB; window ≤ 8 MiB; fail closed.

### 0.10.0 — MCP Resource URI transport

`mcp_resource` source with explicit transport selection; benchmark against native attach (ADR-003: no silent fallback).

### 0.11.0 — Resource persistence / read APIs

Optional audit store; controlled `handoff_read_file` revival — evidence-gated.

### 0.12.0 — Claude host

Same `taskId` contract; optional `files` from 0.7+; after resource family stabilized.

## Current milestone

- **Shipped:** **0.1.0** … **0.8.0** (Handoff Resources Phase 2).
- **In progress:** **0.9.0** tar.zst pack.
- **Then:** **0.10.0** MCP URI → **0.11.0** audit/read → **0.12.0** Claude host.

## Near-term queue

1. **0.9.0** — codec + one-chip attach + archive writeback E2E
2. **0.10.0+** — MCP URI, audit, Claude (sequenced)

## Deferred / non-goals

| Item | Reconsider at |
|------|----------------|
| Dynamic worker pool / auto-create on queue depth | After **0.3.0** proven + explicit product consent |
| Auto-login / cookie export / auto-approve writes | Never as default |
| Self-regulate context (message/context threshold → new worker chat) | **0.5.0** (shipped) |
| “Works with all coding agents” claim | After each host has evidence (**0.11.0+**) |
| Marketplace / Windows | After macOS+Cursor multi-worker bar is solid |
| Dashboard history/charts / create-worker UI | Dash **0.3+** later |
| Handoff Resources P0 (dispatch materialize + native attach) | **0.7.0** (shipped) |
| Handoff Resources Phase 2 (writeback, observability) | **0.8.0** |
| tar.zst pack (native path) | **0.9.0** |
| MCP Resource URI transport | **0.10.0** |
| Resource persistence / read APIs | **0.11.0** |
| Claude host | **0.12.0** |
| Arbitrary workspace MCP (`read_file(path)`) | Never — task-scoped `handoff_read_file` only |

## Decision log

| Date | Decision | Reason | Supersedes |
|------|----------|--------|------------|
| 2026-09-03 | **0.9 = tar.zst pack**; MCP URI → **0.10**; audit/read → **0.11**; Claude → **0.12** | Always-one-chip packing before new transport; ADR-011 | 2026-09-01 ladder (0.9 MCP URI) |
| 2026-09-01 | **0.8 = HR Phase 2**; Claude → **0.11**; MCP URI → **0.9**; audit/read → **0.10** | 0.7 spec deferred resource work to v0.8+; Aug 30 ladder was host-driven too early; evidence before new hosts | 2026-08-30 ladder (0.8 Claude, 0.9 artifacts) |
| 2026-08-30 | **`gptmcp` = sole public ops UX**; `make` / `npm run` = developer/CI only | Reduce onboarding surface; safe lifecycle (PID ownership, no cwd token leaks); user-scoped `$CHATGPT_MCP_HOME` | Scattered `make up` / script onboarding in README |
| 2026-08-30 | **0.6 = Worker Ops**; **0.7 = Handoff Resources**; Claude → **0.8**; artifacts → **0.9** | Ops pain (CONSENT/URL/SESSION_LOST) blocks file-attach E2E; ship ops dashboard first | 2026-08-29 ladder (0.6 = Handoff Resources) |
| 2026-08-29 | **0.6 = Handoff Resources**; absorb portable core; Claude → **0.7**; result artifacts → **0.8** candidate | Portable core already in codebase; consolidate file layer + transport | 0.6 portable + 0.7 add files as separate milestones |
| 2026-08-18 | Add **0.7.0 add files**; shift Claude host → **0.8.0** | Native composer attachments for selected files; no `read_file` MCP; after portable create API, before a new host | Claude as 0.7.0 |
| 2026-08-18 | Mark **0.5.0 shipped**; next is **0.6.0** portable core | Policy + idle rotate-worker + live w3 rotate/burst; `docs/rotation.md`; tag `v0.5.0` | “0.5.0 in progress / not tagged” |
| 2026-08-18 | Workers on **Chat + Cursor plugin**; `create-worker` ensures Chat surface + attaches Cursor | Work/Codex profile exhausted shared agentic credits; Chat handoffs do not consume that pool; burst `--n=3` PASS on w1/w2/w3 | Work-profile workers + §17-only bootstrap |
| 2026-08-17 | Mark **0.4.0 shipped**; next is **0.5.0** agent UX + rotation | Dashboard 0.1–0.3 + usage landed; `docs/dashboard.md`; `test:ops` / `test:usage`; tag `v0.4.0` | “0.4.0 open until smoke/docs/tag” |
| 2026-08-16 | Usage $ = optional **reference cost** vs Cursor scenario (default Claude Sonnet 5); tokens primary; never label counterfactual as ChatGPT runtime `Model` | Operator confusion + review `ho_01M04W2BNFGZE25YAQ6T0Z602W` | “API-equiv. avoided” as headline / bare `Model: claude-sonnet-5` |
| 2026-08-16 | Dash **0.3** = guarded recover / fail-task + topology read-only; purge stays CLI | Live smoke `/ops/*` + typed confirm UI | Silent GET mutate / dashboard purge |
| 2026-08-16 | Dash **0.2** = read-only drill-down (timing, redacted inspector, chat links, honest counts, indicators); mutations → 0.3+; capacity bar → 0.5 | ChatGPT review `ho_01M04PJWX91DS0C3R07W3WBEPF` | “0.2 = recover/clear actions” |
| 2026-08-16 | Dashboard **0.1 landed** inside **0.4.0**; milestone stays open until harden/tag | Healthy-SSOT UI + `/tasks` + live `/dashboard/` | “0.4.0 = implement dashboard 0.1 next” |
| 2026-08-16 | Mark **0.3.0 done**; **0.4.0 = ops dashboard**; shift agent UX→0.5, portable→0.6, Claude→0.7 | Operator request after burst/create-worker evidence | Agent UX as immediate 0.4.0 |
| 2026-08-16 | Tag **v0.3.0** for A1-S; create-worker completed in-tree after tag | Live dual/burst + create-worker CLI | “create-worker still open” |
| 2026-08-16 | **0.5.0** (was 0.4) includes **self-regulate context** | Depends on 0.3 create-worker | Agent-UX-only prior 0.4 |
| 2026-08-16 | **0.3.0 CDP P0 = A1-S** | Second opinion `ho_01M042QR…` | Fully concurrent A1(i) default |
| 2026-08-16 | **0.2.0 shipped**; **0.3.0** = CDP + create-worker | Dual E2E + lease PASS | CDP deferred unscheduled |
| 2026-08-15 | Ladder: 0.1 → 0.2 multi-worker → 0.3 provision → … | Scale workers before vibe-coding policy | 2026-08-13 ladder |
| 2026-08-15 | 0.3.0 = wizard + manual login/MCP approve (model A) | Fail-closed consent | Unattended auto-create default |
| 2026-08-13 | `docs/roadmap.md` is sole version SSOT | Avoid dual authority with `.planning` | `.planning/2026-08-13-future-versions.md` |
| 2026-08-13 | Feature milestones are **`0.N.0` only**; minors = bugfix | Large features must not hide under `0.N.x` | Prior `0.N.x` feature buckets |
