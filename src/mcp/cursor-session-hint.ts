import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

const DEFAULT_WITHIN_MS = 60_000;

function hintsPath(): string {
  const raw = process.env.HANDOFF_CURSOR_HINTS_PATH?.trim();
  if (raw) return raw;
  const dbPath = process.env.HANDOFF_DB_PATH?.trim();
  if (dbPath) {
    return join(dirname(dbPath), "cursor-session-hints.jsonl");
  }
  return join(process.cwd(), "data", "cursor-session-hints.jsonl");
}

function promptPrefix(prompt: string): string {
  return prompt.replace(/\s+/g, " ").trim().slice(0, 160);
}

/** Best-effort side-channel when Cursor drops preToolUse updated_input (CallDynamicTool). */
export function recordCursorSessionHint(input: {
  conversationId: string;
  toolName?: string | null;
  prompt?: string | null;
}): void {
  const conversationId = input.conversationId?.trim();
  if (!conversationId) return;
  try {
    const path = hintsPath();
    mkdirSync(dirname(path), { recursive: true });
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      conversationId,
      toolName: input.toolName ?? null,
      promptPrefix: promptPrefix(input.prompt ?? ""),
    });
    appendFileSync(path, `${line}\n`, { flag: "a" });
  } catch {
    // observability only
  }
}

/** Resolve recent Cursor conversation for this handoff prompt. */
export function resolveCursorSessionHint(
  prompt: string,
  opts?: { withinMs?: number }
): string | null {
  const withinMs = opts?.withinMs ?? DEFAULT_WITHIN_MS;
  const path = hintsPath();
  if (!existsSync(path)) return null;
  try {
    const lines = readFileSync(path, "utf8").trim().split("\n").filter(Boolean);
    if (lines.length === 0) return null;
    const needle = promptPrefix(prompt);
    const cutoff = Date.now() - withinMs;
    for (let i = lines.length - 1; i >= 0; i--) {
      let row: {
        ts?: string;
        conversationId?: string;
        promptPrefix?: string;
      };
      try {
        row = JSON.parse(lines[i]!) as typeof row;
      } catch {
        continue;
      }
      const ts = Date.parse(row.ts ?? "");
      if (!Number.isFinite(ts) || ts < cutoff) continue;
      const id = row.conversationId?.trim();
      if (!id) continue;
      const prefix = row.promptPrefix ?? "";
      if (
        needle &&
        prefix &&
        !(
          needle.startsWith(prefix.slice(0, 48)) ||
          prefix.startsWith(needle.slice(0, 48))
        )
      ) {
        continue;
      }
      return id;
    }
    for (let i = lines.length - 1; i >= 0; i--) {
      let row: { ts?: string; conversationId?: string };
      try {
        row = JSON.parse(lines[i]!) as typeof row;
      } catch {
        continue;
      }
      const ts = Date.parse(row.ts ?? "");
      if (!Number.isFinite(ts) || ts < cutoff) continue;
      const id = row.conversationId?.trim();
      if (id) return id;
    }
  } catch {
    return null;
  }
  return null;
}
