import type { WorkerReadinessReason } from "../workers/chat-budget.js";
import type { ResultArtifactInput } from "./result-artifacts.js";

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
  /** E2E / explicit tasks: reject prose-only submit (artifacts[] required). */
  writebackRequired?: boolean;
  /** Optional copy-paste payload for handoff_submit_result (taskId filled by worker). */
  submitTemplate?: {
    result: string;
    artifacts: ResultArtifactInput[];
  };
}

export interface HandoffResultMetadata {
  summary?: string;
  confidence?: "low" | "medium" | "high";
  artifacts?: Array<{
    relativePath: string;
    displayName: string;
    sizeBytes: number;
    sha256: string;
    /** True when this artifact body was redacted before write. */
    modifiedForSecretRemoval?: boolean;
    redactionCount?: number;
    detectorIds?: string[];
  }>;
  /** Aggregate writeback/attach disclosure (ADR-005). */
  filesRedacted?: boolean;
  redactionCount?: number;
  detectorIds?: string[];
  modifiedForSecretRemoval?: boolean;
}

export type ResourceSource =
  | { kind: "workspace_file"; relativePath: string }
  | { kind: "mcp_resource"; uri: string; serverId?: string };

/** Persisted resource reference (materialized at dispatch). */
export interface TaskResource {
  fileId: string;
  displayName: string;
  relativePath: string;
  source: ResourceSource;
  createdAt: string;
}

/** Ephemeral bytes prepared for one dispatch attempt. */
export interface PreparedResource {
  resourceId: string;
  displayName: string;
  bytes: Buffer;
  sizeBytes: number;
  sha256: string;
  mediaType: string;
}

/** @deprecated Alias — use TaskResource */
export type HandoffTaskFile = TaskResource;

export type HandoffFileErrorCode =
  | "FILE_NOT_ON_TASK"
  | "FILE_NOT_FOUND"
  | "FILE_NOT_ALLOWED"
  | "FILE_TOO_LARGE"
  | "FILES_INVALID"
  | "FILES_DUPLICATE_BASENAME"
  | "FILES_SECRET_DETECTED"
  | "FILE_READ_DISABLED"
  | "RESOURCES_MCP_DEFERRED";

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
  files?: TaskResource[];
  taskClass?: "USER" | "SYSTEM_PROBE";
  targetWorkerId?: string;
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
  tasksOnChat?: number;
  tasksOnChatUrl?: string;
  previousWorkerUrl?: string;
  chatRotatedAt?: string;
  readinessReason?: WorkerReadinessReason;
  mcpReadVerifiedAt?: string;
  mcpWriteVerifiedAt?: string;
  mcpWriteStatus?: "VERIFIED" | "DEGRADED" | null;
  mcpWriteStatusReason?: string;
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
  /** Workspace-relative evidence file paths. Never absolute paths. */
  files?: string[];
  /** Absolute host workspace for files[] (overrides HANDOFF_WORKSPACE_ROOT). Hook may inject. */
  workspaceRoot?: string;
  taskClass?: "USER" | "SYSTEM_PROBE";
  targetWorkerId?: string;
}

/** Sentinel when the host does not supply a session id (manual poll by taskId). */
export const UNSCOPED_CLIENT_SESSION_ID = "unscoped";

export interface SubmitResultInput {
  taskId: string;
  result: string;
  metadata?: HandoffResultMetadata;
  artifacts?: ResultArtifactInput[];
  archive?: {
    format: "tar.zst";
    encoding: "base64";
    data: string;
  };
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
