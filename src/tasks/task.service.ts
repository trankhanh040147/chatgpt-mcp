import { ulid } from "ulid";
import type { TaskRepository } from "./task.repository.js";
import { sanitizeContext, sanitizeSecrets } from "./sanitize.js";
import { assertTransition } from "./task-state.js";
import { log, logTransition } from "../logging/logger.js";
import type {
  CreateTaskInput,
  HandoffTask,
  HandoffResultMetadata,
  SubmitResultInput,
} from "./task.types.js";

const MAX_DISPATCH_RETRIES = 3;

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
      task.status !== "WAITING_APPROVAL"
    ) {
      throw new Error(
        `Cannot submit result for task in status ${task.status}`
      );
    }

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
      });
      return { success: true, status: "COMPLETED" };
    }

    // Lost race — another submit completed first.
    const again = this.repo.getTaskById(input.taskId);
    if (!again) {
      throw new Error(`Task not found: ${input.taskId}`);
    }
    return this.reconcileCompletedSubmit(again, sanitizedResult, input.taskId);
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

  markDispatched(taskId: string): void {
    const task = this.repo.getTaskById(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);

    assertTransition(task.status, "DISPATCHED");
    const now = new Date().toISOString();
    this.repo.updateTaskStatus(taskId, "DISPATCHED", { dispatchedAt: now });
    logTransition("browser-worker", taskId, task.status, "DISPATCHED");
    log({ event: "TASK_DISPATCHED", component: "browser-worker", taskId });
  }

  markDispatchFailed(taskId: string, error: string): void {
    const task = this.repo.getTaskById(taskId);
    if (!task) return;

    const retryCount = task.retryCount + 1;
    if (retryCount < MAX_DISPATCH_RETRIES) {
      this.repo.updateTaskStatus(taskId, "QUEUED", { retryCount, error });
      logTransition("browser-worker", taskId, task.status, "QUEUED");
    } else {
      this.repo.updateTaskStatus(taskId, "FAILED", { retryCount, error });
      log({ event: "TASK_FAILED", component: "browser-worker", taskId, message: error });
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

  claimNextQueued(): HandoffTask | null {
    return this.repo.claimOldestQueued();
  }
}
