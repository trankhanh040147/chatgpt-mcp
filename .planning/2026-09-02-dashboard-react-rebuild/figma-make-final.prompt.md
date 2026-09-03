# Figma Make — FINAL master prompt (design-complete gate)

**Paste everything below the line** into the existing Make file:  
https://www.figma.com/make/GdV7zzx4CjYqKrUEp24O29/Create-Design-from-Spec

This is the **single comprehensive design pass**. Goal: ship a **complete, sign-off-ready** operator dashboard in Figma before any React implementation.

**Do not start from scratch.** Evolve the current light-theme export.  
**Do not** regress: w1/w2/w3, control plane strip, causal ladder, capacity semantics, overflow menu, confirm modals, add-worker waiting, API unreachable, Diagnostics structure.

---

## North star

Build a **crafted local developer ops tool** — not a generic SaaS admin panel.

| Feel | Means |
|------|--------|
| Calm at rest | Healthy fleet = quiet, no alert spam |
| Alive in motion | Subtle life when tasks/workers change state |
| Delightful on success | Restrained completion moment — not casino confetti |
| Unmistakable on failure | One root cause, one primary action |

References (quality bar only — do not clone): Linear, Raycast, Vercel dashboard craft.

**Anti-patterns:** gradients, glassmorphism, neon, giant KPI cards, left sidebar, `systemctl`/`docker-compose` commands, worker ids A1/A2/A3.

---

## Core principles (non-negotiable)

1. **Causal state** — upstream fail → downstream `?` UNKNOWN, not six red ✕. One incident, one primary place on Overview.
2. **Overview = decisions** — title, repo, dispatch readiness, one alert max. Technical detail → drawer / Diagnostics.
3. **Tasks tab = database** — full table, filters, sort. Overview recent = **activity feed**.
4. **Operator vocabulary on surface** — Ready · Working · Action required · Starting · Degraded · Offline · Disabled. Never `SESSION_LOST` / `BUSY` on cards.
5. **Mock rich data** — realistic task titles + repo labels even though backend will ship later.

---

# PART A — Information architecture

## Tabs (no sidebar)

`Overview` · `Tasks` · `Diagnostics`

Optional: **Settings** as AppBar `•••` slide-over or 4th tab — include theme + preferences.

## Overview order (top → bottom)

1. Control plane strip (hierarchical)
2. Hero line + dispatch subline
3. **One** contextual alert (only if actionable)
4. Active handoff (lifecycle)
5. Workers grid (+ Add worker)
6. Recent handoffs **activity feed**
7. `View all tasks →`

## Control plane strip

```
● OK · Last tick 8s ago  |  Lease reaper ON · Requeued 1 · Timed out 0 · Failed 0
```

- Primary weight: `● OK/STALE` + Last tick (tooltip: Status API refreshed …)
- Secondary: lease reaper + counters
- **STALE variant:** `● STALE · Last tick 42s ago` — no separate alert

## Hero + dispatch (personality)

| Frame | Hero (~22–24px) | Subline |
|-------|-----------------|---------|
| Busy + degraded | **Everything is moving.** | 2 of 3 workers dispatch-ready · 1 handoff processing |
| Action required | **One thing needs you.** | w3 is waiting for MCP write approval |
| All clear | **All clear.** | 3 of 3 workers dispatch-ready |
| Broker down | **Handoffs are blocked.** | Broker control plane unreachable |
| Setup | **No workers yet.** | Add a ChatGPT worker to start accepting handoffs |
| API down | *(full page — no hero)* | |

---

# PART B — Task identity (title + repo)

Every active/completed row shows **semantic anchor**:

```
Review auth architecture before v0.9 release          ← title (15–16px semibold)
◈ chatgpt-mcp · Architecture review · ho_8f2…91c · w2 · Processing    03:42
```

Monorepo variant: `◈ raccon-web / dashboard` (muted 12px).

Apply to: Active handoff, Working worker card, activity feed rows, Tasks table (title column), task drawer header, ⌘K results.

`type` = metadata. **Title = story.**

---

# PART C — Workers

## Card answers 3 questions

Who (`w1`) · state + one sentence · capacity + last activity

**Ready:** calm, “Ready for handoffs”, capacity bar, last activity  
**Working:** title + repo + ho_ id + live elapsed `03:42` + optional thin blue activity rail on left edge  
**Action required:** pale amber tint, one-line note — **no Continue on card if alert visible**  
**Starting:** blue pulse dot + `Creating ChatGPT chat… · Step 2 of 4 · Binding browser tab`  
**Offline:** slight desaturate + Reconnect in drawer  
**Disabled:** muted card

## Capacity (no alert fatigue)

| Used | Bar | Text |
|------|-----|------|
| 0–15 | neutral | — |
| 16–17 | neutral | Approaching capacity |
| 18–19 | amber | Rotate soon |
| 20 | amber/red | Rotation required · [New chat] |

## Overflow menu (grouped, context-sensitive)

```
Chat        Open ChatGPT · Assign URL · New chat · Continue* 
Worker      Disable / Enable
Recovery    Clear stuck · Recreate chat
────────────
Remove worker
```
*Continue only when Action required

## Worker drawer

- Summary sentence
- Current activity (if busy)
- Chat capacity
- **Connection ladder** (vertical connectors):

  ```
  ✓ Process → ✓ Broker → ✓ Binding → … → ✕ MCP write
              Approval required
  ```

- Broker down: `✕ Broker` then all `?` + *Broker unavailable — downstream checks unknown*
- Chat URL + Open ChatGPT
- Technical details (collapsed): PID, CDP, readiness reason

---

# PART D — Tasks

## Active handoff lifecycle

Steps: Queued → Dispatch → Processing → Complete (dots + connecting lines)

Design **3 lifecycle visual states** as separate frames:
- Mid-processing (current)
- Step completing (dot → check morph — show before/after or annotation)
- Just completed (see Part G delight)

## Task drawer

- Title + repo + type + status
- Error block (failed/timed out)
- Details table (timing)
- Vertical lifecycle timeline
- Usage: *Estimated visible-text tokens — not ChatGPT billing*
- **Fail task…** footer when Processing/Dispatching/Waiting approval
- Redacted: `[Load redacted preview]` + best-effort disclaimer
- Optional reference pricing row (off by default)

## Tasks tab

Full table: Title · Type · Repo · Worker · Status · Duration · Completed  
Filters: All / Active / Completed / Failed  
Sort indicators on columns  
Empty: *Quiet for now. New delegated tasks will show up here…*

---

# PART E — Recent handoffs = activity feed (Overview)

```
✓  Review auth architecture before v0.9 release
   ◈ chatgpt-mcp · Architecture review · w2              3m 12s

✓  Research MCP reconnect behavior
   ◈ chatgpt-mcp · Research · w1                          1m 48s

×  Investigate stale worker lease
   ◈ chatgpt-mcp · Debug analysis · w3                   Timed out
```

Not a 6-column table on Overview.

---

# PART F — Modals & flows

## Confirm modals (consequence copy)

- Recreate chat (current task preview)
- Remove worker
- Fail task
- Recover workers (system — list affected w1, w2)

## Add worker wizard

0. Choose: Create new chat / Assign URL  
1. Progress: Step 2 of 4 · Binding browser tab  
2. **Waiting for MCP approval** — no Next; timer; Open ChatGPT; gptmcp doctor; Advanced assign URL  
3. Ready ✓

## AppBar header overflow

```
Recover workers…
Refresh status
Settings…
View Diagnostics
```

---

# PART G — Motion & delight (design as frames + spec page)

Create a **Motion & Interaction** reference page in the file with:

### G1 Refresh
- Refresh icon spin 400–600ms
- `Updated 3s ago` → `Updating…`
- Changed row background flash 500–700ms
- `prefers-reduced-motion`: skip flash/particles

### G2 State transitions (show 2–3 keyframes each)
- Queued → Processing step advance
- Worker Ready → Working (dot blue morph)
- w3 Action required appears (one-shot gentle CTA highlight, not pulsing card)

### G3 Task completed choreography
Design sequence across **3 frames**:
1. Processing → green check on lifecycle
2. Toast bottom-right: `✓ Review auth… completed · 3m 12s · w2`
3. Optional: 8–12 tiny particles near check (~450ms) — subtle, not fireworks
4. Active handoff area empty / collapsed; new row appears at top of activity feed (show arrow annotation: “FLIP / travel to history”)

### G4 Drawer & tabs
- Drawer slide-in 180–220ms (ease-out)
- Tab pill slides between Overview/Tasks/Diagnostics
- Modal scale/fade 150–200ms

### G5 Micro-interactions (show one example each)
- Copy → `Copied ✓` morph on command rows
- Destructive confirm shake on invalid dismiss (optional)
- Optimistic toggle: Disable worker → card muted immediately (annotation)

---

# PART H — Command palette ⌘K (full frame)

Raycast-style centered palette:

```
⌘  Search tasks, workers, repos, commands…

  ↳ Review auth architecture before v0.9     Task · w2 · processing
  ↳ w3 · Action required                   Worker
  ↳ chatgpt-mcp                            Repo · 3 active tasks
  ↳ Add worker                             Action
  ↳ Recover workers…                       Action
  ↳ Open w2 in ChatGPT                     Action
  ↳ Copy health curl                       Command
  ↳ Go to Diagnostics                      Navigation
  ↳ Switch theme…                          Settings
```

Show: empty state, results state, no-results state.  
Footer hint: `↑↓ navigate · ↵ open · esc close`

---

# PART I — Themes (full frames)

Header: sun/moon icon cycle or Settings panel.

**Settings / Appearance:**
- ○ System  ● Light  ○ Dark  ○ Dim

Design **4 complete Overview frames** (same data, different tokens):
1. **Light** (default — current)
2. **Dark** — deep neutral `#0F0F12` page, `#1A1A1F` surfaces, same semantic accents
3. **Dim** — softer dark, lower contrast than Dark
4. **System** — note: follows OS (show Light frame + badge)

Semantic colors unchanged across themes: green ready, blue working, amber action, red error.

**No custom color picker in v1.**

---

# PART J — Hover peek popovers (static frames)

Show popover designs (not functional):

**Hover task row:**
```
Review auth architecture before v0.9 release
ho_8f2a…91c · w2 · Processing · 3m 42s
~4.2k tokens (est.)
[Open task] [Open ChatGPT]
```

**Hover worker capacity:**
```
16 of 20 handoffs on this chat
Approaching capacity — rotate at 18
```

**Hover strip Last tick:**
```
Status API refreshed 8s ago
Next poll in ~2s
```

---

# PART K — Keyboard & power-user hints

Small persistent hint in Tasks tab footer or Help in Settings:

```
j/k or ↑↓  navigate rows
Enter      open drawer
Esc        close drawer / palette
⌘K         command palette
⌘R         refresh
```

Design **Tasks tab** with one row focused (subtle outline).

---

# PART L — Empty & quiet states

| State | Copy |
|-------|------|
| No workers | **No workers yet.** Add a ChatGPT worker… [+ Add worker] · Advanced: Assign URL |
| No tasks | **Quiet for now.** New delegated tasks will appear when a worker claims them. |
| Fleet ready | **✓ Fleet ready** · Waiting for the next handoff. (tiny 24px glyph OK) |
| ⌘K no results | No matches for "foo" · Try task id, worker, or repo name |

---

# PART M — Scenario frames (complete set)

Produce **one desktop frame (1440×900)** for each:

| # | Scenario |
|---|----------|
| 1 | **Primary** — busy + w3 MCP (hero: Everything is moving) |
| 2 | All clear — 3 ready, no alert |
| 3 | Broker offline — banner + ladder |
| 4 | STALE strip only |
| 5 | SESSION_LOST w2 |
| 6 | chatAccessDenied w1 |
| 7 | Worker w4 Starting |
| 8 | API unreachable full page |
| 9 | Empty workers setup |
| 10 | Task completion delight (mid-sequence) |
| 11 | ⌘K open with results |
| 12 | Dark theme Overview |
| 13 | Settings / Appearance |
| 14 | Hover peek examples (composite) |
| 15 | Recover workers modal |
| 16 | Fail task modal |

---

# PART N — Diagnostics (complete)

Order:
1. Quick commands (copy)
2. System topology table (Worker · State · Chat URL · Budget)
3. Connection model reference ladder
4. Endpoints: Status `127.0.0.1:8787` · Broker ops `127.0.0.1:18788`
5. Raw topology JSON ▸ collapsed

---

# Mock data

**Workers:** w1 Ready 12/20 · w2 Working 16/20 · w3 Action required 6/20 · w4 Starting (frame 7)

**Titles (use consistently):**
- Review auth architecture before v0.9 release (w2, active)
- Research MCP reconnect behavior (w1, completed)
- Investigate stale worker lease (w3, timed out)
- Fix MCP approval recovery flow (feed)

**Repo:** `◈ chatgpt-mcp` everywhere unless monorepo demo row

**Commands:**
```
gptmcp start
gptmcp doctor
gptmcp status
curl -s http://127.0.0.1:8787/health | jq
./scripts/start-broker-stack.sh
```

**Version badge:** `dashboard 1.0 · v{packageVersion}` placeholder

---

# Master deliverables checklist

Copy into Make as completion gate:

### Structure & semantics
- [ ] All Part M scenario frames (16)
- [ ] Causal ladder + broker downstream suppression
- [ ] Deduped MCP (alert yes, card no Continue)
- [ ] Activity feed on Overview; table on Tasks

### Identity & craft
- [ ] Task title + repo on all task surfaces
- [ ] Hero copy per state
- [ ] Worker card state variants (Ready/Working/Action/Starting/Offline)
- [ ] Empty/quiet states with personality

### Flows
- [ ] All confirm modals
- [ ] Add worker wizard (4 steps)
- [ ] Fail task + Recover workers
- [ ] Redacted preview states

### Premium layer (in design, not deferred)
- [ ] ⌘K palette (3 states)
- [ ] Light + Dark + Dim theme frames
- [ ] Settings / Appearance
- [ ] Motion spec page (Parts G1–G5)
- [ ] Completion delight sequence
- [ ] Hover peek popovers
- [ ] Keyboard hints + focused row

### Polish
- [ ] `index.css` / theme tokens consistent (no stray dark body on light)
- [ ] 1440×900 desktop; responsive notes only
- [ ] Remove demo-only toggles from final frames (or isolate on "Dev" page)

---

# Sign-off question

For frames **1, 2, 5, 8, 11** — can a solo developer in **10 seconds** answer:
1. Can I handoff? (dispatch / hero)
2. What is running and **why**? (title + repo)
3. What needs me? (one alert)
4. What would I press? (primary CTA or ⌘K)

If **yes** on all five → design-complete. Engineering may port React.

---

# Backend note (for repo README — not blocking Figma)

Mock fields until API ships: `displayTitle`, `repoName`. See [backend-craft-backlog.md](./backend-craft-backlog.md).
