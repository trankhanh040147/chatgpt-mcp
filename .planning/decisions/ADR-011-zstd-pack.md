# ADR-011 — tar.zst packing on the native path (v0.9)

**Status:** Accepted (grilling 2026-09-02; ZSTD 2026-09-03; security + review harden 2026-09-03)  
**Date:** 2026-09-02  
**Amends:** [ADR-003](./ADR-003-resource-transport.md)  
**Does not change:** [ADR-010-native-writeback](./ADR-010-native-writeback.md) `artifacts[]` (hybrid outbound)  
**Ship:** one PR on `feat/v0.9-zstd-pack`

## Context

v0.7 multi-chip attach hits `CHATGPT_DOM_CHIP_CAP ≈ 20`. v0.8 writeback caps `artifacts[]` at 20. Next resource-family job is **batch packing** via **tar.zst** (pax tar + zstd): Zstandard is a compressor (RFC 8878), not an archive.

Independent review approved architecture; required streaming bounds, window semantics, tar allowlist, pax effective-path, single-frame + canonical base64 before implementation lock. A follow-up review clarified **single-segment window equivalence** and Phase 0 API capability spike.

## Decision

1. **tar.zst packing adapter** on native CDP `setInputFiles`. No silent MCP fallback.
2. **Inbound always one chip** — `handoff-{taskId}.tar.zst` (`taskId` = `ho_` + ULID).
3. **Outbound hybrid** — `artifacts[]` XOR `archive` (`format: "tar.zst"`, canonical base64). Never infer from filename.
4. **100 members**; **64 MiB** per-member / uncompressed stream / compressed payload.
5. **`MAX_ZSTD_WINDOW = 8 MiB` for all frames.** Single-segment: FCS required and `FCS ≤ min(MAX_UNCOMPRESSED_BYTES, MAX_ZSTD_WINDOW)`. Prefer windowed producer frames for packs > 8 MiB content.
6. **Exactly one** Zstandard frame; reject concatenated, skippable, trailing garbage, dictionaries.
7. **Stream-enforce** uncompressed cap; never decompress-all-then-check.
8. **Tar allowlist:** regular + pax `'x'`; reject hardlink/symlink/dir/devices/sparse/`'g'`/unknown. Effective path post-pax. Nested archives via extension allowlist only.
9. **No workspace mutation** until full archive validation completes.
10. **Stable `ARCHIVE_*` / `PACK_*` codes.**
11. **Ladder:** 0.9 → MCP URI 0.10 → audit 0.11 → Claude 0.12.
12. **Delivery:** single feature PR (internal Phase 0→4 gates). Codec choice + ADR implementation notes land in that same PR as soon as Phase 0 exits.

## Alternatives rejected

| Alternative | Reason |
|-------------|--------|
| Single-segment FCS up to 64 MiB under an “8 MiB window” label | RFC: window = FCS in single-segment → 64 MiB decoder memory; violates window cap |
| Blacklist-only symlink | Misses hardlink / other typeflags |
| Content-sniff nested tar | Ambiguous; extension allowlist sufficient |
| Multi-frame / skippable zstd | Larger attack surface |
| Soft-decompress APIs without frame inspection | Cannot enforce exact-one-frame / window / streaming bound |
| Four ship PRs | Operator chose one `feat/v0.9…` PR |

## Consequences

- Phase 0 must **spike** zstd API capabilities before locking dependency.
- Producer uses windowed frames for large packs; single-segment only when FCS ≤ 8 MiB.
- Materialize for pack uses explicit caps API / wrapper — do not silently retarget shared 32/128 constants used by `artifacts[]`.
- Peak RSS may exceed “64 MiB” due to multiple buffers; document + test.

## Spec

[0.9-zstd-pack.md](../active/0.9-zstd-pack.md) · [impl plan](../active/0.9-zstd-pack-impl-plan.md)

## Implementation notes

*(Fill in Phase 0 exit of the single PR.)*

| Item | Choice |
|------|--------|
| Zstd library | TBD — must pass capability spike |
| Tar | Hand-rolled pax (regular + `'x'`) unless wrapped stream lib proves allowlist control |
| Window on compress | Must set / verify ≤ 8 MiB |
