# ADR-008 — Dispatch-time resource materialization (v0.7)

**Status:** Accepted  
**Date:** 2026-09-01  
**Supersedes:** [ADR-002](./ADR-002-resource-snapshot.md) (persistent snapshot at create)

## Decision

Task file evidence is **materialized at dispatch**, not copied at create:

1. **Create:** validate path syntax, dedup, secret-shaped filenames → persist `TaskResource` refs + `workspace_root` only.
2. **Dispatch:** resolve paths under stored root, stat/read bytes, secret scan, SHA256 → ephemeral `PreparedResource` in RAM.
3. **Upload:** native CDP `setInputFiles({ name, mimeType, buffer })` — never raw workspace paths.

ChatGPT receives **workspace version at dispatch time**, not at create.

## Context

ADR-002 immutable snapshot simplified read-path races but added disk I/O at create and duplicated bytes. v0.7 product semantics prefer dispatch-time workspace truth with explicit accepted race (file may change or disappear between create and dispatch).

## Consequences

- No `snapshot-store.ts`; DB file rows keep legacy columns as placeholders on insert.
- `handoff_read_file` returns `FILE_READ_DISABLED` for tasks with attached files (Option C).
- Secret/content/size/symlink guards run at materialize (see updated [ADR-005](./ADR-005-create-time-secret-scan.md)).
- `RESOURCE_PREPARED` logs hash of bytes actually attached.

## Alternatives rejected

- Persistent snapshot at create (ADR-002) — dropped for v0.7
- Live path upload without read — bypasses secret scan and size caps
