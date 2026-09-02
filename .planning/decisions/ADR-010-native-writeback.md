# ADR-010 — Native writeback (result artifacts)

**Status:** Accepted  
**Date:** 2026-09-02

## Context

v0.7 shipped inbound native attach (Cursor → ChatGPT). v0.8 adds symmetric outbound writeback via `handoff_submit_result({ artifacts[] })`.

External architecture review (`ho_01M1FDP9…`) identified:

- Sequential artifact writes could mutate disk before task rejection
- Create-mode TOCTOU via `existsSync` + rename
- MCP error surfacing insufficient for model self-correction
- Worker policy must not duplicate runtime validation rules

## Decision

### Hybrid transport

- **Full-file artifacts** for complete final UTF-8 content (`create` | `overwrite`)
- **Prose-only `result`** when the worker cannot safely produce complete final content
- **Large ≠ partial** — size alone does not force prose-only if content fits caps

### Contract layers

| Layer | Role |
|-------|------|
| MCP schema | Structural shape (`artifacts[]`, `mode`, `maxItems: 20`) |
| Runtime (`writeResultArtifacts`) | Security, byte caps, state-dependent rules, batch commit + rollback |
| Tool description | Capability + limits visible to model |
| `submitPolicy.writeback` | Per-task behavioral decision guidance |
| This ADR + spec | Full normative semantics |

### Transaction semantics (pragmatic v0.8)

1. **Validate all** artifacts before any target mutation
2. **Commit batch** — create via `open('wx')`; overwrite via temp + rename with in-memory backup
3. **Rollback on handled commit failure** before returning error

**Guaranteed:**

- Validation failure → **zero target mutations**
- Handled commit failure → **rollback attempted** before error returned
- Task stays non-COMPLETED on any artifact error

**Not guaranteed:**

- Process crash mid-commit
- Rollback failure (disk/permissions)
- Hostile concurrent filesystem mutation

Do not describe v0.8 as absolute filesystem transactions.

### Create collision

- `create` on existing path → reject
- Model must **not** auto-retry as `overwrite`

### MCP errors

- Correctable validation/business errors → tool result `isError: true` + stable code + safe path
- Unexpected I/O → generic internal failure
- Never leak artifact content/secrets in errors

## Alternatives rejected

| Alternative | Reason |
|-------------|--------|
| Unified diff / `apply_patch` RPC | Extra privileged surface; prose-only partial edits sufficient for P0 |
| ZIP batch ingest (P0) | Deferred 0.8.1+ |
| `handoff_read_file` for verify | Conflicts with native workspace model |
| Auto-routing attach ↔ MCP | ADR-003 forbidden |
| Blind overwrite default | `create` must remain safe default |
| Absolute all-or-nothing FS guarantee | Requires journal/snapshot — out of scope P0 |

## Consequences

- Phase 1: transactional `writeResultArtifacts` + tests proving validation/rollback
- Phase 3: MCP Writeback Contract (`WRITEBACK_POLICY`, `isError`, annotations)
- E2E must verify disk bytes + manifest sha256
- Full-body secret scan (≤32 MiB) symmetric with inbound materialize

## References

- [0.8-native-writeback-spec.md](../active/0.8-native-writeback-spec.md)
- [ADR-003](./ADR-003-resource-transport.md)
- [ADR-005](./ADR-005-create-time-secret-scan.md)
