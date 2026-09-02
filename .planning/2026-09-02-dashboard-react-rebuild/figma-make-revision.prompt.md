# Figma Make revision prompt — dash 1.0 engineering pass

Paste everything below the line into **Figma Make** on the existing file:  
https://www.figma.com/make/GdV7zzx4CjYqKrUEp24O29/Create-Design-from-Spec

This is a **revision pass** on the current light-theme Overview — not a from-scratch redesign. Keep the visual direction (Instrument Sans, JetBrains Mono, Tailwind v4, calm light surfaces). Fix engineering gaps so the export can be ported to the real chatgpt-mcp status API.

---

## Context

You already produced a strong Overview (tabs, worker cards, capacity bars, drawers). Engineering reviewed the exported `App.tsx` against the live API. **Do not regress** what works. Apply the fixes below.

Product: local-first ops dashboard at `http://127.0.0.1:8787/dashboard/` — loopback only, not SaaS.

Primary user: solo developer operator.

---

## KEEP (do not change)

- Light-first theme: page `#F6F6F8`, surfaces white, subtle `#E8E8EC` borders
- Tab nav: Overview · Tasks · Diagnostics (no permanent sidebar)
- Overview order: page heading → **one** inline alert (if needed) → active handoff → workers → recent handoffs
- **Never** repeat the same incident in heading + separate Attention section + worker card
- Worker cards as visual center; healthy cards quiet; Working = blue (not warning)
- Capacity semantics: warn only at **16+/20** (approaching), **18–19** (rotate soon), **20** (blocked). **1/20 is normal — no warning**
- Single active handoff → lifecycle stepper; multiple → compact table
- Worker drawer + task drawer (440px right rail)
- Instrument Sans + JetBrains Mono; monospace for IDs/commands only

---

## FIX — vocabulary (mandatory)

Replace all mock worker ids **`A1`, `A2`, `A3`** with **`w1`, `w2`, `w3`**.

Use exact product terms — never generic SaaS labels:

| Concept | Correct label |
|---------|---------------|
| Worker ids | `w1`, `w2`, `w3`, `default` |
| Task ids | `ho_…` monospace, middle-truncated |
| Worker runtime | `READY`, `BUSY`, `SESSION_LOST`, `RATE_LIMITED`, `ERROR` (internal) |
| Operator-facing worker states | Ready · Working · Starting · Action required · Degraded · Offline · Disabled |
| Task statuses | Queued · Dispatching · Dispatched · Processing · Waiting approval · Completed · Failed · Timed out |
| Handoff types | Research · Code review · Architecture review · Debug analysis · Second opinion |

Copyable commands must be **project-real**:

```
gptmcp start
gptmcp doctor
gptmcp status
curl -s http://127.0.0.1:8787/health | jq
./scripts/start-broker-stack.sh
```

**Never** use: `systemctl`, `docker-compose`, `journalctl`, port `:8080`, or `:8788` for broker (default broker ops port is **18788**).

---

## ADD — control plane strip (Overview)

Below the page heading (or integrated into it), add a **compact horizontal strip** — not giant KPI cards:

| Label | Example |
|-------|---------|
| Health | OK |
| Lease reaper | ON |
| Last tick | 8s ago |
| Requeued | 1 |
| Timed out | 0 |
| Failed | 0 |

Low height, scannable, same visual weight as the rest of Overview — not a hero banner.

---

## ADD — missing screens / modals

Design these at the same fidelity as Overview:

### 1. Confirm modal (destructive ops)

Used for: Recreate chat · Remove worker · Recover workers · Fail task

- Title + blast-radius preview (what will change)
- Primary destructive button + Cancel
- No typed-phrase confirmation (vanilla uses one-click confirm + CSRF)

### 2. Add worker wizard (modal or slide-over)

Steps:

1. Add worker slot
2. Creating ChatGPT chat… (progress: step 2 of 4 · Binding browser tab)
3. Waiting for MCP approval — “Open ChatGPT and approve write access”
4. Ready

Advanced link: **Assign existing ChatGPT URL**

### 3. API unreachable (full page)

When status API is down — **replace entire app**, no tabs:

- “Control plane unreachable”
- Last seen timestamp
- Copyable commands block (the five real commands above)

### 4. Empty setup state

- “No workers yet”
- “Add a ChatGPT worker to start accepting handoffs.”
- [Add worker] primary CTA

### 5. Broker offline banner

Pale warning banner at top of Overview:

- “Broker control plane unreachable”
- Primary: **Start broker** (maps to `gptmcp restart` / stack script)
- Workers show `BROKER: UNKNOWN` in drawer checklist

### 6. Worker overflow menu

From card `•••` button — dropdown with:

- Assign URL · New chat · Continue verification · Enable/Disable
- Separator
- Recreate chat (destructive) · Clear stuck · Remove worker (destructive)

### 7. Diagnostics tab (complete, not placeholder)

Sections:

- **Quick commands** — copy buttons for the five real commands
- **Topology** — read-only JSON/table (worker ids, chat urls redacted host ok)
- **Condition reference** — explains PROCESS / BROKER / BINDING / URL / SESSION / MCP read / MCP write
- **Endpoints** — Status API `:8787`, Broker ops `:18788` (loopback)

---

## FIX — worker drawer

Progressive disclosure sections:

1. **Summary** — operator state sentence (“Ready for handoffs” / “MCP approval required”)
2. **Current activity** — task + elapsed (if busy)
3. **Chat capacity** — `12 of 20` + bar
4. **Connection checks** — checklist with readable labels:

   - Process · Broker · Browser binding · Chat URL · ChatGPT session · MCP read · MCP write

   Use ✓ / ✗ / ? for TRUE / FALSE / UNKNOWN

5. **Chat** — sanitized `https://chatgpt.com/c/…` + Open ChatGPT
6. **Runtime** — PID, last heartbeat, start time (monospace values only)
7. **Technical details** (collapsed) — raw readiness reason, error codes

Primary action on drawer footer when applicable: Continue · Assign URL · New chat · Recreate chat

---

## FIX — task drawer

Include:

- Lifecycle timeline (Queued → Dispatching → Dispatched → Processing → Completed)
- Timing: queue / processing / total duration
- Usage estimate block:

  > Estimated visible-text tokens — not ChatGPT billing.

- Optional reference row (when enabled):

  > Reference API equivalent · Hypothetical comparison (Claude Sonnet 5)

- **Fail task** button (failed/timed out processing tasks only) → opens confirm modal
- Redacted content section:

  > Task content is hidden for privacy.

  [Load redacted preview] — when enabled; include best-effort privacy notice

---

## FIX — CSS entry

Update `index.css` so `body` background matches the light app shell (`#F6F6F8`), not `#09090d`. Remove dark-theme root if App already sets light background.

---

## FIX — version badge

Replace hardcoded `v0.8.3` with placeholder `v{packageVersion}` or `dashboard 1.0 · v0.6.x`.

---

## Sample data for primary mockup (revise existing)

Render Overview with:

**System:** 2 of 3 workers dispatch-ready · Broker connected · Lease reaper ON

| Worker | State | Notes |
|--------|-------|-------|
| w1 | Ready | Chat 8/20 — no capacity warning |
| w2 | Working | Architecture review · ho_01J… · 2m 14s · Chat 14/20 |
| w3 | Action required | MCP approval required · Chat 1/20 — **no rotation warning** |

**Inline alert (one only):** w3 needs MCP approval · [Open ChatGPT] [Continue]

**Active handoff:** ho_01J… · Architecture review · w2 · Processing · 2m 21s

**Recent tasks:** 5 rows — include one timed_out with error code visible

---

## Deliverables checklist

Before calling this done, ensure the file includes:

- [ ] Overview — healthy / degraded / setup / API-down variants (or one frame + notes)
- [ ] Tasks tab — filters work visually
- [ ] Diagnostics tab — complete
- [ ] Worker drawer — all sections
- [ ] Task drawer — usage + fail task
- [ ] Add worker wizard
- [ ] Confirm modal (destructive)
- [ ] Worker overflow menu
- [ ] Control plane strip on Overview
- [ ] All worker ids `w1/w2/w3`
- [ ] All commands project-real

**Review question:** Could a developer who knows almost nothing about the internal architecture open this dashboard, understand whether handoffs work, identify a problem, and take the correct next action within 10 seconds?

If no — simplify further.

Do not generate mobile layouts until desktop 1440px is signed off.
