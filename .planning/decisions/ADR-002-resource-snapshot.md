# ADR-002 — Resource snapshot at create

**Status:** Superseded by [ADR-008](./ADR-008-dispatch-time-materialization.md) (v0.7)  
**Date:** 2026-08-29

## Decision (historical — v0.6)

Task file evidence was **immutable**: at `handoff_create_task`, selected workspace files were validated, copied to a task-scoped snapshot store, and hashed. Workers read snapshots only — never live workspace paths.

## Current (v0.7+)

See [ADR-008](./ADR-008-dispatch-time-materialization.md). Create stores refs only; dispatch materializes bytes into RAM for native attach.
