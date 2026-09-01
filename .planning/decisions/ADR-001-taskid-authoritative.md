# ADR-001 — taskId authoritative

**Status:** Accepted  
**Date:** 2026-08-13

## Decision

Server-generated `taskId` (`ho_…`) is the sole correlation key for handoff lifecycle. Host session ids (`clientSessionId` / `cursorConversationId`) are optional UX sugar for Cursor auto-resume.

## Evidence

Portable core shipped in 0.5.x codebase; unscoped create works for manual poll hosts.

## Consequences

- Non-Cursor hosts poll by `taskId` without stop hooks.
- Hooks enhance UX but are not required for correctness.
