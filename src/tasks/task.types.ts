export type HandoffTaskStatus =
  | "QUEUED"
  | "DISPATCHING"
  | "DISPATCHED"
  | "PROCESSING"
  | "WAITING_APPROVAL"
  | "RATE_LIMITED"
  | "COMPLETED"
  | "FAILED"
  | "TIMED_OUT"
  | "READY_BUT_CURSOR_IDLE"
  | "CANCELLED";

export type HandoffTaskType =
  | "research"
  | "code_review"
  | "architecture_review"
  | "second_opinion"
  | "debug_analysis";

export type WorkerStatus =
  | "STARTING"
  | "READY"
  | "BUSY"
  | "NEEDS_APPROVAL"
  | "RATE_LIMITED"
  | "SESSION_LOST"
  | "ERROR";

export interface HandoffTaskContext {
  objective?: string;
  currentApproach?: string;
  constraints?: string[];
  relevantFiles?: string[];
  gitDiff?: string;
}

export interface HandoffResultMetadata {
  summary?: string;
  confidence?: "low" | "medium" | "high";
}

export interface HandoffTask {
  id: string;
  cursorConversationId: string;
  type: HandoffTaskType;
  prompt: string;
  context?: HandoffTaskContext;
  status: HandoffTaskStatus;
  result?: string;
  resultMetadata?: HandoffResultMetadata;
  retryCount: number;
  createdAt: string;
  dispatchedAt?: string;
  processingAt?: string;
  completedAt?: string;
  error?: string;
}

export interface CreateTaskInput {
  type: HandoffTaskType;
  prompt: string;
  context?: HandoffTaskContext;
  /** Host session / correlation key. Optional for portable MCP hosts. */
  cursorConversationId: string;
}

/** Sentinel when the host does not supply a session id (manual poll by taskId). */
export const UNSCOPED_CLIENT_SESSION_ID = "unscoped";


export interface SubmitResultInput {
  taskId: string;
  result: string;
  metadata?: HandoffResultMetadata;
}

export const ACTIVE_STATUSES: HandoffTaskStatus[] = [
  "QUEUED",
  "DISPATCHING",
  "DISPATCHED",
  "PROCESSING",
  "WAITING_APPROVAL",
  "RATE_LIMITED",
];

export const TERMINAL_STATUSES: HandoffTaskStatus[] = [
  "COMPLETED",
  "FAILED",
  "TIMED_OUT",
  "READY_BUT_CURSOR_IDLE",
  "CANCELLED",
];

export const DEFAULT_WORKER_ID = "default";
