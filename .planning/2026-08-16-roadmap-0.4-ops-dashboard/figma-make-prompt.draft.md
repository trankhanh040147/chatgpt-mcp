# Figma Make prompt — chatgpt-mcp Ops Dashboard 0.1 (DRAFT)

Use this with **Figma Make** to generate a high-fidelity desktop UI design. This is a **local ops tool**, not a marketing site.

---

## Product

**chatgpt-mcp Ops Dashboard 0.1** — a localhost-only operator console for a Cursor ↔ ChatGPT handoff system. Operators monitor multi-worker browser automation (leases, heartbeats, task queue) and troubleshoot stuck/idle/session-lost workers without digging through terminal logs.

URL context: `http://127.0.0.1:8787/dashboard/` (served by a local status API).

## Audience & mode

- Audience: solo developer / operator who already runs the stack
- Mode: **Operate** (scanability, status clarity, fast diagnosis)
- Density: information-forward, calm, precise — not playful marketing

## Primary jobs (one screen, desktop-first 1440×900)

1. See control-plane health at a glance (API up, lease reaper last tick)
2. Scan all workers: id, status, healthy/unhealthy, heartbeat freshness, active task, error code
3. Scan recent tasks: id suffix, status, lease owner, type, age, error
4. Read short troubleshoot hints + copyable CLI commands

## Screen layout (required sections)

### Header
- Product mark / title: **Ops** with eyebrow `chatgpt-mcp · dashboard 0.1`
- Live status pill: API ok / down
- Local clock (secondary)

### Control plane panel
- Key/value: health, reaper on/off, lastReapAt, last reaper stats (requeued / timedOut / failed)

### Workers
- Responsive card grid (or dense table — prefer cards for ≤6 workers)
- Per worker: `w1` / `w2` / `w3`, status pill (READY / BUSY / SESSION_LOST / ERROR / RATE_LIMITED), healthy yes/no, pid alive/dead, heartbeat fresh/stale + age, current task id (truncated), error code

### Recent tasks
- Table: id (truncated), status pill, owner, type, created age, error
- ~8–12 rows visible without feeling like a spreadsheet wall

### Troubleshoot
- Bullet hints (ok / warn / bad semantic colors)
- Dark code block with copyable commands, e.g.:
  - `curl -s http://127.0.0.1:8787/health | jq`
  - `make doctor`
  - `npm run recover`
  - `./scripts/start-broker-stack.sh`

### Footer
- Tiny meta: `Polling every 2s · 127.0.0.1 only · read-only 0.1`

## Data states to design (variants / frames)

1. **Healthy** — 3 workers READY, recent COMPLETED tasks, green hints
2. **Degraded** — 1 worker heartbeat stale / pid dead, warn pills
3. **Session lost** — one worker SESSION_LOST with clear cue
4. **API unreachable** — empty/error state for the whole console
5. **Empty** — no workers registered yet (first-run)

## Visual direction (hard constraints)

- One coherent composition for the first viewport (ops console, not a SaaS marketing dashboard collage)
- **Light** industrial ops aesthetic (not dark-mode default)
- Warm paper / stone background with cool teal accent — **not** purple gradients, not cream+terracotta+serif brochure look, not newspaper hairline columns
- Typography: distinctive pair — display + mono (e.g. Sora / IBM Plex Mono or equivalent). Avoid Inter, Roboto, Arial, system UI defaults
- Status color system: ok / warn / bad — high contrast, accessible
- Soft panels, subtle grid texture OK; no glassmorphism soup, no neon glow, no emoji
- Cards only where they group a worker unit; avoid card-everywhere
- Generous but tight ops spacing; mono for IDs/times/commands

## Interaction notes (for Make annotations)

- Auto-refresh every 2s (show “live” affordance, not a giant refresh button)
- Read-only in 0.1 — no primary “Create worker” CTA in the header
- Truncate long task IDs; full id on hover/tooltip annotation
- Status pills must remain readable at small size

## Deliverables from Figma Make

1. Desktop frame 1440×900 (or 1280×800) for **Healthy** state
2. Same layout variants: Degraded, Session lost, API down, Empty
3. Component set: status pill, worker card, KV row, data table, hint list, command block
4. Color + type tokens named for handoff to engineering
5. Optional: compact mobile 390 width (secondary; desktop is P0)

## Out of scope (do not invent)

- Login / SSO / multi-user
- Charts / time-series history
- Create-worker wizard UI
- Chat transcript viewer
- Dark theme toggle (v0.1)
- Marketing hero, pricing, or empty illustration mascots

## Engineering truth (keep labels accurate)

Workers are logical actors (`w1`…) on a broker attached to Chrome CDP. Tasks are handoff IDs like `ho_…`. Statuses include QUEUED, DISPATCHING, DISPATCHED, PROCESSING, WAITING_APPROVAL, COMPLETED, FAILED, TIMED_OUT, plus worker statuses READY, BUSY, SESSION_LOST, RATE_LIMITED, ERROR.
