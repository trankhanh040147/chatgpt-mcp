# Figma Make prompt — chatgpt-mcp Ops Dashboard 0.1 (FINAL)

Paste everything below the line into **Figma Make**.

---

Create a high-fidelity, desktop-first localhost operations console for **chatgpt-mcp Ops Dashboard 0.1**, using the product specification, layout, sample data, states, components, and constraints below; make the Healthy desktop frame the polished primary output and preserve the same information architecture across all state variants.

### 1. Product and intent

Design **chatgpt-mcp Ops Dashboard 0.1**, a localhost-only, read-only operator console for a Cursor ↔ ChatGPT handoff system.

- URL context: `http://127.0.0.1:8787/dashboard/`
- Primary user: a solo developer/operator who already runs the stack
- Primary mode: **Operate** — scan quickly, detect failure, identify the affected worker/task, and find the next diagnostic command
- This is an internal control-room surface, not a marketing site and not a generic SaaS analytics dashboard
- Desktop P0: **1440 × 900**
- Keep all critical health, worker, task, and troubleshooting information visible in the first viewport; avoid a long scrolling page
- Mobile is optional and secondary

### 2. System vocabulary and truth

Use these exact concepts and labels.

- Workers are logical browser actors on a broker attached to Chrome CDP: `w1`, `w2`, `w3`
- Handoff task IDs use the form `ho_…`
- Worker statuses: `READY`, `BUSY`, `SESSION_LOST`, `RATE_LIMITED`, `ERROR`
- Task statuses: `QUEUED`, `DISPATCHING`, `DISPATCHED`, `PROCESSING`, `WAITING_APPROVAL`, `COMPLETED`, `FAILED`, `TIMED_OUT`
- Control-plane concepts: status API, lease reaper, heartbeat freshness, process/PID health, lease owner, current task, last reap statistics
- Polling is every 2 seconds
- Version 0.1 is read-only

Do not rename these concepts to generic terms such as “agents,” “jobs,” “team members,” “campaigns,” or “projects.”

### 3. Primary 1440 × 900 composition

Use a restrained 12-column desktop grid with a maximum content width around 1360 px, 24 px outer margins, 16 px gutters, and compact vertical rhythm. The composition should read top-to-bottom in this order:

#### A. Utility header — approximately 64 px high

- Left:
  - Small eyebrow: `chatgpt-mcp · dashboard 0.1`
  - Product title: **Ops**
- Right:
  - Compact live indicator with pulse dot and label `API OK`
  - Secondary text: `Updated 09:42:16`
  - Local clock: `09:42:18 ICT`
- Keep the header operational and quiet; no hero copy, navigation sidebar, search, avatar, notifications, or primary CTA

#### B. Control plane strip — compact full-width panel

Use one low-height panel with a clear section label **Control plane** and horizontally arranged key/value groups separated by subtle dividers:

- `Health` → `OK`
- `Lease reaper` → `ON`
- `Last tick` → `8s ago`
- `Requeued` → `1`
- `Timed out` → `0`
- `Failed` → `0`

Make `Health`, `Lease reaper`, and stale tick conditions instantly scannable, but do not turn these values into oversized KPI cards.

#### C. Workers section — three cards in one row

Section header:
- Title: **Workers**
- Supporting count: `3 registered · 3 healthy`

Use exactly three equal worker cards for the Healthy frame. Cards are appropriate here because each worker is a bounded operational unit. Each card must include:

- Prominent mono worker ID: `w1`, `w2`, or `w3`
- Worker status pill
- A small health summary such as `Healthy`
- Compact two-column diagnostic rows:
  - `PID` → `48291 · alive`
  - `Heartbeat` → `fresh · 1.2s`
  - `Current task` → truncated task ID or `—`
  - `Error` → error code or `—`
- If a task ID exists, display a middle-truncated mono value such as `ho_01M047…J83YX2`; annotate that hover reveals the full ID
- Use status/health styling as the strongest signal, not decorative card artwork

Healthy sample workers:

- `w1`: `READY`, healthy, PID alive, heartbeat `fresh · 0.8s`, no current task, no error
- `w2`: `BUSY`, healthy, PID alive, heartbeat `fresh · 1.4s`, current task `ho_01M047SACSTCR99M6RH3J83YX2`, no error
- `w3`: `READY`, healthy, PID alive, heartbeat `fresh · 1.1s`, no current task, no error

#### D. Lower workspace — tasks dominant, troubleshooting secondary

Use an approximately 8/4 column split.

##### Recent tasks — left, dominant

- Section title: **Recent tasks**
- Secondary label: `Last 10`
- Dense but readable table with a sticky-looking header treatment
- Columns:
  - `Task ID`
  - `Status`
  - `Owner`
  - `Type`
  - `Age`
  - `Error`
- Show 8 rows in the Healthy frame, with compact row height around 38–42 px
- IDs, worker names, ages, and error codes use mono
- Task IDs are middle-truncated with full-ID tooltip annotation
- Status is rendered as a compact accessible pill
- Use `—` rather than blank cells
- Do not add pagination, filters, charts, bulk selection, row action menus, or “create task” controls

Use plausible sample data containing:

- `ho_01M047SACSTCR99M6RH3J83YX2` — `PROCESSING` — `w2` — `second_opinion` — `18s` — `—`
- Completed tasks owned by `w1` and `w3`
- One `WAITING_APPROVAL` task
- Remaining rows may be `COMPLETED`; keep the Healthy frame free of failures

##### Troubleshoot — right, secondary

Create one compact panel titled **Troubleshoot** with:

1. A short semantic hint list:
   - OK: `All worker heartbeats are fresh`
   - OK: `Lease reaper ticked within threshold`
   - Neutral: `Use doctor before restarting the stack`

2. A dark, high-contrast command block with four separate copy affordances:
   - `curl -s http://127.0.0.1:8787/health | jq`
   - `make doctor`
   - `npm run recover`
   - `./scripts/start-broker-stack.sh`

Copy controls should be small icon buttons with tooltip annotations, not large CTAs. The code block is the only dark surface in the light UI.

#### E. Footer metadata — one quiet line

Show:
`Polling every 2s · 127.0.0.1 only · read-only 0.1`

### 4. State variants

Create five named desktop frames/screens using the exact same layout, dimensions, component positions, and column widths. State changes should modify data and severity styling rather than rearrange the page.

#### Frame 1 — Healthy

- API OK
- Reaper ON, last tick 8s ago
- Three registered workers; all healthy
- `w1` and `w3` READY; `w2` BUSY
- Recent tasks are PROCESSING, WAITING_APPROVAL, or COMPLETED
- Troubleshoot hints are OK/neutral

#### Frame 2 — Degraded

- API remains OK
- `w2`: `ERROR`, unhealthy, PID `48294 · dead`, heartbeat `stale · 46s`, current task present, error `WORKER_PID_DEAD`
- Worker section count: `3 registered · 2 healthy`
- The affected recent task is `FAILED` and owned by `w2`
- Use warning/bad styling locally on the affected worker and task; do not flood the entire screen with red
- Hint: `w2 process is not alive; run make doctor`

#### Frame 3 — Session lost

- API remains OK
- `w3`: `SESSION_LOST`, unhealthy, PID alive, heartbeat may still be fresh, current task present, error `CHAT_SESSION_LOST`
- Make the distinction clear: the worker process exists, but its ChatGPT browser session is unavailable
- Affected task may remain `DISPATCHED` or become `TIMED_OUT`
- Hint: `w3 lost its ChatGPT session; recover the browser session before redispatch`

#### Frame 4 — API unreachable

- Header live indicator: `API DOWN`
- Show last successful update if available: `Last seen 2m 14s ago`
- Replace live control-plane values, worker cards, and task rows with a coherent console-level unreachable state inside the existing content region
- Message: `Status API is unreachable`
- Supporting text: `Cannot load control-plane, worker, or task data from 127.0.0.1:8787.`
- Keep the Troubleshoot command block visible and emphasize the health curl command
- Do not use a mascot, illustration, full-page marketing error, or generic “Something went wrong”

#### Frame 5 — Empty / first run

- API OK and control plane visible
- Workers section uses one restrained empty panel in the existing workers region:
  - `No workers registered`
  - `Start the broker stack, then wait for worker heartbeats.`
- Recent tasks table keeps its header but shows:
  - `No handoff tasks yet`
- Troubleshoot panel remains visible
- Do not add a “Create worker” button or setup wizard

### 5. Visual system

Aim for a light, industrial operations aesthetic: calm, exact, and slightly technical.

#### Color

- App background: warm stone/paper, approximately `#F3F1EC`
- Panel surface: near-white, approximately `#FBFAF7`
- Primary text: deep blue-black, approximately `#172126`
- Secondary text: muted slate, approximately `#657176`
- Border/divider: cool gray, approximately `#D8DEDC`
- Teal accent/live: approximately `#087F78`
- OK: accessible green-teal
- Warning: accessible amber/ochre
- Bad: accessible brick/crimson
- Info/processing: restrained blue
- Never rely on color alone: every status includes text and may include a simple dot/icon

#### Typography

- Display/UI sans: **Sora** or a close geometric equivalent
- Mono/data: **IBM Plex Mono** or equivalent
- Do not use Inter, Roboto, Arial, or default system UI fonts
- Use mono selectively for IDs, worker names, timestamps, ages, PIDs, error codes, and commands
- Clear hierarchy without oversized headings: title approximately 28 px, section headings 16–18 px, body 13–14 px, metadata 11–12 px

#### Shape and spacing

- Panels: subtle 1 px borders, low-elevation shadow only where necessary, 10–12 px radius
- Worker cards: 12 px radius; status can influence a thin top edge or side rail
- Pills: compact, highly legible, never pastel-on-pastel
- Tight operational spacing: 8 px base rhythm, 16–20 px panel padding
- A very subtle technical grid texture in the page background is allowed, but content must remain quiet and readable

#### Icons

- Use a consistent simple line-icon family
- Appropriate icons: activity pulse, server, clock, copy, check, warning, error
- No emoji, 3D icons, illustrations, mascots, or decorative device mockups

### 6. Components and properties

Create reusable components with named properties/variants:

- `StatusPill`
  - Domain: worker/task/system
  - Status: all exact statuses listed above
  - Size: compact/default
  - Must include text; optional dot/icon
- `WorkerCard`
  - Worker status
  - Healthy/unhealthy
  - PID alive/dead
  - Heartbeat fresh/stale
  - Current task present/empty
  - Error present/empty
- `ControlPlaneKV`
  - Label, value, severity
- `TaskTable` and `TaskRow`
  - Task status and error/no-error variants
- `HintItem`
  - OK/warn/bad/neutral
- `CommandRow`
  - Command text and copy affordance
- `ConsoleEmptyState`
  - API unreachable / no workers / no tasks

Name color and text styles for engineering handoff, for example:
- `surface/app`, `surface/panel`, `text/primary`, `text/secondary`, `border/default`
- `status/ok`, `status/warn`, `status/bad`, `status/info`
- `type/title`, `type/section`, `type/body`, `type/meta`, `type/mono`

### 7. Interaction annotations

- Auto-refresh data every 2 seconds; communicate this with a small live pulse and updated timestamp
- Do not use a giant refresh button
- On hover, a truncated task ID reveals the complete value
- Copy buttons provide brief `Copied` feedback
- Table rows may use a restrained hover state but are not navigational in 0.1
- Status pills must remain readable at compact size and meet accessible contrast
- Preserve keyboard focus treatment for copy controls and any tooltip trigger
- No mutating actions anywhere in the UI

### 8. Hard anti-patterns and scope boundaries

Do not produce:

- A marketing hero, product pitch, pricing, testimonial, onboarding carousel, or large logo
- Sidebar navigation, account menu, team switcher, global search, or notification center
- Charts, sparklines, time-series history, gauges, or fake analytics
- Login, SSO, permissions, multi-user concepts, or cloud-region selectors
- Worker/task creation, retry, restart, kill, approve, edit, delete, or bulk-action controls
- A create-worker wizard or chat transcript viewer
- Dark-mode default or a dark-theme toggle
- Purple gradients, neon glow, glassmorphism, excessive shadows, or card-everywhere composition
- Cream/terracotta/serif editorial styling
- Newspaper-like hairline columns
- Generic lorem ipsum, generic “Agent 1” labels, or fake business metrics
- Horizontal scrolling at 1440 × 900

### 9. Deliverables

Produce:

1. One polished **Healthy** desktop frame at 1440 × 900
2. Four same-layout desktop variants: **Degraded**, **Session lost**, **API unreachable**, and **Empty**
3. The reusable component set and state properties specified above
4. Named color and typography tokens for engineering handoff
5. Interaction annotations for live polling, task-ID tooltip, copy feedback, and accessibility
6. Optional 390 px mobile adaptation only after the five desktop frames are complete; do not let mobile compromise the desktop console

The final result should feel like a credible local operations console that a developer could keep open beside a terminal: fast to scan, dense without being cramped, and visibly specific to chatgpt-mcp.
