# Backend / API backlog — dashboard craft fields

**Status:** Deferred — not required for dash 1.0 React port sign-off  
**Related:** [figma-make-craft-pass.prompt.md](./figma-make-craft-pass.prompt.md)

Figma Make should **mock** these fields. Implement when product prioritizes craft layer.

---

## Task display title

**Need:** Human-readable one-line title on list/card/feed (not just `architecture_review` type).

**Existing data (partial):**

| Source | Field | Exposed in `GET /tasks` today? |
|--------|-------|--------------------------------|
| Task | `context.objective` | No (context not in list scrub) |
| Task | `prompt` (first line) | No — list only has `hasPrompt` |
| Task | `type` | Yes — maps to Title Case label |

**Proposed API (pick one at implement time):**

1. **`displayTitle`** optional on `handoff_create_task` — agent supplies short title
2. **Derived `listTitle`** server-side: `objective ?? truncate(prompt, 80) ?? typeLabel`
3. Expose on `scrubTaskListItem` + detail endpoint

**Privacy:** List title must not leak full prompt if redaction policy applies — use objective or explicit displayTitle.

---

## Repo / project label

**Need:** `◈ chatgpt-mcp` under task title on Overview.

**Existing data:**

| Source | Field | In list API? |
|--------|-------|--------------|
| Task | `workspaceRoot` | No |
| Host | Cursor workspace folder | Only if passed on create |

**Proposed API:**

```json
{
  "repoName": "chatgpt-mcp",
  "repoPath": null
}
```

- `repoName` = basename(`workspaceRoot`) or null
- Optional `packageName` later for monorepos
- **Do not** expose full absolute path on list — drawer/Diagnostics only

---

## Search (⌘K) — dash 1.1

Index when available: `repoName`, `displayTitle`, `id`, `leaseOwner`, `type`.

---

## No schema change required for

- Hero copy — derived from worker health + taxonomy (client)
- Activity feed layout — presentation only
- Motion — client-only
- Themes — client-only

---

## Suggested implement order

1. `repoName` on task list (cheap — workspaceRoot already stored)
2. `listTitle` derivation from objective/prompt
3. Optional explicit `displayTitle` on create
4. ⌘K search index

Do **not** block React port on items 1–4.
