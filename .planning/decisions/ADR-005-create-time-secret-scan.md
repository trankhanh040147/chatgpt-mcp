# ADR-005 — Create-time secret content scan

**Status:** Accepted  
**Date:** 2026-08-29

## Context

v0.6 adds **native attachment**: snapshot bytes upload directly to ChatGPT, bypassing `handoff_read_file()` → `sanitizeSecrets()` on the MCP path.

Filename denylist (`SECRET_NAME_RE`) and read-time sanitize are insufficient:

```ts
// src/config.ts — allowed extension, not secret filename
const OPENAI_API_KEY = "sk-...";
```

would snapshot and attach raw.

## Decision

Scan file **content** for secrets **before snapshot**, using the same pattern set as `sanitize.ts` (`SECRET_PATTERNS`). On match:

```text
throw HandoffFileError("FILES_SECRET_DETECTED", ...)
```

Reject the **whole** create — no partial task, no text-only fallback.

Read-time `sanitizeSecrets()` remains defense-in-depth for MCP lazy read.

## Scope (v0.6)

Reuse existing patterns:

- `sk-…`, `ghp_…`, PEM blocks, `Bearer …`, `password=`, `secret=`

Not a full secret scanner product — no entropy/heuristic beyond shared patterns.

## Consequences

- v0.6 single PR Phase A: `scanSecretsInBuffer()` in `files.ts` / shared with `sanitize.ts`
- Document as **best-effort secret-content guard**, not DLP guarantee

## Alternatives rejected

- Read-time only sanitize — bypassed by native attach
- Strip secrets at snapshot — silent mutation; fail-closed reject preferred
