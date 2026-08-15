# Revised MVP — fast · easy · benchmark proof

> Historical execution plan. Current version scope and exit criteria: [docs/roadmap.md](../../docs/roadmap.md).

**Date:** 2026-08-12  
**Handoff:** `ho_01KZV6SPJ24GRE68VJV5B7AGVQ`  
**Supersedes emphasis of:** prior “heavy P0 before any public tag” plan

## Product definition

> macOS developer preview: install in ≤15 min, one reliable handoff, publishable A/B vs agent-only.

| Goal | Evidence |
|------|----------|
| Fast release | Public repo (pre-release) in 1–2 days after secret scrub |
| Easy use | `setup` / `start` / `check`; ≤15 min fresh tester |
| Show value | 5-task A/B benchmark on README (incl. null control) |

## Ship bar (split)

1. **Public source soon** — license, no secrets/author paths, limitations, pre-release label.  
2. **Evidence-backed launch (`v0.1.0-preview`)** — 20-run transport ≥18 + benchmark table + quickstart proven by strangers.

## Must-have (this week)

- Live E2E on HEAD + 20-run harness  
- Portable `~/.chatgpt-mcp` (or env), loopback bind, LICENSE  
- `npm run setup|start|check` + generated Cursor MCP JSON  
- One tunnel story (Secure MCP Tunnel preferred; ngrok fallback warned)  
- Benchmark suite frozen before scoring: T1–T5 (architecture, debug, review, research, **null refactor**)  
- Honest limitations / no fake % claims  

## Defer

Marketplace, Windows/Linux, OAuth/hosted relay, dashboard, multi-worker, polished global CLI.

## Benchmark (Arm A vs Arm B)

- **A:** Cursor agent only  
- **B:** same + exactly one predeclared chatgpt-mcp handoff  
- 5 tasks × 2 arms × 2 reps = 20 runs; blinded quality 0–100; report time + human edits  
- Win bar (directional): B quality ≥+10 pts or +15% relative; B wins ≥4/5 tasks; disclose T5 may be neutral/worse  

## 7-day order

1. ~~Live E2E → 20-run harness backbone~~ (10/10 PASS accepted)
2. ~~Scrub + portable paths + LICENSE~~ (`setup`/`check`/`CHATGPT_MCP_HOME`)
3. ~~setup/start/check + timing protocol~~ (`npm run start`; docs/onboarding-timing.md; stranger slots open)
4. ~~Freeze benchmark fixtures/prompts/rubric~~ (`docs/benchmark/` bench-v1)
5–6. Run + blind score ← **next** (20 runs; do not invent README table)
7. Publish table + tag only if numbers exist

## Critical note

Do not claim “MCP makes coding X% better” in general — claim only the measured workflow on the five tasks. Plus may still be write-limited in practice; keep plan gating honest in docs.
