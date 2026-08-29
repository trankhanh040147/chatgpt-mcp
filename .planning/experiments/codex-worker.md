# Experiment — Codex CLI worker

**Status:** SPIKE (verdict **D**) · **Not a version slot**

**SSOT:** [docs/codex-cli-worker.md](../../docs/codex-cli-worker.md)  
**Findings:** [.planning/2026-08-24-codex-cli-worker-spike/findings.md](../2026-08-24-codex-cli-worker-spike/findings.md)

## Summary

`codex exec` is a cleaner transport (localhost MCP, one-shot, no CDP) but shares Work/Codex credit pool concerns. Production stays **Chat + Cursor** until live credit/concurrency spike (`n=3`) proves sustainability.

## Relation to 0.6

Codex worker can reuse `handoff_read_file` task-scoped evidence. Do **not** replace with Codex workspace repo access.

## Exit

Production adoption requires new ADR + roadmap slot — not before Chat path resource transport is proven.
