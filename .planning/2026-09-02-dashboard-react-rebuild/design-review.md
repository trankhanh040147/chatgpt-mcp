# Design review — Figma Make dashboard vs engineering reality

**Date:** 2026-09-02  
**Make file:** [Create Design from Spec](https://www.figma.com/make/GdV7zzx4CjYqKrUEp24O29/Create-Design-from-Spec?t=vAndgFVMumHk4Q4m-1)  
**Exported source reviewed:** `App.tsx` (~1500 LOC), `index.css`, `package.json`  
**Baseline:** shipped vanilla dashboard `src/dashboard/public/` + status-api routes  
**Verdict:** **Strong visual direction — not ready for code port.** Run one Make revision pass using [figma-make-revision.prompt.md](./figma-make-revision.prompt.md), then sign-off before React adapt.

---

## Executive summary

The Make export successfully captures the **light-first, calm developer-tool** direction from `dashboard-redesign-brief.md`:

- Tabs: Overview · Tasks · Diagnostics
- Workers as visual center with capacity bars
- Single inline alert (no triple redundancy)
- Worker/task drawers with progressive disclosure
- Correct capacity semantics (warn at 16+, not at 1/20)

However, several **engineering blockers** remain before porting to real API hooks:

| Severity | Count | Theme |
|----------|-------|-------|
| **Blocker** | 5 | Wrong IDs/vocabulary, missing ops flows, missing states |
| **Major** | 6 | Missing control-plane data, incomplete Diagnostics, hardcoded version |
| **Minor** | 4 | CSS root mismatch, decorative avatars, column labels |

---

## What works (keep)

### Visual & IA

- Light page background `#F6F6F8`, white surfaces, subtle borders — matches brief
- Overview hierarchy: page heading → inline alert → active handoff → workers → recent tasks
- **No separate Attention section** duplicating worker-card problems (brief requirement met)
- Worker cards quiet when healthy; action card uses pale amber tint only
- Capacity bar thresholds align with product (`16–17 approaching`, `18–19 critical`, `20 blocked`)
- Working state uses blue accent, not warning styling
- Task lifecycle stepper for single active handoff
- Drawer pattern (440px right rail) for worker + task detail
- Tasks tab with All / Active / Completed / Failed filters
- Monospace limited to IDs and durations

### Stack (confirmed for port)

| Layer | Make export | Repo target |
|-------|-------------|-------------|
| React | 19 | 19 |
| Bundler | Vite 8 | Vite (add to chatgpt-mcp) |
| CSS | Tailwind v4 + `@tailwindcss/vite` | Same |
| Fonts | Instrument Sans + JetBrains Mono | Same (replace Sora/IBM Plex Mono) |

---

## Blockers (must fix in Figma Make before sign-off)

### B1 — Worker IDs must be `w1`, `w2`, `w3` (not `A1`, `A2`, `A3`)

Real registry uses **`wN`** worker ids (`default`, `w1`, `w2`, …). Make mock uses `A1/A2/A3`.

**Fix:** Replace all worker ids in mock data, labels, and inline alert copy.

### B2 — Missing control plane strip

Vanilla dashboard exposes lease reaper + reap counters operators rely on:

| Field | API source |
|-------|------------|
| Health | `GET /health` → `ok` |
| Lease reaper | `health.leaseReaper` |
| Last tick | `health.lastReapAt` |
| Requeued / timed out / failed | `health.reapStats` |

Make Overview has **no control plane section**. Either:

- Compact horizontal KV strip below page heading (preferred — matches shipped dash 0.4–0.6), or
- Move to Diagnostics tab **and** show a one-line summary on Overview (“Lease reaper ON · 1 requeued”)

**Recommendation:** compact strip on Overview — operators use this every poll cycle.

### B3 — Missing mutation / confirm flows

Make shows action buttons but **no designs** for:

| Flow | API | Vanilla UI |
|------|-----|------------|
| Recover (preview → confirm) | `POST /ops/recover/preview`, `/ops/recover` | Headline + modal |
| Fail task | `POST /ops/tasks/fail` | Task drawer |
| Destructive worker ops confirm | all `POST /ops/workers/*` | Ops modal + CSRF |
| Add worker guided flow steps | `POST /ops/workers/add` → create-chat | Multi-step modal |
| Async op progress | journal polling | Card banner “Creating chat… step 2/4” |

**Fix:** Add frames/modals for confirm dialog, add-worker wizard (4 steps), and in-progress worker state.

### B4 — Missing system states

Make only renders the “2 of 3 workers ready + A3 action required” scenario. Need frames or component variants for:

| State | Trigger | Overview behavior |
|-------|---------|-------------------|
| **API down** | `/health` unreachable | Full-page unreachable (not tabs) |
| **Setup** | 0 registered workers | Empty workers + “Add worker” CTA |
| **Broker offline** | `brokerReachable: false` | Banner + “Start broker” primary action |
| **All OK** | taxonomy `OK` | Quiet — no inline alert |
| **SESSION_LOST** | worker status | Inline alert + recreate chat CTA |
| **chatAccessDenied** | wrong Chrome account | Assign URL CTA (not generic error) |

Do **not** create separate full-page layouts per state — derive from data like vanilla `deriveSystemTaxonomy()`.

### B5 — Operator vocabulary must map to backend, not invent

Make `WorkerStatus` enum is close but must align with **`OperatorState`** from `worker-health.ts`:

| Make UI | Backend `OperatorState` | Notes |
|---------|-------------------------|-------|
| Ready | `READY` | |
| Working | (worker `BUSY` + healthy) | Not an error |
| Action required | `ACTION_REQUIRED` | MCP consent, assign URL, etc. |
| Starting | `STARTING` | CDP tab attach in progress |
| Degraded | `DEGRADED` | |
| Offline | maps to `OFFLINE` / dead pid | |
| Disabled | `enabled: false` in registry | |

Task statuses must use exact enums: `QUEUED`, `DISPATCHING`, `DISPATCHED`, `PROCESSING`, `WAITING_APPROVAL`, `COMPLETED`, `FAILED`, `TIMED_OUT` — not `sent` alone.

Handoff `type` values from API are snake_case (`architecture_review`, `code_review`, …) — UI label maps to Title Case.

---

## Major gaps (fix in Make revision or document as engineering-only)

### M1 — Diagnostics tab under-designed

Make `DiagnosticsTab` is a placeholder. Must include:

- Copyable commands: `gptmcp status`, `gptmcp doctor`, `curl -s http://127.0.0.1:8787/health | jq`, `./scripts/start-broker-stack.sh`
- Topology read-only (`GET /ops/topology`) — redacted CDP
- Raw condition checklist (PROCESS / BROKER / BINDING / URL / SESSION / MCP_READ / MCP_WRITE)
- Broker ops port hint (default **18788**, not 8788)
- Recent recover / ops audit (optional v1.1)

### M2 — Worker drawer: condition checklist

Make drawer shows connection booleans but labels don't match API `WorkerCondition.type`:

```
Process · Broker · Binding · URL · Session · MCP read · MCP write
```

Use readable labels + TRUE/FALSE/UNKNOWN icons. Raw reason codes → expandable “Technical details”.

### M3 — Task drawer: fail-task + usage + redacted content

Missing:

- **Fail task** button (terminal tasks only, confirm modal)
- Usage block with “Estimated tokens — not ChatGPT billing” disclaimer
- Redacted prompt/result load button (when `HANDOFF_DASHBOARD_TASK_CONTENT=redacted`)
- Privacy notice on redaction

### M4 — Version badge

Make hardcodes `v0.8.3`. Should read from build metadata or show `dashboard 1.0` + package version at runtime — design should use `{version}` placeholder.

### M5 — Recover at system level

When taxonomy is `DEGRADED`, headline recover action exists in vanilla UI. Make Overview lacks **Recover workers** in overflow or inline when multiple workers stale.

### M6 — Worker overflow menu actions

Card `•••` opens drawer today; need **overflow menu design** with:

- Assign URL · New chat · Continue · Enable/Disable
- Recreate chat (destructive) · Clear stuck · Remove worker (destructive)

Destructive items use confirm modal — separate frame required.

---

## Minor nits

| # | Issue | Fix |
|---|-------|-----|
| N1 | `index.css` sets `body { background: #09090d }` but App root uses `#F6F6F8` | Align CSS entry to light theme |
| N2 | Decorative bot avatars on worker cards | Optional — brief prefers text-first; OK to keep if subtle |
| N3 | “Broker connected” always green in AppBar | Should reflect live broker reachability |
| N4 | Recent tasks missing **Owner** column | API list includes owner worker id — add column or merge with Worker |

---

## Parity checklist (vanilla → React)

Use this as sign-off gate when adapting Make source:

- [ ] Poll `/health`, `/workers`, `/workers/health`, `/tasks?limit=10` every ~5s
- [ ] CSRF via `GET /ops/session` before any `POST /ops/*`
- [ ] All 11 worker op endpoints wired
- [ ] Recover preview + execute
- [ ] Fail task from drawer
- [ ] Topology in Diagnostics
- [ ] `chatAccessDenied` + Assign URL path
- [ ] Optimistic busy on worker cards during async ops
- [ ] Debug `<details>` persistence (worker diagnostics expand state across polls)
- [ ] Reference pricing off by default; token estimate labels honest

---

## Recommended next steps

1. **Paste** [figma-make-revision.prompt.md](./figma-make-revision.prompt.md) into Figma Make
2. **Review** revised frames against this doc
3. **Sign-off** design (you) — blocks React merge
4. **Port** Make source → `src/dashboard/ui/` on `feat/dashboard-react`
5. **Keep** vanilla at `/dashboard/` until parity tests pass (cutover phase 4)

---

## References

- Make pasted spec: `src/imports/pasted_text/chatgpt-mcp-ops-dashboard.md`
- Redesign brief: `src/imports/pasted_text/dashboard-redesign-brief.md`
- [docs/dashboard.md](../../docs/dashboard.md)
- [ADR-010](../decisions/ADR-010-dashboard-react-rebuild.md)
- [0.4 figma design review (historical)](../2026-08-16-roadmap-0.4-ops-dashboard/figma-design-review.md)
