# Demo assets

## Target

| File | Purpose |
|------|---------|
| `handoff-demo.gif` (or `.webp`) | 20–30s captioned end-to-end handoff for the README hero |

Optional: higher-quality `handoff-demo.mp4` linked from the README for viewers who want detail.

## What to show (one pass)

1. Cursor creates a handoff → task ID / status visible  
2. CDP worker types only `TASK_ID=…` into ChatGPT  
3. ChatGPT calls `get_task` / `submit_result` via MCP  
4. Cursor receives `handoff_get_result`

## Capture rules

- Use a **synthetic** prompt (no private code)
- Hide: account name, conversation IDs, tunnel URL, tokens, filesystem paths, bookmarks, other tabs
- Short captions on-screen (or burnt-in): “Cursor creates task” → “CDP sends ID only” → “ChatGPT via MCP” → “Cursor gets result”
- Optimize to roughly **≤5 MB**
- Record from a tagged release commit; replace when the UI materially changes
- Do **not** cut away manual steps that the product still requires (login, write approval)

## After recording

1. Save as `docs/assets/handoff-demo.gif`
2. In root `README.md`, replace the “Demo (recording pending)” line with:

```markdown
![End-to-end Cursor → ChatGPT → Cursor handoff](docs/assets/handoff-demo.gif)
```

3. Keep descriptive alt text; link MP4 only if useful
