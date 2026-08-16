import type { HandoffTaskStatus } from "./task.types.js";

export const VALID_TRANSITIONS: Record<
  HandoffTaskStatus,
  HandoffTaskStatus[]
> = {
  QUEUED: ["DISPATCHING", "CANCELLED", "FAILED"],
  DISPATCHING: ["DISPATCHED", "QUEUED", "FAILED", "TIMED_OUT"],
  DISPATCHED: ["PROCESSING", "WAITING_APPROVAL", "FAILED", "QUEUED", "TIMED_OUT"],
  PROCESSING: [
    "COMPLETED",
    "FAILED",
    "RATE_LIMITED",
    "WAITING_APPROVAL",
    "TIMED_OUT",
  ],
  WAITING_APPROVAL: ["PROCESSING", "FAILED", "QUEUED", "TIMED_OUT", "COMPLETED"],
  RATE_LIMITED: ["QUEUED", "FAILED", "TIMED_OUT"],
  COMPLETED: ["READY_BUT_CURSOR_IDLE"],
  FAILED: [],
  TIMED_OUT: [],
  READY_BUT_CURSOR_IDLE: [],
  CANCELLED: [],
};

export function canTransition(
  from: HandoffTaskStatus,
  to: HandoffTaskStatus
): boolean {
  if (from === to) return true;
  return VALID_TRANSITIONS[from]?.includes(to) ?? false;
}

export function assertTransition(
  from: HandoffTaskStatus,
  to: HandoffTaskStatus
): void {
  if (!canTransition(from, to)) {
    throw new Error(`Invalid task transition: ${from} → ${to}`);
  }
}
