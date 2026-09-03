# Figma Make — craft + semantics pass (handoff prompt)

Paste below into the existing Make file.  
**Keep** current light visual system (Instrument Sans, JetBrains Mono, Tailwind v4, calm surfaces).

This pass combines:
- Remaining **semantics gaps** from [design-review-v2.md](./design-review-v2.md) (v3)
- **Craft / identity** improvements from product review (titles, hero copy, activity feed)

**Out of scope for Make frames** (engineering / later versions): full motion implementation, ⌘K wiring, theme engine, live timers, hover popovers as functional code.  
**Show as static frames or notes** where helpful.

---

## Product principle (unchanged)

> Design around **causal state**, not independent badges.  
> Overview = operational decisions. Drawer / Diagnostics = technical detail.  
> **Calm at rest → alive when something happens → clear when action is required.**

Do not add gradients, glassmorphism, or decorative glow. Craft = typography, copy, hierarchy, and **intentional static motion specs** (annotations), not flashy UI.

---

## P0 — Figma must show (static frames)

### 1. Task title as semantic anchor

Today UI shows only **type** (`Architecture review`). Change hierarchy to:

**Active handoff / worker busy / recent row:**

```
Review auth architecture before v0.9 release     ← task title (primary, 15–16px semibold)
Architecture review · ho_8f2…91c · w2 · Processing    03:42
```

**Worker card (Working):**

```
w2 · Working
Review auth architecture before v0.9 release
◈ chatgpt-mcp
ho_8f2…91c                              03:42
```

`type` becomes secondary metadata. Title is what the operator remembers.

> **Backend note (implement later):** derive title from `context.objective`, first line of redacted prompt, or new optional `displayTitle` on task create. Until API ships, **use realistic mock titles** in Make.

---

### 2. Project / repo label (small, neutral)

Add a **repo/project line** under task title — not a colored pill:

```
◈ chatgpt-mcp
```

Optional monorepo: `raccon-web / dashboard` (muted, 12px).

Show on: active handoff, working worker card, recent activity rows.  
**Hide branch/path on Overview** — those go in task drawer only.

> **Backend note:** `workspaceRoot` exists on tasks today but is **not** in list API. Later: expose `repoName` (basename of workspace) on `GET /tasks`. Mock in Make for now.

---

### 3. Hero / dispatch-readiness line (personality + semantics)

Between **control plane strip** and **contextual alert**, add a short hero line (~22–24px semibold) + subline:

| State | Hero | Subline |
|-------|------|---------|
| Healthy + busy | **Everything is moving.** | 2 workers available · 1 handoff processing |
| Action required | **One thing needs you.** | w3 is waiting for MCP write approval |
| All clear | **All clear.** | 3 workers ready for handoffs |
| Broker down | **Handoffs are blocked.** | Broker control plane unreachable |
| Setup | **No workers yet.** | Add a ChatGPT worker to start accepting handoffs |

Also keep factual dispatch line when useful: `2 of 3 workers dispatch-ready` (muted, can merge into subline).

---

### 4. Dedupe incidents on Overview

When inline alert shows MCP approval for w3:
- **Alert:** full message + Open ChatGPT + Continue
- **w3 card:** status + one-line note — **no Continue button** on card
- **Drawer:** full actions OK

Add **all-clear frame** (3 ready workers, no alert).

---

### 5. Recent handoffs → compact activity feed (Overview only)

On **Overview**, replace wide 6-column table with scannable **activity feed**:

```
✓  Review auth architecture before v0.9 release
   ◈ chatgpt-mcp · Architecture review · w2              3m 12s

✓  Research MCP reconnect behavior
   ◈ chatgpt-mcp · Research · w1                          1m 48s

×  Investigate stale worker lease
   ◈ chatgpt-mcp · Debug analysis · w3                   Timed out
```

Keep full **table + filters** on **Tasks** tab (database / inspection mode).

Footer: `View all tasks →`

---

### 6. Remaining semantics frames (from v3)

Still required — one frame each:

- Broker offline banner (strip OK, overview trusted)
- STALE strip (`● STALE · Last tick 42s ago`) — no extra alert
- SESSION_LOST alert + Recreate chat
- chatAccessDenied + Assign URL
- Worker **Starting** card with step text
- Task drawer **Fail task** footer (Processing tasks)
- AppBar **Recover workers** modal (system blast radius)
- Task drawer **Load redacted preview** when content mode on

---

## P1 — Annotate for engineering (not full animation in Make)

Add a **Motion & interaction** spec page or sidebar notes. Do not build Lottie/video — describe behavior:

### Refresh
- Icon spin 400–600ms
- `Updated 3s ago` → `Updating…` crossfade
- Changed rows: subtle background flash 500–700ms
- Delay spinner 150–300ms; respect `prefers-reduced-motion`

### Lifecycle
- Step dot: pending → active pulse → completed check
- Connector fill left-to-right
- Ready → Working: status dot color morph

### Task completed (delight, restrained)
1. Processing → green check
2. Light card glow 300ms
3. Small particle burst ~8–12 dots, 450–600ms (optional frame)
4. Toast: `✓ Review auth… completed · 3m 12s · w2`
5. Active block collapses / FLIP toward Recent feed

### Worker card “alive” (annotate)
- **Working:** live elapsed (engineering); optional thin activity rail
- **Action required:** gentle one-shot attention on CTA, not pulsing whole card
- **Starting:** shimmer or 3-step text sequence
- **Offline:** slight desaturate

### Micro (engineering backlog)
- Copy → Copied morph
- Drawer spring 180–220ms, Escape closes
- Tab pill motion
- Optimistic enable/disable
- ⌘K command palette (see P2)

---

## P2 — Later versions (do NOT block dash 1.0 sign-off)

Document as roadmap notes only:

| Feature | Version | Notes |
|---------|---------|-------|
| ⌘K command palette | 1.1 | Search repo + title + ho_ id + worker |
| System / Light / Dark theme | 1.1 | Header icon; no custom palettes v1 |
| Hover peek popovers | 1.1 | Task + worker + capacity tooltips |
| `j/k` keyboard nav | 1.1 | Tasks tab |
| URL-encoded filters | 1.1 | Tasks tab |
| Undo for recoverable ops | 1.2 | |

---

## Mock data (update all frames)

Workers: `w1`, `w2`, `w3` (never A1/A2/A3).

| Worker | State | Title context |
|--------|-------|---------------|
| w1 | Ready | — |
| w2 | Working | **Review auth architecture before v0.9 release** · ◈ chatgpt-mcp · 16/20 approaching |
| w3 | Action required | MCP write approval · 6/20 |

Commands (real only):

```
gptmcp start
gptmcp doctor
gptmcp status
curl -s http://127.0.0.1:8787/health | jq
./scripts/start-broker-stack.sh
```

Broker ops: `127.0.0.1:18788`

---

## Deliverables checklist

**P0 frames**
- [ ] Task title + repo label on active handoff, worker card, activity feed
- [ ] Hero copy variants (moving / needs you / all clear / blocked / setup)
- [ ] Activity feed on Overview; table stays on Tasks
- [ ] All-clear Overview + deduped w3 card
- [ ] v3 semantics frames (broker, STALE, SESSION_LOST, assign URL, starting, fail task, recover, redacted)

**P1 annotations**
- [ ] Motion spec notes (refresh, lifecycle, completion, reduced-motion)

**Do not**
- [ ] Re-darken the UI
- [ ] Add permanent sidebar
- [ ] Replace ops semantics with vanity KPIs
- [ ] Block on backend fields — mock titles/repo until API exists

---

## Review question

On the **healthy+busy** frame, can an operator in 10 seconds answer:
1. What handoff is running and **what it is about** (title)?
2. Which **repo** it belongs to?
3. What to do about w3 (one place only)?

If no — simplify before sign-off.
