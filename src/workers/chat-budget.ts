/** Why a worker cannot claim (rotation / consent / restart). */
export type WorkerReadinessReason =
  | "THRESHOLD_REACHED"
  | "ROTATION_PENDING"
  | "ROTATION_FAILED"
  | "RESTART_REQUIRED"
  | "CONSENT_REQUIRED";

const BLOCKING = new Set<WorkerReadinessReason>([
  "THRESHOLD_REACHED",
  "ROTATION_PENDING",
  "ROTATION_FAILED",
  "RESTART_REQUIRED",
  "CONSENT_REQUIRED",
]);

export function parseMaxTasksPerChat(raw: string | undefined): number {
  const n = Number(raw ?? 20);
  if (!Number.isInteger(n) || n < 1 || n > 10_000) {
    throw new Error(
      `HANDOFF_MAX_TASKS_PER_CHAT must be an integer 1–10000 (got ${JSON.stringify(raw)})`
    );
  }
  return n;
}

/** At count == max the worker must rotate before task N+1. */
export function isChatBudgetExhausted(
  tasksOnChat: number,
  maxTasksPerChat: number
): boolean {
  return tasksOnChat >= maxTasksPerChat;
}

/** Dashboard-only hint at N−1; does not affect scheduling. */
export function shouldWarnChatBudget(
  tasksOnChat: number,
  maxTasksPerChat: number
): boolean {
  return maxTasksPerChat > 1 && tasksOnChat === maxTasksPerChat - 1;
}

export function readinessBlocksClaim(
  reason: string | null | undefined
): boolean {
  return Boolean(reason && BLOCKING.has(reason as WorkerReadinessReason));
}

export function readinessLabel(reason: string | null | undefined): string | null {
  switch (reason) {
    case "THRESHOLD_REACHED":
      return "Chat budget full — rotate";
    case "ROTATION_PENDING":
      return "Rotation pending";
    case "ROTATION_FAILED":
      return "Rotation failed";
    case "RESTART_REQUIRED":
      return "Restart broker required";
    case "CONSENT_REQUIRED":
      return "MCP consent required";
    default:
      return null;
  }
}
