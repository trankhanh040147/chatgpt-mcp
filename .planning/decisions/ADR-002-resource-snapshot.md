# ADR-002 — Resource snapshot at create

**Status:** Accepted  
**Date:** 2026-08-29

## Decision

Task file evidence is **immutable**: at `handoff_create_task`, selected workspace files are validated, copied to a task-scoped snapshot store, and hashed. Workers read snapshots only — never live workspace paths.

## Context

Early implementation (`ce12aef`) stored metadata + live `sourcePath` with hash check at read time (`FILE_CHANGED_REATTACH` on mutation). That fails reproducibility if Cursor edits files during ChatGPT reasoning.

Secret-content scan before snapshot: [ADR-005](./ADR-005-create-time-secret-scan.md) — native attach bypasses MCP read-time sanitize.

## Consequences

- Snapshot store under `{HANDOFF_DB_PATH dir}/resource-snapshots/{taskId}/{fileId}`
- `handoff_read_file` reads snapshot bytes
- Workspace changes after create do not affect in-flight tasks
- Transport adapters (native attach, context-pack) read from snapshot store, not workspace

## Alternatives rejected

- Live workspace read with hash fence — race on long reasoning passes
- ZIP as canonical storage — opaque; poor lazy access (see ADR-003)
