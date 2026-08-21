import type { WorkerReadinessReason } from "../workers/chat-budget.js";

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

export interface HandoffTaskFile {
  fileId: string;
  displayName: string;
  relativePath: string;
  sourcePath: string;
  sizeBytes: number;
  sha256: string;
  mediaType: string;
  createdAt: string;
}

export type HandoffFileErrorCode =
  | "FILE_NOT_ON_TASK"
  | "FILE_NOT_FOUND"
  | "FILE_NOT_ALLOWED"
  | "FILE_CHANGED_REATTACH"
  | "FILE_TOO_LARGE"
  | "FILES_INVALID";

export class HandoffFileError extends Error {
  code: HandoffFileErrorCode;
  constructor(code: HandoffFileErrorCode, message: string) {
    super(message);
    this.name = "HandoffFileError";
    this.code = code;
  }
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
  leaseOwner?: string;
  leaseToken?: string;
  leaseExpiresAt?: string;
  dispatchStartedAt?: string;
  dispatchAttempt: number;
  nudgeStartedAt?: string;
  nudgeAttempt: number;
  workspaceRoot?: string;
  files?: HandoffTaskFile[];
}

export interface ClaimResult {
  task: HandoffTask;
  leaseToken: string;
}

export interface WorkerStateRow {
  id: string;
  status: WorkerStatus;
  lastSeenAt?: string;
  currentTaskId?: string;
  error?: string;
  instanceToken?: string;
  workerUrl?: string;
  cdpEndpoint?: string;
  httpPort?: number;
  startedAt?: string;
  pid?: number;
  /** Dispatched tasks on the current chat URL (0.5 rotation budget). */
  tasksOnChat?: number;
  /** Chat URL the counter is bound to. */
  tasksOnChatUrl?: string;
  previousWorkerUrl?: string;
  chatRotatedAt?: string;
  readinessReason?: WorkerReadinessReason;
}

/** Statuses that hold a lease_owner (partial unique index). */
export const LEASE_ACTIVE_STATUSES: HandoffTaskStatus[] = [
  "DISPATCHING",
  "DISPATCHED",
  "PROCESSING",
  "WAITING_APPROVAL",
];

export interface CreateTaskInput {
  type: HandoffTaskType;
  prompt: string;
  context?: HandoffTaskContext;
  /** Host session / correlation key. Optional for portable MCP hosts. */
  cursorConversationId: string;
  /** Workspace-relative evidence file paths (max 10). Never absolute paths. */
  files?: string[];
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
