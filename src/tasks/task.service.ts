import { timingSafeEqual } from "node:crypto";
import { ulid } from "ulid";
import type { TaskRepository } from "./task.repository.js";
import { sanitizeContext, sanitizeSecrets, type SecretRedactionDisclosure } from "./sanitize.js";
import { assertTransition } from "./task-state.js";
import { log, logTransition } from "../logging/logger.js";
import {
  registerTaskResourcePaths,
  resolveWorkspaceRoot,
  assertWorkspaceFilesExist,
} from "./files.js";
import { writeResultArtifacts } from "./result-artifacts.js";
import { ingestArchiveWriteback } from "../archive/ingest.js";
import { ArchiveError } from "../archive/errors.js";
import {
  HandoffFileError,
  type ClaimResult,
  type CreateTaskInput,
  type HandoffTask,
  type HandoffResultMetadata,
  type SubmitResultInput,
} from "./task.types.js";
import {
  classifyCompletedProbeResult,
} from "../mcp/probe-failure.js";
import { estimateTaskUsage, loadCostConfig } from "../usage/pricing.js";
import {
  getTaskUsage,
  insertTaskUsage,
} from "../usage/task-usage.repository.js";
import { getDatabase } from "../db/sqlite.js";

export class TaskService {
  constructor(private readonly repo: TaskRepository) {}

  createTask(input: CreateTaskInput): { taskId: string; status: "QUEUED" } {
    const id = `ho_${ulid()}`;
    const now = new Date().toISOString();

    let workspaceRoot: string | undefined;
    let files: HandoffTask["files"] = [];
    if (input.files && input.files.length > 0) {
      workspaceRoot = resolveWorkspaceRoot(input.workspaceRoot);
      assertWorkspaceFilesExist(input.files, workspaceRoot);
      files = registerTaskResourcePaths(input.files, now);
    } else if (input.workspaceRoot) {
      // Writeback/archive tasks may omit files[] but still need a pinned root.
      workspaceRoot = resolveWorkspaceRoot(input.workspaceRoot);
    }

    const task: HandoffTask = {
      id,
      cursorConversationId: input.cursorConversationId,
      type: input.type,
      prompt: sanitizeSecrets(input.prompt),
      context: sanitizeContext(
        input.context as Record<string, unknown> | undefined
      ) as HandoffTask["context"],
      status: "QUEUED",
      retryCount: 0,
      createdAt: now,
      dispatchAttempt: 0,
      nudgeAttempt: 0,
      workspaceRoot,
      taskClass: input.taskClass ?? "USER",
      targetWorkerId: input.targetWorkerId,
    };

    this.repo.insertTaskWithFiles(task, files ?? []);

    log({
      event: "TASK_CREATED",
      component: "task-service",
      taskId: id,
      message: `type=${input.type} files=${files?.length ?? 0}`,
    });

    return { taskId: id, status: "QUEUED" };
  }

  createSystemProbe(input: {
    workerId: string;
    operationId: string;
    token: string;
  }): { taskId: string } {
    const { taskId } = this.createTask({
      type: "second_opinion",
      prompt:
        "System connectivity check.\n" +
        "Use handoff_ack with the task ID from this chat.",
      cursorConversationId: `probe-${input.operationId}`,
      taskClass: "SYSTEM_PROBE",
      targetWorkerId: input.workerId,
    });
    // Store server-side token for ack validation (not exposed in get_task prompt).
    this.repo.setProbeToken(taskId, input.token);
    return { taskId };
  }

  /**
   * After New chat / URL bind: queue a minimal task so the worker dispatches TASK_ID
   * and ChatGPT shows the connector "Always allow" prompt (write path).
   * Does not gate READY — passive MCP write verification.
   */
  createConnectorHandshake(input: { workerId: string }): {
    taskId: string;
    skipped?: boolean;
  } {
    const worker = this.repo.findWorkerRegistryRow(input.workerId);
    if (worker?.mcpWriteVerifiedAt) {
      return { taskId: "", skipped: true };
    }
    const pending = this.repo.findPendingConnectorHandshake(input.workerId);
    if (pending) {
      return { taskId: pending, skipped: true };
    }
    const { taskId } = this.createTask({
      type: "second_opinion",
      prompt:
        "Connector handshake.\n" +
        "1. handoff_get_task\n" +
        "2. handoff_submit_result with result OK",
      cursorConversationId: `connector-${input.workerId}`,
      targetWorkerId: input.workerId,
    });
    log({
      event: "INFO",
      component: "task-service",
      taskId,
      message: `connector handshake queued worker=${input.workerId}`,
    });
    return { taskId };
  }

  /** SYSTEM_PROBE ack — canary resolved server-side. */
  completeProbeAck(taskId: string): {
    success: boolean;
    status: "COMPLETED";
    idempotent?: boolean;
    lateSubmit?: boolean;
  } {
    const task = this.repo.getTaskById(taskId);
    if (!task) {
      throw new Error(`Task not found: ${taskId}`);
    }
    if (task.taskClass !== "SYSTEM_PROBE") {
      throw new Error(
        `handoff_ack is only for SYSTEM_PROBE tasks (got ${task.taskClass ?? "USER"})`
      );
    }
    const canary = this.repo.getProbeToken(taskId);
    if (!canary) {
      throw new Error(`Probe token missing for task ${taskId}`);
    }
    return this.completeProbe({ taskId, canary });
  }

  /** SYSTEM_PROBE completion via minimal MCP tool (maps to canary submit). */
  completeProbe(input: { taskId: string; canary: string }): {
    success: boolean;
    status: "COMPLETED";
    idempotent?: boolean;
    lateSubmit?: boolean;
  } {
    const task = this.repo.getTaskById(input.taskId);
    if (!task) {
      throw new Error(`Task not found: ${input.taskId}`);
    }
    if (task.taskClass !== "SYSTEM_PROBE") {
      throw new Error(
        `handoff_complete_probe is only for SYSTEM_PROBE tasks (got ${task.taskClass ?? "USER"})`
      );
    }
    const canary = input.canary.trim();
    if (!canary || canary.length > 128) {
      throw new Error("canary must be a non-empty verification token");
    }
    const stored = this.repo.getProbeToken(input.taskId);
    if (!stored) {
      throw new Error(`Probe token missing for task ${input.taskId}`);
    }
    if (!TaskService.probeTokensEqual(canary, stored)) {
      throw new Error(
        `SYSTEM_PROBE PROBE_RESULT_MISMATCH: canary does not match task token`
      );
    }
    return this.submitResult({
      taskId: input.taskId,
      result: `CREATE_WORKER_CANARY=${canary}`,
    });
  }

  /** Record platform MCP write degradation without blocking worker READY. */
  markMcpWriteDegraded(taskId: string, reason: string): void {
    const task = this.repo.getTaskById(taskId);
    const workerId = task?.targetWorkerId ?? task?.leaseOwner;
    if (workerId && workerId !== "default") {
      this.repo.recordMcpWriteDegraded(workerId, reason);
    }
    if (task?.taskClass === "SYSTEM_PROBE") {
      this.failProbeClassified(
        taskId,
        "MCP_SAFETY_BLOCKED",
        reason.slice(0, 200)
      );
    }
  }

  /** Fail a probe with a classified MCP failure (binding may still be OK). */
  failProbeClassified(
    taskId: string,
    reason:
      | "MCP_SAFETY_BLOCKED"
      | "MCP_APPROVAL_REQUIRED"
      | "MCP_TOOL_NOT_INVOKED"
      | "MCP_SUBMIT_TIMEOUT"
      | "PROBE_RESULT_MISMATCH",
    detail?: string
  ): void {
    const task = this.repo.getTaskById(taskId);
    if (!task || task.taskClass !== "SYSTEM_PROBE") return;
    if (
      task.status === "COMPLETED" ||
      task.status === "FAILED" ||
      task.status === "CANCELLED"
    ) {
      return;
    }
    const message = `${reason}: ${detail ?? reason}`.slice(0, 500);
    this.repo.updateTaskStatus(taskId, "FAILED", {
      error: message,
      clearLease: true,
    });
    log({
      event: "TASK_FAILED",
      component: "task-service",
      taskId,
      message,
    });
  }

  /** v0.7: file evidence is delivered via native attachment only. */
  readFile(
    taskId: string,
    fileId: string,
    _offset = 0,
    _maxBytes?: number
  ): never {
    const task = this.repo.getTaskById(taskId);
    if (!task) {
      throw new HandoffFileError("FILE_NOT_ON_TASK", "File not attached to task");
    }
    const fileRow = this.repo.getTaskFile(taskId, fileId);
    if (!fileRow) {
      throw new HandoffFileError("FILE_NOT_ON_TASK", "File not attached to task");
    }
    if ((task.files ?? []).length > 0) {
      throw new HandoffFileError(
        "FILE_READ_DISABLED",
        "File evidence is delivered via native ChatGPT attachment in v0.7; handoff_read_file is not available for attached files"
      );
    }
    throw new HandoffFileError("FILE_NOT_ON_TASK", "File not attached to task");
  }

  getTask(taskId: string): HandoffTask | null {
    const task = this.repo.getTaskById(taskId);
    if (!task) return null;

    if (task.status === "DISPATCHED") {
      const now = new Date().toISOString();
      assertTransition(task.status, "PROCESSING");
      this.repo.updateTaskStatus(taskId, "PROCESSING", { processingAt: now });
      logTransition("task-service", taskId, "DISPATCHED", "PROCESSING");
      log({ event: "CHATGPT_PROCESSING", component: "task-service", taskId });
      this.recordMcpReadForTask(taskId);
      return { ...task, status: "PROCESSING", processingAt: now };
    }

    this.recordMcpReadForTask(taskId);
    return task;
  }

  private recordMcpReadForTask(taskId: string): void {
    const task = this.repo.getTaskById(taskId);
    const workerId = task?.targetWorkerId ?? task?.leaseOwner;
    if (!workerId || workerId === "default") return;
    this.repo.recordMcpReadVerified(workerId);
  }

  private recordMcpWriteVerifiedForTask(taskId: string): void {
    const task = this.repo.getTaskById(taskId);
    const workerId = task?.targetWorkerId ?? task?.leaseOwner;
    if (!workerId || workerId === "default") return;
    this.repo.recordMcpWriteVerified(workerId);
  }

  submitResult(input: SubmitResultInput): {
    success: boolean;
    status: "COMPLETED";
    idempotent?: boolean;
    lateSubmit?: boolean;
    filesRedacted?: boolean;
    redactionCount?: number;
    detectorIds?: string[];
    modifiedForSecretRemoval?: boolean;
  } {
    const task = this.repo.getTaskById(input.taskId);
    if (!task) {
      throw new Error(`Task not found: ${input.taskId}`);
    }

    const sanitizedResult = sanitizeSecrets(input.result);
    let metadata = input.metadata
      ? (sanitizeContext(
          input.metadata as Record<string, unknown>
        ) as HandoffResultMetadata)
      : undefined;

    if (task.status === "COMPLETED") {
      return this.reconcileCompletedSubmit(
        task,
        sanitizedResult,
        input.taskId
      );
    }

    if (
      task.status !== "PROCESSING" &&
      task.status !== "DISPATCHED" &&
      task.status !== "WAITING_APPROVAL" &&
      task.status !== "TIMED_OUT"
    ) {
      throw new Error(
        `Cannot submit result for task in status ${task.status}`
      );
    }

    if (!task.dispatchStartedAt) {
      throw new Error(
        `Cannot submit result for task ${input.taskId}: dispatch fence not set`
      );
    }

    if (task.taskClass === "SYSTEM_PROBE") {
      const canaryMatch = sanitizedResult.match(
        /CREATE_WORKER_CANARY=([a-f0-9]+)/i
      );
      if (!canaryMatch) {
        const classified = classifyCompletedProbeResult(sanitizedResult);
        const hint =
          classified === "MCP_TOOL_NOT_INVOKED" &&
          sanitizedResult.toLowerCase().includes("handoff_complete_probe")
            ? " Restart remote-mcp (npm run build && gptmcp restart) so ChatGPT sees handoff_complete_probe."
            : " Use handoff_complete_probe with the canary from the task prompt — not handoff_submit_result prose.";
        throw new Error(`SYSTEM_PROBE ${classified}: invalid probe submit.${hint}`);
      }
      const stored = this.repo.getProbeToken(input.taskId);
      if (!stored) {
        throw new Error(`Probe token missing for task ${input.taskId}`);
      }
      if (!TaskService.probeTokensEqual(canaryMatch[1], stored)) {
        throw new Error(
          `SYSTEM_PROBE PROBE_RESULT_MISMATCH: canary does not match task token`
        );
      }
    }

    const artifactCount = input.artifacts?.length ?? 0;
    const hasArchive = Boolean(input.archive?.data);
    if (hasArchive && artifactCount > 0) {
      throw new ArchiveError(
        "ARCHIVE_WITH_ARTIFACTS",
        "Pass archive XOR artifacts[] — not both"
      );
    }
    if (task.context?.writebackRequired && artifactCount === 0 && !hasArchive) {
      const hint = task.context.submitTemplate
        ? " Use submitTemplate from handoff_get_task as the handoff_submit_result payload."
        : "";
      throw new HandoffFileError(
        "FILES_INVALID",
        `artifacts[] or archive required for this task — result prose does not write workspace files.${hint}`
      );
    }

    // Archive: validate + commit before claiming COMPLETED.
    let archiveWritten: ReturnType<typeof ingestArchiveWriteback> | undefined;
    if (hasArchive) {
      const root = task.workspaceRoot ?? resolveWorkspaceRoot();
      archiveWritten = ingestArchiveWriteback(input.archive!, root);
      metadata = {
        ...metadata,
        artifacts: archiveWritten.artifacts,
        ...(archiveWritten.redaction
          ? {
              filesRedacted: true,
              redactionCount: archiveWritten.redaction.redactionCount,
              detectorIds: archiveWritten.redaction.detectorIds,
              modifiedForSecretRemoval: true,
            }
          : {}),
      };
    }

    const fromTimedOut = task.status === "TIMED_OUT";
    const changed = this.repo.saveResultIfOpen(
      input.taskId,
      sanitizedResult,
      metadata
    );
    if (changed !== 1) {
      const again = this.repo.getTaskById(input.taskId);
      if (!again) {
        throw new Error(`Task not found: ${input.taskId}`);
      }
      return this.reconcileCompletedSubmit(again, sanitizedResult, input.taskId);
    }

    let writebackRedaction: SecretRedactionDisclosure | undefined;
    if (hasArchive && archiveWritten) {
      writebackRedaction = archiveWritten.redaction;
      log({
        event: "RESULT_ARTIFACTS_WRITTEN",
        component: "task-service",
        taskId: input.taskId,
        message: `archive count=${archiveWritten.artifacts.length}`,
      });
    } else if (artifactCount > 0) {
      try {
        const root = task.workspaceRoot ?? resolveWorkspaceRoot();
        const written = writeResultArtifacts(input.artifacts!, root);
        writebackRedaction = written.redaction;
        metadata = {
          ...metadata,
          artifacts: written.artifacts,
          ...(writebackRedaction
            ? {
                filesRedacted: true,
                redactionCount: writebackRedaction.redactionCount,
                detectorIds: writebackRedaction.detectorIds,
                modifiedForSecretRemoval: true,
              }
            : {}),
        };
        this.repo.patchResultMetadataIfCompleted(input.taskId, metadata ?? {});
        log({
          event: "RESULT_ARTIFACTS_WRITTEN",
          component: "task-service",
          taskId: input.taskId,
          message: `count=${written.artifacts.length}${
            writebackRedaction
              ? ` redacted=${writebackRedaction.redactionCount} detectors=${writebackRedaction.detectorIds.join(",")}`
              : ""
          }`,
        });
      } catch (err) {
        log({
          event: "WARN",
          component: "task-service",
          taskId: input.taskId,
          message: `Task COMPLETED but artifact write failed after claim: ${
            err instanceof Error ? err.message : String(err)
          }`,
        });
        throw err;
      }
    } else if ((task.files?.length ?? 0) > 0) {
      log({
        event: "WARN",
        component: "task-service",
        taskId: input.taskId,
        message: `submit without artifacts (attachedFiles=${task.files?.length ?? 0})`,
      });
    }

    logTransition("task-service", input.taskId, task.status, "COMPLETED");
    log({
      event: "RESULT_RECEIVED",
      component: "task-service",
      taskId: input.taskId,
      message: fromTimedOut
        ? "Late submit after TIMED_OUT — result kept"
        : undefined,
    });
    this.recordUsageBestEffort(input.taskId, task.prompt, sanitizedResult);
    this.recordMcpWriteVerifiedForTask(input.taskId);
    return {
      success: true,
      status: "COMPLETED",
      lateSubmit: fromTimedOut || undefined,
      ...(writebackRedaction
        ? {
            filesRedacted: true,
            redactionCount: writebackRedaction.redactionCount,
            detectorIds: writebackRedaction.detectorIds,
            modifiedForSecretRemoval: true,
          }
        : {}),
    };
  }

  /** Persist attach-time secret redaction disclosure (ADR-005). */
  recordAttachSecretRedaction(
    taskId: string,
    disclosure: SecretRedactionDisclosure
  ): void {
    if (!disclosure.filesRedacted || disclosure.redactionCount <= 0) return;
    this.repo.setAttachSecretRedaction(taskId, {
      filesRedacted: true,
      redactionCount: disclosure.redactionCount,
      detectorIds: disclosure.detectorIds,
      files: disclosure.files,
    });
  }

  private static probeTokensEqual(submitted: string, stored: string): boolean {
    const a = Buffer.from(submitted.trim().toLowerCase(), "utf8");
    const b = Buffer.from(stored.trim().toLowerCase(), "utf8");
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  }

  /** Never fail submit if usage estimation blows up. */
  private recordUsageBestEffort(
    taskId: string,
    prompt: string,
    result: string
  ): void {
    try {
      if (getTaskUsage(getDatabase(), taskId)) return;
      const snap = estimateTaskUsage(prompt, result, loadCostConfig());
      insertTaskUsage(getDatabase(), taskId, snap, false);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log({
        event: "WARN",
        component: "task-service",
        taskId,
        message: `usage estimate skipped: ${message}`,
      });
    }
  }

  private reconcileCompletedSubmit(
    task: HandoffTask,
    incomingResult: string,
    taskId: string
  ): { success: boolean; status: "COMPLETED"; idempotent?: boolean } {
    if (task.status !== "COMPLETED") {
      throw new Error(
        `Cannot submit result for task in status ${task.status}`
      );
    }
    const existing = task.result ?? "";
    if (existing === incomingResult) {
      // Repair missing usage on idempotent replay.
      this.recordUsageBestEffort(taskId, task.prompt, existing);
      return { success: true, status: "COMPLETED", idempotent: true };
    }
    throw new Error(
      `Task already completed with a different result (idempotent conflict): ${taskId}`
    );
  }

  getResult(taskId: string): {
    status: HandoffTask["status"];
    result?: string;
    metadata?: HandoffResultMetadata;
    attachSecretRedaction?: SecretRedactionDisclosure;
  } {
    const task = this.repo.getTaskById(taskId);
    if (!task) {
      throw new Error(`Task not found: ${taskId}`);
    }

    const attachSecretRedaction = this.repo.getAttachSecretRedaction(taskId);

    return {
      status: task.status,
      result: task.result,
      metadata: task.resultMetadata,
      ...(attachSecretRedaction ? { attachSecretRedaction } : {}),
    };
  }

  getTaskStatus(taskId: string): { status: HandoffTask["status"] } {
    const task = this.repo.getTaskById(taskId);
    if (!task) {
      throw new Error(`Task not found: ${taskId}`);
    }
    return { status: task.status };
  }

  /** @deprecated Prefer markDispatchStarted (fence before UI). */
  markDispatched(taskId: string): void {
    const task = this.repo.getTaskById(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);

    assertTransition(task.status, "DISPATCHED");
    const now = new Date().toISOString();
    this.repo.updateTaskStatus(taskId, "DISPATCHED", { dispatchedAt: now });
    logTransition("browser-worker", taskId, task.status, "DISPATCHED");
    log({ event: "TASK_DISPATCHED", component: "browser-worker", taskId });
  }

  markDispatchStarted(
    taskId: string,
    workerId: string,
    leaseToken: string,
    instanceToken: string,
    leaseMs: number,
    workerStaleMs: number
  ): boolean {
    const ok = this.repo.markDispatchStarted(
      taskId,
      workerId,
      leaseToken,
      instanceToken,
      leaseMs,
      workerStaleMs
    );
    if (ok) {
      logTransition("browser-worker", taskId, "DISPATCHING", "DISPATCHED");
      log({ event: "TASK_DISPATCHED", component: "browser-worker", taskId });
    }
    return ok;
  }

  markNudgeStarted(
    taskId: string,
    workerId: string,
    leaseToken: string,
    instanceToken: string,
    leaseMs: number,
    workerStaleMs: number
  ): boolean {
    return this.repo.markNudgeStarted(
      taskId,
      workerId,
      leaseToken,
      instanceToken,
      leaseMs,
      workerStaleMs
    );
  }

  renewLease(
    taskId: string,
    workerId: string,
    leaseToken: string,
    instanceToken: string,
    leaseMs: number,
    workerStaleMs: number
  ): boolean {
    return this.repo.renewLease(
      taskId,
      workerId,
      leaseToken,
      instanceToken,
      leaseMs,
      workerStaleMs
    );
  }

  expireLeases(nowIso?: string): {
    requeued: number;
    timedOut: number;
    failed: number;
  } {
    return this.repo.expireLeases(nowIso);
  }

  markDispatchFailed(
    taskId: string,
    error: string,
    opts?: {
      workerId: string;
      leaseToken: string;
      instanceToken: string;
      /** When true, fail immediately — no requeue (UPLOAD_REJECTED, cleanup failure). */
      permanent?: boolean;
    }
  ): void {
    if (opts) {
      const outcome = this.repo.releasePreDispatchClaim(
        taskId,
        opts.workerId,
        opts.leaseToken,
        opts.instanceToken,
        error,
        opts.permanent === true
      );
      if (outcome === "requeued") {
        logTransition("browser-worker", taskId, "DISPATCHING", "QUEUED");
        return;
      }
      if (outcome === "failed") {
        log({
          event: "TASK_FAILED",
          component: "browser-worker",
          taskId,
          message: error,
        });
        return;
      }
    }

    const task = this.repo.getTaskById(taskId);
    if (!task) return;
    if (task.dispatchStartedAt) {
      // Post-fence failures must fail closed, not requeue.
      this.markSubmitTimedOut(taskId, error);
      return;
    }

    const retryCount = task.retryCount + 1;
    if (retryCount < 3) {
      this.repo.updateTaskStatus(taskId, "QUEUED", {
        retryCount,
        error,
        clearLease: true,
      });
      logTransition("browser-worker", taskId, task.status, "QUEUED");
    } else {
      this.repo.updateTaskStatus(taskId, "FAILED", {
        retryCount,
        error,
        clearLease: true,
      });
      log({
        event: "TASK_FAILED",
        component: "browser-worker",
        taskId,
        message: error,
      });
    }
  }

  markWaitingApproval(taskId: string): void {
    this.repo.updateTaskStatus(taskId, "WAITING_APPROVAL");
    log({
      event: "WORKER_NEEDS_APPROVAL",
      component: "browser-worker",
      taskId,
      message: "ChatGPT worker may require MCP write approval.",
    });
  }

  markSubmitTimedOut(taskId: string, reason?: string): void {
    const task = this.repo.getTaskById(taskId);
    if (!task) return;
    if (
      task.status === "COMPLETED" ||
      task.status === "TIMED_OUT" ||
      task.status === "FAILED" ||
      task.status === "CANCELLED"
    ) {
      return;
    }

    const error =
      reason ??
      "ChatGPT did not call handoff_submit_result within the approval window. " +
        "If the worker tab is still generating, wait — late submit is accepted. " +
        "If a MCP write confirmation card is visible, approve it. Otherwise retry.";

    assertTransition(task.status, "TIMED_OUT");
    const changed = this.repo.markTimedOutIfOpen(taskId, error);
    if (changed !== 1) {
      return;
    }
    logTransition("browser-worker", taskId, task.status, "TIMED_OUT");
    log({
      event: "TASK_TIMED_OUT",
      component: "browser-worker",
      taskId,
      message: error,
    });
  }

  markReadyButCursorIdle(taskId: string): void {
    const task = this.repo.getTaskById(taskId);
    if (!task || task.status !== "COMPLETED") return;

    this.repo.updateTaskStatus(taskId, "READY_BUT_CURSOR_IDLE");
    log({
      event: "CURSOR_WAIT_TIMEOUT",
      component: "cursor-hook",
      taskId,
      message: "Task completed after Cursor wait timeout. Manual resume required.",
    });
  }

  findPendingForConversation(conversationId: string): HandoffTask | null {
    return this.repo.findPendingByConversation(conversationId);
  }

  findUnresumedTerminalForConversation(
    conversationId: string
  ): HandoffTask | null {
    return this.repo.findUnresumedTerminalByConversation(conversationId);
  }

  claimTerminalFollowup(taskId: string): boolean {
    return this.repo.claimTerminalFollowup(taskId);
  }

  claimWaitTimeoutNotify(taskId: string): boolean {
    return this.repo.claimWaitTimeoutNotify(taskId);
  }

  findCompletedForConversation(conversationId: string): HandoffTask | null {
    return this.repo.findCompletedByConversation(conversationId);
  }

  claimNextQueued(
    workerId: string,
    instanceToken: string,
    leaseMs: number,
    workerStaleMs: number
  ): ClaimResult | null {
    return this.repo.claimNextQueued(
      workerId,
      instanceToken,
      leaseMs,
      workerStaleMs
    );
  }

  /** Increment chat budget after TASK_ID successfully sent (idempotent per task). */
  recordChatDispatch(
    workerId: string,
    taskId: string,
    chatUrl: string
  ): { recorded: boolean; tasksOnChat: number } {
    return this.repo.recordChatDispatch({ workerId, taskId, chatUrl });
  }
}
