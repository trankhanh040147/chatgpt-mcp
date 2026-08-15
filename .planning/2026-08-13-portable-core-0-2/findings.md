# Findings — portable core 0.2 + release audit

## Release status of current version (2026-08-13)

| Signal | Status |
|--------|--------|
| `package.json` version | `0.1.0-preview.1` |
| Commit on `origin/main` | `396515e` — message “Release 0.1.0-preview.1…” |
| Git tags (`v*` / `*preview*`) | **None** locally or on `origin` |
| GitHub Releases (`gh release list`) | **Empty** |
| Branch sync | `main` == `origin/main` (0 ahead / 0 behind) **for committed history** |
| Local uncommitted preview batch | **Large dirty tree** — README SOTA, `npm run start`, long-poll, SECURITY/CONTRIBUTING, bench freeze, FAILED followup, planning notes — **not released** |

### Verdict

**Partially released as public source only:** remote `main` carries an early `0.1.0-preview.1` *commit*, but there is **no immutable git tag and no GitHub Release**. The improved local 0.1.x batch is **not** on GitHub yet.

Before claiming “0.1 released,” need at minimum: commit+push local batch, preferably `git tag v0.1.0-preview.2` (or similar) + optional `gh release create`. Do **not** move/retag `0.1.0-preview.1` if tagging the new batch.

## Next version (agreed)

Roadmap target for this plan is now **0.5.0** portable core (see `docs/roadmap.md` after 2026-08-15 reorder). Local package may still say `0.2.0-preview.0`. **Next product:** **0.2.0** multi-worker; assisted provision is **0.3.0**; agent UX is **0.4.0**.

## Code coupling to remove

`src/mcp/tools/index.ts` throws if `cursorConversationId` missing (Cursor preToolUse injects it). That blocks Claude Code and other MCP hosts.
