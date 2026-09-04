# ADR-003 — Resource transport selection

**Status:** Accepted  
**Date:** 2026-08-29 (updated 2026-09-03 — tar.zst packing)

## Decision

**Agent chooses context; runtime chooses transport.**

| Transport / adapter | Role |
|-----------|----------------|
| `NativeAttachmentTransport` | **Production ship bar** — guaranteed delivery as model input |
| tar.zst pack (v0.9) | **Packing adapter on the native path** — one `.tar.zst` chip inbound; optional `archive` ingest outbound. Not a transport. See [ADR-011](./ADR-011-zstd-pack.md). |
| `McpResourceTransport` (tool façade) | Shipped; **not** production substitute for attach |
| `ContextPackTransport` | Post-0.9 experiment |
| ZIP | Superseded as ship container by tar.zst (ADR-011) |

**No silent fallback:** if native attach fails → fail closed. Do **not** auto-route to MCP read.

Rationale: v0.6 goal is *runtime guarantees selected resources are delivered*, not merely that ChatGPT *can* pull them via tool. Native attachment makes files direct turn input; MCP lazy read is pull-based and model-dependent. v0.9 packs many `files[]` into one native chip without changing that contract.

Automatic routing deferred until post-0.6 benchmark evidence.

## Consequences

- E2E must prove native path with nonce — not MCP read (see active spec).
- `handoff_read_file` stays for Codex spike / experiments; web worker ship bar = attach.

## Open questions (post-0.6)

- MCP Resource primitive (`ResourceLink`) reliability on ChatGPT host
- Context-pack vs N native chips for many small files
