# Findings — docs organization audit

## Verdict

**Yes — planning-with-files is in use.** Durable docs mostly under `docs/`; version SSOT was wrongly in `.planning/`. Fixed: **`docs/roadmap.md`** is sole version authority. Auto-trigger MCP + auto-adjust thinking effort = **0.2.0** (own feature release; minors reserved for bugfix).

## ChatGPT handoff (`ho_01KZWC1XXW1W7YEGWFE76YJY3J`) — evaluation

| Claim | Judgment |
|-------|----------|
| Two-layer: `docs/` product truth vs `.planning/` execution memory | **Accept** — matches planning-with-files + user intent |
| Single `docs/roadmap.md` SSOT; stub future-versions | **Accept** — implemented |
| Do not move session plans into `docs/` | **Accept** |
| Insert Cursor-first agent UX as full version | **Accept, renumbered** — user: no `0.N.x` feature buckets → **0.2.0** agent UX, portable core → **0.3.0** |
| Auto-trigger/effort = skill/rule, not core chooser | **Accept** — server cannot infer host difficulty |
| Add `operations.md` | **Defer** — troubleshooting already compact in README; avoid empty file |
| Restructure `benchmark/results/<version>.md` | **Defer** — out of scope for this pass; keep `results.md` |
| Minimal docs index | **Accept** — added thin `docs/README.md` |

## Implemented this session

- `docs/roadmap.md` — version ladder + ASAP features + decision log
- `docs/README.md` — index
- `.planning/2026-08-13-future-versions.md` → tombstone
- `.planning/README.md` — contract
- Pointers from README, MVP plan header, portable-core goal

## Policy (agents)

At session start: `.active_plan` → `progress.md` → `task_plan.md` → `docs/roadmap.md` → only the relevant durable contract. Promote stable truth to `docs/`; keep WIP in `.planning/`. Never duplicate roadmap outside `docs/roadmap.md`.
