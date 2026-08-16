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

Local-first Cursor/agent ↔ ChatGPT handoff over MCP: independent review, research, and second opinions without scraping the ChatGPT DOM. Priorities: correctness, consent, reproducible evidence — then **more workers** and assisted provisioning, then more hosts and agent UX policy.

## Support snapshot

| Surface | Status | Evidence |
|---------|--------|----------|
| Cursor + macOS + Chrome CDP | Supported (developer preview) | Transport canary; E2E in-repo |
| Claude Code / other MCP hosts | Experimental | Manual poll by `taskId` |
| Ubuntu desktop | Experimental | Not Snap/WSL/headless |
| Windows / WSL / headless | Not supported | — |
| Multi-worker | **0.2.0** | Leases + fencing + status-api; dual CDP E2E |
| Single-CDP multi-tab (A1-S) | **0.3.0** (CDP track) | `browser-broker` + UI-write mutex; dual canary on one CDP |

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
| **0.3.0** | CDP optimize + assisted create-worker | **A1-S shipped:** exclusive `browser-broker`, N tabs, mutex only around assert+type/send; dual canary on one CDP. **Still open:** assisted create-worker wizard | RAM/workspace down vs naïve N Chromes (proven); operator can add a worker without hand-editing only (pending wizard) | Unattended cookie/login; elastic cloud pool |
| **0.4.0** | Agent UX + worker chat rotation | Skill/rule handoff policy (Light/Standard/Deep); **self-regulate context** — count messages / context length, auto-create replacement worker chat, rotate when over threshold | Scenario set passes; ≤1 handoff/decision; rotation keeps workers usable without manual new-chat; consent model still fail-closed where required | Host-generic product “chooser”; fake effort knobs; unattended login |
| **0.5.0** | Portable core | Optional `clientSessionId`; `taskId` authoritative; core ≠ host adapters | Create with/without session; Cursor UX preserved; docs/skills updated | Supported Claude polish |
| **0.6.0** | Claude host | Claude skill/hook equivalent; E2E by `taskId` | Documented Claude path + clean evidence run | Marketplace / Windows |

### 0.2.0 — Static multi-worker (**shipped**)

Ship as its own feature release. Prefer **explicit worker configs** (env / file), not a dynamic cloud pool.

#### P0

- Register ≥2 workers (separate CDP endpoints and/or worker chat URLs)
- Claim with **leases** + heartbeat; fencing so a dead worker cannot double-dispatch
- Concurrency **1 task per worker**
- Ops: list workers, status, recover stuck leases (`make` / HTTP)
- Crash recovery: `DISPATCHING` / lease expiry → requeue or fail-closed

#### Non-goals for 0.2.0

- Auto-creating ChatGPT conversations
- Auto-login or auto-approving MCP writes
- Elastic / dynamic worker pool
- Collapsing N workers onto **one** Chrome/CDP (accepted cost for 0.2.0; moved to **0.3.0**)

### 0.3.0 — CDP optimize + assisted create-worker (**partial — CDP A1-S tagged**)

Combines two operator pain points left after 0.2.0:

1. **CDP fan-out cost** — N Chrome windows burn RAM and desktop space. → **Shipped as A1-S** (`browser-broker` mode).
2. **Create / register worker** — today is manual URL + profile setup. → **Still open** for full 0.3.0 exit.

**Consent model (A)** for provisioning: wizard guides the human; system does **not** silently create sessions or approve writes.

#### P0

- **CDP optimize — A1-S (shipped in 0.3.0 tag):**
  - One headed Chrome + one Node `browser-broker` + N page-bound actors
  - Global UI-write mutex only around assert + type/send (not claim/wait/MCP)
  - Connection generation + reconnect/rebind; atomic chat-id bind uniqueness
  - Topology `allowSharedCdp` for broker mode; fallback remains N headed `browser-worker`s
  - Evidence: `spike:a1s`, `test:leases`, live `e2e:dual` on one CDP
- **Assisted create-worker (remaining):** create/open chat → capture URL → wire topology (`workers.json` / env) → optional tunnel check → approve write tools (manual) → canary → READY
- Keep fence-before-type, leases, and no cross-talk on composers

#### Non-goals for 0.3.0

- Cookie export / password automation / auto-click MCP approve
- Elastic cloud worker pool
- Changing the pull-queue model (create still enqueues; idle workers claim) — admission control (“no idle worker → reject”) is optional stretch, not required to tag 0.3.0
- **Self-regulate context / auto-rotate worker chat** (message count or context length → create replacement worker) — deferred to **0.4.0**
- N Node processes all `connectOverCDP` to the same endpoint (rejected; exclusive broker only)

### 0.4.0 — Agent UX + worker chat rotation

Formerly the ASAP “0.2.0” slot for agent policy; now also owns **chat context hygiene**.

#### P0 — Agent handoff policy

Prefer **skill/rule policy**, not core queue logic.

Trigger handoff when independent review / live research / repeated debug failure / architecture ambiguity / user asks. Skip trivial work. At most one handoff per decision; end turn after create when stop hook present.

Task classes Light / Standard / Deep map local effort; handoff only when it adds value. Host effort APIs belong in adapters later.

#### P0 — Self-regulate context (worker chat rotation)

Long-lived ChatGPT worker chats accumulate messages and degrade (context bloat, slower UI, worse tool behavior). **0.4.0** must implement:

1. **Measure** — count messages and/or estimate context length on the worker conversation (DOM and/or local counters tied to dispatched tasks).
2. **Threshold** — configurable limit (env / topology); when exceeded, mark the logical worker as needing rotation.
3. **Replace** — create a **new** worker chat (builds on **0.3.0** assisted create-worker / broker page bind), wire topology to the new `/c/…` URL, run canary, mark READY.
4. **Rotate** — drain or fence the old chat (no new claims); optionally archive/close the old tab; keep lease/fencing invariants (no double-dispatch during cutover).

**Depends on:** 0.3.0 create-worker path (and preferably A1 broker page rebind).  
**Consent:** prefer reusing 0.3.0 model A where MCP write approve is still manual on the *new* chat unless a safer proven path exists; do not invent cookie/login automation here.

#### Non-goals for 0.4.0

- Elastic cloud pool
- Auto-login / cookie export as default
- Host-generic “chooser” product UI

## Current milestone

- **Shipped:** **0.1.0** (macOS/Cursor developer preview) and **0.2.0** (static multi-worker: leases, fencing, dual CDP E2E).
- **Product next:** **0.3.0** — CDP fan-out optimization + assisted create-worker (see below).
- **Deferred after that:** **0.4.0** agent UX + **worker chat rotation (self-regulate context)** → **0.5.0** portable core → **0.6.0** Claude host.
- **0.1.0 evidence gaps (non-blocking):** A/B bench scores ([benchmark/results.md](benchmark/results.md)); stranger onboarding ([onboarding-timing.md](onboarding-timing.md)).

## Near-term queue

1. Spec + implement **0.3.0** (CDP optimize + create-worker wizard).
2. Close remaining **0.1.0** evidence (bench + timing) without blocking 0.3.0.
3. Then **0.4.0** (agent UX + self-regulate context / rotate worker chat) → **0.5.0** → **0.6.0**.

## Deferred / non-goals

| Item | Reconsider at |
|------|----------------|
| Dynamic worker pool | After **0.3.0** create-worker path is proven |
| Auto-login / cookie export / auto-approve writes | Never as default; only with explicit consent UX in **0.3.0+** |
| Unattended ChatGPT chat creation via CDP | Prefer assisted wizard (**0.3.0**); full auto-rotate is **0.4.0** with fail-closed consent |
| Self-regulate context (message/context threshold → new worker chat) | **0.4.0** (needs 0.3 create-worker) |
| “Works with all coding agents” claim | After each host has evidence (**0.6.0+**) |
| Marketplace / Windows | After macOS+Cursor multi-worker bar is solid |

### CDP fan-out (moved into **0.3.0**)

**Problem (2026-08-15):** Static multi-worker requires **one Chrome CDP profile + port + worker chat per browser-worker**. Correct for isolating composer/UI, but scales poorly: RAM, window clutter, and operator workspace.

**0.2.0 stance (shipped):** Keep separate CDPs. Do not share one Chrome across two `browser-worker` processes.

**0.3.0 work:** **A1-S shipped** (exclusive `browser-broker` + N tabs + narrow UI mutex). Assisted create-worker remains for full exit. Keep fence-before-type, no cross-talk on composers, fail-closed consent.

## Decision log

| Date | Decision | Reason | Supersedes |
|------|----------|--------|------------|
| 2026-08-16 | Tag **v0.3.0** for A1-S CDP broker; assisted create-worker still open for full exit | Live dual E2E on one CDP PASS; operator release request | “0.3.0 next” as wholly unstarted |
| 2026-08-16 | **0.4.0** includes **self-regulate context**: count messages/context length → auto-create replacement worker → rotate chat over threshold | Operator request; depends on 0.3 create-worker; keeps 0.3 focused on CDP + assisted create | Agent-UX-only 0.4.0 |
| 2026-08-16 | **0.3.0 CDP P0 = A1-S** (broker + N tabs + mutex only around fence/type/send); headless-per-worker not P0 | Second opinion `ho_01M042QR…`; TASK_ID-only makes full concurrent UI writes low-value | Prior “fully concurrent A1(i)” as default |
| 2026-08-16 | **0.3.0 CDP P0 = A1(i) exclusive browser-broker** (CONDITIONAL on spike); reject N-process shared CDP | ChatGPT review `ho_01M042EE…` + Cursor eval; multi-process attach unsafe | Unspecified “A1 multi-tab” |
| 2026-08-16 | **0.2.0 shipped**; **0.3.0** = CDP optimize + assisted create-worker | Dual E2E + lease PASS; operator asked to pull CDP fan-out into next milestone with provisioning | 2026-08-15 “fewer CDPs deferred unscheduled”; 0.3.0 provisioning-only |
| 2026-08-15 | Ladder: 0.1.0 → **0.2.0 multi-worker** → **0.3.0 assisted provision** → 0.4.0 agent UX → 0.5.0 portable → 0.6.0 Claude | Operator priority: scale workers before vibe-coding policy | 2026-08-13 ladder (agent UX ASAP as 0.2.0; multi-worker as 0.5.0) |
| 2026-08-15 | 0.2.0 keeps **1 CDP Chrome per worker**; “fewer CDPs / less RAM” deferred post-0.2.0 | Dual E2E needs isolated composers; N Chrome is costly — redesign later (multi-tab dispatcher / on-demand CDP) | — |
| 2026-08-15 | 0.3.0 = wizard + manual login/MCP approve (model A) | Fail-closed consent; avoid brittle unattended CDP create | Unattended auto-create as default |
| 2026-08-13 | `docs/roadmap.md` is sole version SSOT | Avoid dual authority with `.planning` notes | `.planning/2026-08-13-future-versions.md` |
| 2026-08-13 | Auto-trigger + effort = skill/rule first | Product server cannot infer host task difficulty | Building chooser into core queue |
| 2026-08-13 | Feature milestones are **`0.N.0` only**; minors = bugfix | Large features must not hide under `0.N.x` | Prior `0.1.x` / `0.2.x` feature buckets |
