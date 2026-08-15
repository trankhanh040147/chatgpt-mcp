# Benchmark suite (frozen) — Cursor alone vs Cursor + chatgpt-mcp

**Status:** fixtures and rubric frozen · **scores pending** (do not invent README numbers)  
**Version:** `bench-v1` · **Date frozen:** 2026-08-13

## Thesis under test

On tasks where an independent ChatGPT pass helps (review, research, architecture, hard debug), **Arm B** (Cursor + exactly one predeclared chatgpt-mcp handoff) improves outcome quality vs **Arm A** (Cursor agent only). **T5** is a null-control refactor where B may be neutral or worse.

## Design

| Item | Rule |
|------|------|
| Arms | **A** = agent only · **B** = agent + **exactly one** handoff at the declared step |
| Tasks | T1–T5 (see `tasks/`) |
| Reps | 2 per arm per task → **20 runs** |
| Model | Same Cursor model/settings for A and B within a pair |
| Repo under test | This repository at a **tagged commit** (record SHA) |
| Blinding | Score transcripts with arm labels stripped; scorer ≠ operator when possible |
| Win bar (directional) | B quality ≥ +10 pts absolute **or** +15% relative vs A; B wins ≥4/5 tasks; disclose T5 |

## Scoring (0–100)

See [rubric.md](rubric.md). Record wall time to “done enough to ship/PR”, and count human fix-up edits after the agent stops.

## How to run

1. Pin commit SHA and Cursor model in [results.md](results.md).
2. For each task × arm × rep, copy the **operator prompt** from `tasks/Tn.md`.
3. Arm B: create the handoff **only** at the step marked `HANDOFF_POINT` (one `handoff_create_task`).
4. Save raw outputs under `logs/benchmark/` (gitignored) or attach privately.
5. Blind-score with the rubric; fill [results.md](results.md).
6. Publish a README table **only** after results.md is complete.

## Task index

| ID | Type | Expect B helpful? |
|----|------|-------------------|
| [T1](tasks/T1-architecture.md) | Architecture | Yes |
| [T2](tasks/T2-debug.md) | Debug | Yes |
| [T3](tasks/T3-review.md) | Code review | Yes |
| [T4](tasks/T4-research.md) | Current research | Yes |
| [T5](tasks/T5-null-refactor.md) | Null control | Neutral / maybe worse |
