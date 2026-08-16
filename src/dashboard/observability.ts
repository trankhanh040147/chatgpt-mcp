import type { HandoffTask, WorkerStatus } from "../tasks/task.types.js";
import { sanitizeSecrets } from "../tasks/sanitize.js";

const CHAT_HOSTS = new Set(["chatgpt.com", "www.chatgpt.com", "chat.openai.com"]);

export function msBetween(startIso?: string | null, endIso?: string | null): number | null {
  if (!startIso || !endIso) return null;
  const a = Date.parse(startIso);
  const b = Date.parse(endIso);
  if (!Number.isFinite(a) || !Number.isFinite(b) || b < a) return null;
  return b - a;
}

export function taskTiming(task: HandoffTask, nowIso = new Date().toISOString()) {
  const terminalAt =
    task.status === "COMPLETED" ||
    task.status === "FAILED" ||
    task.status === "TIMED_OUT" ||
    task.status === "CANCELLED" ||
    task.status === "READY_BUT_CURSOR_IDLE"
      ? task.completedAt ?? null
      : null;
  const processingStart = task.processingAt ?? task.dispatchedAt ?? null;
  return {
    createdAt: task.createdAt,
    dispatchStartedAt: task.dispatchStartedAt ?? null,
    dispatchedAt: task.dispatchedAt ?? null,
    processingAt: task.processingAt ?? null,
    completedAt: task.completedAt ?? null,
    terminalAt,
    queueMs: msBetween(task.createdAt, processingStart ?? terminalAt),
    processingMs: terminalAt ? msBetween(processingStart, terminalAt) : null,
    totalMs: terminalAt ? msBetween(task.createdAt, terminalAt) : null,
    processingAgeMs: !terminalAt
      ? msBetween(processingStart, nowIso)
      : null,
  };
}

export function sanitizeChatUrl(raw: string | null | undefined): string | null {
  if (!raw?.trim()) return null;
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return null;
  }
  if (u.protocol !== "https:") return null;
  if (!CHAT_HOSTS.has(u.hostname.toLowerCase())) return null;
  if (u.username || u.password) return null;
  u.hash = "";
  // Keep path; drop noisy tracking params
  for (const key of [...u.searchParams.keys()]) {
    if (/^(utm_|ref$|fbclid|gclid)/i.test(key)) u.searchParams.delete(key);
  }
  return u.toString();
}

export interface RedactedPreview {
  available: boolean;
  preview: string | null;
  truncated: boolean;
  redactionCount: number;
}

export function redactPreview(
  text: string | null | undefined,
  maxChars = 4000
): RedactedPreview {
  if (text == null || text === "") {
    return { available: false, preview: null, truncated: false, redactionCount: 0 };
  }
  const before = text;
  const scrubbed = sanitizeSecrets(before);
  const redactionCount = before === scrubbed ? 0 : (before.match(/\[REDACTED\]/g)?.length ?? 1);
  const truncated = scrubbed.length > maxChars;
  return {
    available: true,
    preview: truncated ? scrubbed.slice(0, maxChars) + "\n…[truncated]" : scrubbed,
    truncated,
    redactionCount,
  };
}

export type IndicatorKind =
  | "heartbeat_stale"
  | "task_long_running"
  | "recent_failures"
  | "recent_timeouts"
  | "pid_dead"
  | "session_lost"
  | "rate_limited";

export interface WorkerIndicator {
  kind: IndicatorKind;
  label: string;
  severity: "ok" | "warn" | "bad";
}

export function deriveWorkerIndicators(input: {
  status: WorkerStatus | string;
  healthy: boolean;
  pidAlive: boolean;
  heartbeatStale: boolean;
  heartbeatAgeMs: number | null;
  currentTaskAgeMs: number | null;
  recentFailed: number;
  recentTimedOut: number;
  longRunningMs?: number;
}): WorkerIndicator[] {
  const longMs = input.longRunningMs ?? 10 * 60_000;
  const out: WorkerIndicator[] = [];
  if (!input.pidAlive) {
    out.push({ kind: "pid_dead", label: "PID dead", severity: "bad" });
  }
  if (input.heartbeatStale) {
    const age =
      input.heartbeatAgeMs != null
        ? `${Math.round(input.heartbeatAgeMs / 1000)}s`
        : "?";
    out.push({
      kind: "heartbeat_stale",
      label: `Heartbeat stale · ${age}`,
      severity: "bad",
    });
  }
  if (input.status === "SESSION_LOST") {
    out.push({
      kind: "session_lost",
      label: "Chat session lost",
      severity: "bad",
    });
  }
  if (input.status === "RATE_LIMITED") {
    out.push({
      kind: "rate_limited",
      label: "Rate limited",
      severity: "warn",
    });
  }
  if (
    input.currentTaskAgeMs != null &&
    input.currentTaskAgeMs > longMs &&
    (input.status === "BUSY" ||
      input.status === "NEEDS_APPROVAL" ||
      input.status === "PROCESSING")
  ) {
    out.push({
      kind: "task_long_running",
      label: `Current task · ${Math.round(input.currentTaskAgeMs / 60_000)}m`,
      severity: "warn",
    });
  }
  if (input.recentFailed > 0) {
    out.push({
      kind: "recent_failures",
      label: `${input.recentFailed} failed · 24h`,
      severity: "warn",
    });
  }
  if (input.recentTimedOut > 0) {
    out.push({
      kind: "recent_timeouts",
      label: `${input.recentTimedOut} timed out · 24h`,
      severity: "warn",
    });
  }
  return out;
}

export function dashboardContentMode(): "off" | "redacted" {
  const v = (process.env.HANDOFF_DASHBOARD_TASK_CONTENT ?? "off").toLowerCase();
  return v === "redacted" ? "redacted" : "off";
}
