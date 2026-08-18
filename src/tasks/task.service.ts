import { ulid } from "ulid";
import type { TaskRepository } from "./task.repository.js";
import { sanitizeContext, sanitizeSecrets } from "./sanitize.js";
import { assertTransition } from "./task-state.js";
import { log, logTransition } from "../logging/logger.js";
import type {
  ClaimResult,
  CreateTaskInput,
  HandoffTask,
  HandoffResultMetadata,
  SubmitResultInput,
} from "./task.types.js";
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
    };

    this.repo.insertTask(task);

    log({
      event: "TASK_CREATED",
      component: "task-service",
      taskId: id,
      message: `type=${input.type}`,
    });

    return { taskId: id, status: "QUEUED" };
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
      return { ...task, status: "PROCESSING", processingAt: now };
    }

    return task;
  }

  submitResult(input: SubmitResultInput): {
    success: boolean;
    status: "COMPLETED";
    idempotent?: boolean;
    lateSubmit?: boolean;
  } {
    const task = this.repo.getTaskById(input.taskId);
    if (!task) {
      throw new Error(`Task not found: ${input.taskId}`);
    }

    const sanitizedResult = sanitizeSecrets(input.result);
    const metadata = input.metadata
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

    const fromTimedOut = task.status === "TIMED_OUT";
    const changed = this.repo.saveResultIfOpen(
      input.taskId,
      sanitizedResult,
      metadata
    );
    if (changed === 1) {
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
      return {
        success: true,
        status: "COMPLETED",
        lateSubmit: fromTimedOut || undefined,
      };
    }

    const again = this.repo.getTaskById(input.taskId);
    if (!again) {
      throw new Error(`Task not found: ${input.taskId}`);
    }
    return this.reconcileCompletedSubmit(again, sanitizedResult, input.taskId);
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
  } {
    const task = this.repo.getTaskById(taskId);
    if (!task) {
      throw new Error(`Task not found: ${taskId}`);
    }

    return {
      status: task.status,
      result: task.result,
      metadata: task.resultMetadata,
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
    }
  ): void {
    if (opts) {
      const outcome = this.repo.releasePreDispatchClaim(
        taskId,
        opts.workerId,
        opts.leaseToken,
        opts.instanceToken,
        error
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
