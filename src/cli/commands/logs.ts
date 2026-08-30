import { createReadStream, existsSync, statSync } from "node:fs";
import { createInterface } from "node:readline";
import type { LogEntry } from "../../logging/logger.js";
import type { ParsedArgs } from "../args.js";
import { hasFlag, option } from "../args.js";
import { loadCliConfig, logFilePath } from "../context.js";
import {
  errMark,
  formatTime,
  okMark,
  style,
  useColor,
  warnMark,
} from "../terminal.js";

function parseSince(raw: string | undefined): number | null {
  if (!raw) return null;
  const m = /^(\d+)(m|h|s)?$/i.exec(raw.trim());
  if (!m) return null;
  const n = Number(m[1]);
  const unit = (m[2] ?? "m").toLowerCase();
  if (unit === "h") return n * 3600_000;
  if (unit === "s") return n * 1000;
  return n * 60_000;
}

function componentStyle(component: string): string {
  const upper = component.toUpperCase().replace(/-/g, "_");
  const short =
    upper.includes("BROKER")
      ? "BROKER"
      : upper.includes("WORKER")
        ? "WORKER"
        : upper.includes("MCP")
          ? "MCP"
          : upper.includes("HTTP")
            ? "API"
            : component.slice(0, 8).toUpperCase();
  return useColor() ? style(short.padEnd(8), "cyan") : short.padEnd(8);
}

function eventMark(event: string): string {
  if (event === "ERROR" || event === "TASK_FAILED" || event === "TASK_TIMED_OUT") {
    return errMark();
  }
  if (event === "WARN" || event === "RATE_LIMITED" || event === "WORKER_SESSION_LOST") {
    return warnMark();
  }
  if (
    event === "RESULT_RECEIVED" ||
    event === "TASK_DISPATCHED" ||
    event === "CURSOR_RESUMED"
  ) {
    return okMark();
  }
  return style("→", "dim");
}

function formatLine(entry: LogEntry): string {
  const ts = formatTime(entry.timestamp);
  const comp = componentStyle(entry.component);
  const mark = eventMark(entry.event);
  const task = entry.taskId ? style(entry.taskId.slice(0, 12), "bold") : "";
  const msg = entry.message ? style(entry.message, "dim") : entry.event;
  return `${style(ts, "dim")}  ${comp}  ${mark} ${task}${task ? " " : ""}${msg}`.trimEnd();
}

function matchesFilter(entry: LogEntry, args: ParsedArgs): boolean {
  const worker = option(args, "worker");
  if (worker && !entry.message?.includes(worker) && entry.data?.workerId !== worker) {
    return false;
  }
  const task = option(args, "task");
  if (task && entry.taskId !== task && !entry.taskId?.startsWith(task)) {
    return false;
  }
  if (hasFlag(args, "errors")) {
    return (
      entry.event === "ERROR" ||
      entry.event === "TASK_FAILED" ||
      entry.event === "TASK_TIMED_OUT" ||
      entry.event === "WARN"
    );
  }
  return true;
}

async function renderFile(path: string, args: ParsedArgs, sinceMs: number | null): Promise<void> {
  if (!existsSync(path)) {
    console.error(`Log file not found: ${path}`);
    process.exit(1);
  }
  const cutoff = sinceMs != null ? Date.now() - sinceMs : null;
  const rl = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    let entry: LogEntry;
    try {
      entry = JSON.parse(line) as LogEntry;
    } catch {
      console.log(line);
      continue;
    }
    if (cutoff != null && Date.parse(entry.timestamp) < cutoff) continue;
    if (!matchesFilter(entry, args)) continue;
    console.log(formatLine(entry));
  }
}

async function followFile(path: string, args: ParsedArgs, sinceMs: number | null): Promise<void> {
  let offset = 0;
  if (existsSync(path)) offset = statSync(path).size;
  const since = sinceMs;

  for (;;) {
    if (existsSync(path)) {
      const size = statSync(path).size;
      if (size > offset) {
        const stream = createReadStream(path, { start: offset, end: size - 1 });
        const rl = createInterface({ input: stream, crlfDelay: Infinity });
        for await (const line of rl) {
          if (!line.trim()) continue;
          try {
            const entry = JSON.parse(line) as LogEntry;
            if (since != null && Date.parse(entry.timestamp) < Date.now() - since) continue;
            if (!matchesFilter(entry, args)) continue;
            console.log(formatLine(entry));
          } catch {
            console.log(line);
          }
        }
        offset = size;
      }
    }
    await new Promise((r) => setTimeout(r, 500));
  }
}

export async function runLogs(args: ParsedArgs): Promise<number> {
  const config = loadCliConfig();
  const path = logFilePath(config);
  const sinceMs = parseSince(option(args, "since"));

  if (hasFlag(args, "json")) {
    if (!existsSync(path)) {
      console.error(`Log file not found: ${path}`);
      return 1;
    }
    const rl = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
    for await (const line of rl) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line) as LogEntry;
        if (sinceMs != null && Date.parse(entry.timestamp) < Date.now() - sinceMs) continue;
        if (!matchesFilter(entry, args)) continue;
        console.log(JSON.stringify(entry));
      } catch {
        /* skip */
      }
    }
    return 0;
  }

  if (hasFlag(args, "follow") || hasFlag(args, "f")) {
    await followFile(path, args, sinceMs);
    return 0;
  }

  await renderFile(path, args, sinceMs);
  return 0;
}
