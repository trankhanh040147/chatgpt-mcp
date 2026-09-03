# ADR-005 — Secret content scan (attach / writeback / context)

**Status:** Accepted (amended 2026-09-03 — redact-if-safe + disclose; supersedes fail-closed-on-any-match)  
**Date:** 2026-08-29  
**Amended:** 2026-09-03

## Context

v0.6 added **native attachment**: snapshot bytes upload directly to ChatGPT, bypassing `handoff_read_file()` → `sanitizeSecrets()` on the MCP path.

Filename denylist (`SECRET_NAME_RE`) and read-time sanitize are insufficient:

```ts
// src/config.ts — allowed extension, not secret filename
const OPENAI_API_KEY = "sk-...";
```

would snapshot and attach raw.

v0.8 writeback (`handoff_submit_result` artifacts) reuses the same content guard.

### Incident that forced the amend

Materialize failed with `FILES_SECRET_DETECTED` on `docs/architecture.md` because the broad pattern `Bearer\s+[A-Za-z0-9._-]+` matched the prose **"Bearer field"** (false positive). Fail-closed on any regex hit made legitimate docs unattachable; silent strip was previously rejected because consumers would assume intact content.

## Decision (amended)

### Pipeline

```text
scan → classify → redact-if-safe → continue + disclose
                              ↘ cannot redact safely → fail-closed (FILES_SECRET_DETECTED)
```

1. **Scan** UTF-8 / known-text buffers with a shared detector registry.
2. **Classify** each hit: `detectorId`, confidence (`high` | `medium`), redactability.
3. **Redact** matches in-place to a fixed placeholder (`[REDACTED]`) when the buffer is safely mutable text.
4. **Disclose** redaction to callers (never store matched secret values).
5. **Fail-closed** only when a secret is detected (or strongly indicated) but the system cannot redact safely (binary/NUL, unsupported encoding, sanitizer error) — keep error code `FILES_SECRET_DETECTED`.

Default on a **safe text** match is **not** reject-the-whole-dispatch.

### Shared engine, path-specific actions

One **detection registry** (not three copy-pasted regex lists). Each path chooses action/UX:

| Path | On redactable hit | On unsafe / non-redactable |
|------|-------------------|----------------------------|
| Attach (`materializeWorkspaceResources`) | Redact bytes → attach redacted content; persist + return disclosure | `FILES_SECRET_DETECTED` (whole materialize fails) |
| Writeback (`writeResultArtifacts`) | Redact → write redacted artifact; **explicit** per-artifact “modified for secret removal” in result/metadata | `FILES_SECRET_DETECTED` for that validation batch (no target mutation) |
| Context / `sanitizeSecrets` | Redact string/JSON as today, using the same detectors | N/A (string path); if encoding invalid, treat as hard failure at call site |

Paths must not invent private pattern lists. Confidence/action tables live with the registry.

### Detector registry (normative shape)

Each detector: `{ id, confidence, match, redactability }`.

**High confidence** (credential / key material):

- Provider-prefixed API keys: `sk-…`, `ghp_…` (existing shape, length floors retained)
- PEM private key blocks
- JWT / compact JWS: prefer **structural** validation (three base64url segments; decode header/payload when feasible) over `eyJ`-only heuristics; token-like Bearer RHS may also classify high when structure validates

**Medium confidence** (credential-*like* assignments / headers — **do not delete these classes**):

- `Bearer <rhs>` — fire only when RHS is **token-like** (length + charset / entropy), **not** English prose (`field`, `token`, `header`, …)
- `password=<rhs>` / `secret=<rhs>` — fire only when RHS is **credential-like**, **not** placeholders (`<value>`, `…`, `REDACTED`, empty, obvious doc stubs)

Medium hits still redact when safe; they exist to keep recall. False positives are fixed by **narrowing matchers**, not by removing the detector class.

Out of scope for this ADR: full commercial DLP, ML classifiers, entropy-only scanners without a detector id.

### Disclosure contract

Persist and echo (task metadata **and** relevant MCP responses):

| Field | Meaning |
|-------|---------|
| `filesRedacted` | `true` if any file/artifact/context blob was modified by redaction |
| `redactionCount` | Total redaction replacements (integer) |
| `detectorIds` | Unique detector ids that fired (e.g. `sk`, `ghp`, `pem`, `jwt`, `bearer_tokenlike`, `password_assign`, `secret_assign`) |
| Optional per-file / per-artifact summary | `path` or `displayName` + counts/ids — **no matched substrings** |

Writeback MUST make modification obvious to the model and to Cursor resume (stronger UX than attach if needed, same security primitive).

**Never** log or persist the matched secret value.

### Compatibility

- Keep `FILES_SECRET_DETECTED` as a stable error code for the fail-closed branch and for older clients.
- Do not treat the code as “dead”; it remains the correct signal when redact-safe path is unavailable.

## Scope

- Shared module replacing ad-hoc `SECRET_PATTERNS` boolean `containsKnownSecrets` as the sole policy engine (callers may keep thin wrappers).
- Attach materialize, writeback artifact validation, context sanitize.
- Tests: true positives per detector; FP regression for `Bearer field` and doc-style `password=<value>`; unsafe/binary still rejects; disclosure fields present when redact occurred.
- Amend this ADR; touch consumer docs only where they claim fail-closed-on-any-match.

## Consequences

- Legitimate docs (e.g. architecture mentioning “Bearer field”) attach successfully without mangling when medium detectors are narrowed.
- Real secrets in text files are redacted before leave-the-machine / before writeback commit, with explicit disclosure so consumers do not assume byte-identical content.
- Silent mutation without disclosure remains **rejected** (same concern as the original ADR).
- Broader implementation: detector registry + metadata/MCP schema fields + worker/tool surfaces that forward disclosure.

## Alternatives rejected

| Alternative | Reason |
|-------------|--------|
| Read-time only sanitize | Bypassed by native attach |
| Fail-closed on any regex match (original ADR-005) | Blocks docs on false positives; poor attach UX |
| Silent strip / mask without disclosure | Consumer assumes intact content |
| Delete `Bearer` / `password=` / `secret=` detector classes | Large recall drop; FP should be fixed with token-likeness |
| Single tiny high-conf-only pattern set everywhere | Same recall problem; conflates detection with policy |
| Env-configured allowlist of phrases as primary fix | Hard to test/repro; easy to disable protection by mistake |
| Best-effort attach of binary after partial sanitize | Turns “no leak” into “no leak when sanitizer understands the file” |

## Original decision (historical, 2026-08-29)

Scan at dispatch materialization with shared `SECRET_PATTERNS`; on any match throw `FILES_SECRET_DETECTED` and reject the whole dispatch. Strip-at-snapshot was rejected in favor of fail-closed. Superseded by the amended pipeline above for redactable text; fail-closed retained only for the non-redactable branch.
