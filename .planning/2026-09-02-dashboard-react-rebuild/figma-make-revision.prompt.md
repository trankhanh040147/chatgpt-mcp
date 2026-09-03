# Figma Make revision prompt — dash 1.0 semantics pass (v2)

Paste everything below the line into **Figma Make** on the existing file:  
https://www.figma.com/make/GdV7zzx4CjYqKrUEp24O29/Create-Design-from-Spec

This is **not a visual redesign**. Keep the current light theme (Instrument Sans, JetBrains Mono, Tailwind v4, `#F6F6F8` page / white surfaces). This pass turns the Overview from a polished UI into an **operator console** a solo developer can read → diagnose → act within seconds.

---

## Core principle (read first)

> **Design around causal state, not independent badges.** When an upstream dependency fails, downstream checks become **UNKNOWN** rather than FAILED. Surface the highest actionable root cause **once**, and suppress duplicate derived warnings elsewhere in Overview.

Good control-plane dashboards answer four questions: *what is running, what is happening, what is unhealthy, what should I do next*. Use fleet cards → drawer for drill-down; do not dump telemetry on the main screen.

---

## Context

You already produced a strong Overview (tabs, worker cards, capacity bars, drawers). Engineering reviewed the export against the live chatgpt-mcp status API. **Do not regress** what works. Apply semantics fixes below.

Product: local-first ops dashboard at `http://127.0.0.1:8787/dashboard/` — loopback only, not SaaS.

Primary user: **solo developer operator** — not NOC, not multi-tenant admin.

---

## KEEP (do not change)

- Light-first theme, subtle borders, no glassmorphism / gradients / dark SaaS cards
- Tab nav: Overview · Tasks · Diagnostics (no permanent sidebar)
- Overview order: control plane strip → **one** contextual alert (if actionable) → active handoff → workers → recent handoffs
- **Never** repeat the same incident in strip + alert + worker card
- Worker cards as visual center; Working = healthy blue (not warning)
- Single active handoff → lifecycle stepper; multiple → compact table
- Worker drawer + task drawer (440px right rail)
- Monospace for IDs, durations, commands only

---

## FIX — vocabulary (mandatory)

Replace mock worker ids **`A1`, `A2`, `A3`** → **`w1`, `w2`, `w3`**.

| Layer | Rule |
|-------|------|
| **Card / Overview** | Operator vocabulary only: Ready · Working · Starting · Action required · Degraded · Offline · Disabled |
| **Never on card** | `READY`, `BUSY`, `SESSION_LOST`, `RATE_LIMITED`, `ERROR` — runtime enums belong in drawer “Technical details” only |
| Task ids | `ho_…` monospace, middle-truncated |
| Task statuses (UI) | Queued · Dispatching · Dispatched · Processing · Waiting approval · Completed · Failed · Timed out |
| Handoff types | Research · Code review · Architecture review · Debug analysis · Second opinion |

Real commands only:

```
gptmcp start
gptmcp doctor
gptmcp status
curl -s http://127.0.0.1:8787/health | jq
./scripts/start-broker-stack.sh
```

Never: `systemctl`, `docker-compose`, `journalctl`, port `:8080`, broker on `:8788` (default broker ops = **18788**).

---

## ADD — control plane strip (hierarchical, not flat KPI row)

Add a compact strip at top of Overview — **not** six equal-weight KPI cards.

**Primary signal (stronger weight):**

```
● OK    Last tick 8s ago
```

Tooltip on Last tick: `Status API refreshed 8s ago`

When data is stale (> ~30s without successful poll), the strip itself changes — **no separate alert section**:

```
● STALE    Last tick 42s ago
```

**Secondary signal (lighter weight, same row, separated visually):**

```
Lease reaper ON  ·  Requeued 1  ·  Timed out 0  ·  Failed 0
```

Layout example:

```
● OK · Last tick 8s ago  |  Lease reaper ON · Requeued 1 · Timed out 0 · Failed 0
```

First question this answers: **“Is status data alive?”** — not “how many failures?”

---

## Worker card — answer 3 questions only

Each card answers:

1. **Who** — worker id (`w1`)
2. **State** — operator label + one human sentence
3. **Capacity + recency** — bar + last activity

Do **not** expose MCP/broker/browser checks on the card. Those live in the drawer.

### Ready

```
w1                                    •••
Ready

Ready for handoffs

Capacity
████████░░░░░░░░░░░░  12 / 20

Last activity                         2m ago
```

### Working (healthy — not warning styling)

```
w2                                    •••
Working

Architecture review
ho_8f2…91c                            03:42

Capacity
████████████████░░░░  16 / 20
```

### Action required

```
w3                                    •••
Action required

MCP write approval required
[Continue verification]

Capacity
██████░░░░░░░░░░░░░░  6 / 20
```

Card shows **one primary action** when needed. Overflow `•••` for the rest.

---

## FIX — capacity bar semantics (avoid alert fatigue)

Thresholds:

| Used | Treatment |
|------|-----------|
| 0–15 | Neutral/calm bar — **no warning text** |
| 16–17 | Bar stays calm + small text: `Approaching capacity` |
| 18–19 | Amber bar + `Rotate soon` |
| 20 | Blocked + primary `New chat` |

**Do not** turn the entire bar amber/red at 16/20 — that looks like an incident. Solo operator tool, not NOC wallboard.

**1/20 is normal** — never warn about rotation when chat is nearly empty.

---

## Causal state — suppress downstream failures

When Broker is offline, drawer checklist must **not** show six red failures:

**Wrong:**

```
✕ Broker
✕ Browser binding
✕ Chat URL
✕ Session
✕ MCP read
✕ MCP write
```

**Correct:**

```
✕ Broker
? Browser binding
? Chat URL
? ChatGPT session
? MCP read
? MCP write
```

Summary line: **Broker unavailable — downstream checks unknown**

Rules:

- `✓` = connected / verified (TRUE)
- `✕` = failed (FALSE) — only when evidence exists
- `?` = unknown (UNKNOWN) — lack of evidence, not failure
- Do **not** use amber for all UNKNOWN; neutral `?` is fine

Represent checks as a **diagnostic ladder** with light vertical connectors — pipeline, not independent badges:

```
Connection

✓ Process
│
✓ Broker
│
✓ Browser binding
│
✓ Chat URL
│
✓ ChatGPT session
│
✓ MCP read
│
✕ MCP write
  Approval required
```

---

## Two failure modes — completely different UX

### Status API unreachable

→ **Entire UI untrusted** — replace app shell, **no tabs**, no worker cards, no stale data.

```
Control plane unreachable

The dashboard can't reach the local status API.

Last seen 07:03:18

Quick recovery
gptmcp status
gptmcp doctor
curl -s http://127.0.0.1:8787/health | jq
./scripts/start-broker-stack.sh
```

### Broker offline

→ Status API still works — Overview **remains trustworthy**.

- Pale banner: `Broker control plane unreachable` + **[Start broker]**
- Worker drawer: Broker = ✕, downstream = ?
- Do **not** full-page replace

---

## Add worker wizard — step 3 is a waiting state, not a form

Flow: slot → creating chat → MCP approval → ready

**Step 3 design:**

```
        ○
Waiting for MCP approval

Open ChatGPT and approve write access.
This page will continue automatically once
approval is detected.

[Open ChatGPT]

Waiting…                         01:24

Having trouble?
Run gptmcp doctor

Advanced: Assign existing ChatGPT URL
```

**No Next button.** Polling advances to Ready. Feels like real control plane, not mock wizard.

Step 2 example: `Creating ChatGPT chat… · Step 2 of 4 · Binding browser tab`

---

## Destructive confirm modals — consequence sentences

Not just action name — show **domain objects** affected.

**Recreate chat:**

```
Recreate chat for w2?

The current ChatGPT conversation will be replaced.
w2 will need MCP verification again.

Current task
ho_a81…90e · Architecture review

[Cancel]  [Recreate chat]
```

**Remove worker:**

```
Remove w2?

This removes the worker slot from the control plane.
The ChatGPT conversation itself will not be deleted.

[Cancel]  [Remove worker]
```

Also design: Recover workers · Fail task — same blast-radius pattern. No typed-phrase confirm.

---

## Worker overflow menu — context-sensitive, grouped

**Not** a static 8-item list. Group and hide irrelevant actions:

```
Chat
  Open ChatGPT
  Assign URL
  New chat
  Continue verification      ← only when ACTION_REQUIRED

Worker
  Disable worker             ← or Enable worker if disabled

Recovery
  Clear stuck
  Recreate chat

────────────────
Remove worker                ← isolated, last, destructive
```

If worker is Ready → hide Continue verification. If Disabled → show Enable worker.

---

## Diagnostics tab — operator first, debugger second

Order:

1. **Quick commands** (copy buttons)
2. **System topology** (readable table — worker id, state, chat url)
3. **Connection model** (reference ladder: Process → Broker → Binding → URL → Session → MCP read → MCP write)
4. **Endpoints** — Status API `127.0.0.1:8787` · Broker ops `127.0.0.1:18788`
5. **Raw topology JSON** — collapsed `▸ Show` — progressive disclosure last

Do **not** lead with JSON dump.

---

## Empty state — minimal

```
No workers yet

Add a ChatGPT worker to start
accepting handoffs.

[+ Add worker]

Advanced: Assign existing ChatGPT URL
```

No large illustration, no onboarding checklist.

---

## Target Overview layout (1440px)

```
Control plane
● OK · Last tick 8s ago  |  Lease reaper ON · Requeued 1 · Timed out 0 · Failed 0

[ one contextual alert ONLY if actionable ]

Active handoff
Research · ho_8f2…91c · w2 · Processing · 03:42
●────●────●────○  Queued → Dispatch → Processing → Complete

Workers                                              + Add worker
┌──────────────┐ ┌──────────────┐ ┌──────────────┐
│ w1       ••• │ │ w2       ••• │ │ w3       ••• │
│ Ready        │ │ Working      │ │ Action req.  │
│ Ready for    │ │ ho_8f…91c    │ │ MCP approval │
│ handoffs     │ │ 03:42        │ │ [Continue]   │
│ ████ 12/20   │ │ ████ 16/20   │ │ ██ 6/20      │
└──────────────┘ └──────────────┘ └──────────────┘

Recent handoffs
...
```

---

## Sample mockup scenario

| Worker | State | Notes |
|--------|-------|-------|
| w1 | Ready | 12/20 — calm bar |
| w2 | Working | Architecture review · 16/20 — text only “Approaching capacity”, bar still calm |
| w3 | Action required | MCP approval · 6/20 — no rotation warning |

One inline alert: `w3 needs MCP approval` · [Open ChatGPT] [Continue]

Also design variants: API unreachable (full page) · broker offline (banner) · all OK (no alert) · empty workers.

---

## Deliverables checklist

- [ ] Control plane strip with primary/secondary hierarchy + STALE state
- [ ] Causal ladder in worker drawer + downstream UNKNOWN suppression
- [ ] Worker cards — operator vocabulary only, 3-question model
- [ ] Capacity bar — calm at 16, escalate at 18–20
- [ ] API unreachable vs broker offline — distinct frames
- [ ] Add worker wizard with waiting-state step 3
- [ ] Destructive modals with consequence copy
- [ ] Context-sensitive overflow menu
- [ ] Diagnostics tab — human-readable first
- [ ] All worker ids `w1/w2/w3`, all commands project-real

**Review question:** Can a developer open this dashboard, know whether handoffs work, find the root cause, and take the correct next action within 10 seconds?

Do not generate mobile until desktop 1440px is signed off.
