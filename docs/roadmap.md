# Roadmap

> Sole source of truth for **version scope and exit criteria**.  
> Execution details live in `.planning/`. Dates are not commitments.

## Versioning rule

| Pattern | Meaning |
|---------|---------|
| **`0.N.0`** | Feature / milestone release (preview tags: `0.N.0-preview`) |
| **`0.N.M`** (`M ≥ 1`) | Bug fixes / patches on that line only — **not** new features |

Do **not** use `0.N.x` as a feature bucket. Big capabilities each get their own `0.N.0`.

## Product direction

Local-first Cursor/agent ↔ ChatGPT handoff over MCP: independent review, research, and second opinions without scraping the ChatGPT DOM. Priorities: correctness, consent, reproducible evidence — then **more workers**, assisted provisioning, **ops visibility**, then agent UX policy and more hosts.

## Support snapshot

| Surface | Status | Evidence |
|---------|--------|----------|
| Cursor + macOS + Chrome CDP | Supported (developer preview) | Transport canary; E2E in-repo |
| Claude Code / other MCP hosts | Experimental | Manual poll by `taskId` |
| Ubuntu desktop | Experimental | Not Snap/WSL/headless |
| Windows / WSL / headless | Not supported | — |
| Multi-worker | **0.2.0** | Leases + fencing + status-api; dual CDP E2E |
| Single-CDP multi-tab (A1-S) + create-worker CLI | **0.3.0** | Broker + UI mutex; dual/burst canary; `npm run create-worker` |
| Ops dashboard | **0.4.0** (in progress) | Dashboard **0.1** at `/dashboard/` on status-api |

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
| **0.6.0** | Portable core | Optional `clientSessionId`; `taskId` authoritative; core ≠ host adapters | Create with/without session; Cursor UX preserved | Supported Claude polish |
| **0.7.0** | Claude host | Claude skill/hook equivalent; E2E by `taskId` | Documented Claude path + clean evidence run | Marketplace / Windows |

### 0.3.0 — CDP optimize + assisted create-worker (**shipped**)

1. **CDP fan-out** — A1-S: one headed Chrome + exclusive `browser-broker` + N page actors; UI-write mutex only around assert+type/send.
2. **Assisted create-worker** — `npm run create-worker` / `make create-worker`: CDP New chat → capture `/c/…` → atomic workers file → manual MCP approve → optional canary.

**Evidence:** `spike:a1s`, `test:leases`, `test:create-worker`, live `e2e:dual`, live burst `--n=4` on three workers, live create → `w3` READY.

**Consent model (A):** wizard/CLI guides the human; no auto-login / auto-approve MCP writes.

#### Non-goals for 0.3.0

- Cookie export / password automation / auto-click MCP approve
- Elastic cloud worker pool / auto-create `wN` when queue depth exceeds workers
- Self-regulate context / auto-rotate worker chat → **0.5.0**

### 0.4.0 — Ops dashboard (**in progress**)

Operator pain after multi-worker + broker: diagnosing health, leases, and stuck tasks still means `curl` + logs.

#### Dashboard product line (inside 0.4.0)

| Dash ver | Scope | Status |
|----------|--------|--------|
| **0.1** | Read-only localhost UI: control plane, worker cards, recent tasks, troubleshoot + copyable cmds; poll `/health` `/workers` `/tasks` | **Done** (`/dashboard/`) |
| **0.2** | Read-only drill-down: task timing, on-demand redacted content, chat links, 24h counts, indicators | **Done** |
| **0.3+** | Guarded mutations (recover/clear); history/charts/log tail; create-worker surface | Later |

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

**Out of 0.2:** recover/clear → **0.3+**; capacity bar → package **0.5**.

#### Remaining to claim package **0.4.0** shipped

- Live smoke evidence + short docs (`make dashboard` / connect path)
- Hardening (status-api restart durability with broker stack)
- Tag `v0.4.0` when exit criteria signed off (may ship with dash 0.1 only, or after 0.2 — product choice)

#### Non-goals for 0.4.0

- Hosted SaaS dashboard / multi-user auth
- Replacing MCP or CDP automation with the UI
- Auto-scaling workers

### 0.5.0 — Agent UX + worker chat rotation

Formerly 0.4.0. Skill/rule handoff policy + self-regulate context (measure → threshold → create-worker → rotate). Depends on 0.3 create-worker.

### 0.6.0 — Portable core

Formerly 0.5.0.

### 0.7.0 — Claude host

Formerly 0.6.0.

## Current milestone

- **Shipped:** **0.1.0**, **0.2.0**, **0.3.0** (A1-S + create-worker CLI).
- **In progress:** **0.4.0** — ops dashboard (**0.1 landed**; harden + evidence → tag).
- **Then:** **0.5.0** agent UX + rotation → **0.6.0** portable → **0.7.0** Claude.

## Near-term queue

1. Package **0.4.0** gate: smoke evidence, docs, durable status-api → tag (dash 0.1+0.2 landed).
2. Dashboard **0.3** (recover/clear) only if needed.
3. Then **0.5.0** (agent UX + self-regulate / max-per-chat).

## Deferred / non-goals

| Item | Reconsider at |
|------|----------------|
| Dynamic worker pool / auto-create on queue depth | After **0.3.0** proven + explicit product consent |
| Auto-login / cookie export / auto-approve writes | Never as default |
| Self-regulate context (message/context threshold → new worker chat) | **0.5.0** |
| “Works with all coding agents” claim | After each host has evidence (**0.7.0+**) |
| Marketplace / Windows | After macOS+Cursor multi-worker bar is solid |

## Decision log

| Date | Decision | Reason | Supersedes |
|------|----------|--------|------------|
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
