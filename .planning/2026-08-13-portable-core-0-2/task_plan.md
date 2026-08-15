# Task Plan: Portable core 0.2.0-preview

## Goal
Ship host-neutral handoff create semantics (`clientSessionId` optional; `taskId` authoritative) as the next architecture milestone after documenting that `0.1.0-preview.1` is only partially released.

**Roadmap target:** [0.3.0 portable core](../../docs/roadmap.md#version-ladder) · ASAP UX is [0.2.0 agent UX](../../docs/roadmap.md#020--agent-ux-asap) (own feature version; not a 0.1 patch).

## Next Step
Smoke-create without session id (optional); then user can commit/tag when ready.

## Current Phase
Phase 3

## Phases

### Phase 0: Note + release audit
- [x] Read future-versions + MVP progress
- [x] Init plan `2026-08-13-portable-core-0-2`
- [x] Document release status in findings.md
- **Status:** complete

### Phase 1: Portable create API (P0)
- [x] Accept `clientSessionId` (+ deprecated `cursorConversationId`)
- [x] No throw when session omitted → `unscoped`
- [x] Cursor inject-session still works (alias)
- [x] Bump package to `0.2.0-preview.0`
- **Status:** complete

### Phase 2: Docs + skill wording
- [x] README client support + version
- [x] Architecture roles cleaned
- [x] User skill updated for scoped vs unscoped
- **Status:** complete

### Phase 3: Verify
- [x] typecheck/build
- [ ] Optional live smoke without session id
- **Status:** in_progress

## Decisions Made
| Decision | Rationale |
|----------|-----------|
| Sentinel `unscoped` instead of NULL | Avoid SQLite NOT NULL migration for preview |
| Bump to 0.2.0-preview.0 locally | Architecture boundary; 0.1 still needs tag/push of prior batch |
| Do not implement multi-worker yet | Sequencing from future-versions |

## Errors Encountered
| Error | Attempt | Resolution |
|-------|---------|------------|
| Duplicate rows in architecture Roles | 1 | Deduped table |
