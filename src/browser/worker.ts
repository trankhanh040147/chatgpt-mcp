import { initDatabase, getDatabase } from "../db/sqlite.js";
import { TaskRepository } from "../tasks/task.repository.js";
import { TaskService } from "../tasks/task.service.js";
import { WorkerStateManager } from "./worker-state.js";
import { ChatGptBrowser } from "./chatgpt.js";
import { log } from "../logging/logger.js";
import type { WorkerStatus } from "../tasks/task.types.js";

export interface BrowserWorkerOptions {
  dbPath: string;
  cdpEndpoint: string;
  workerUrl: string;
  chatGptUrl: string;
  pollIntervalMs: number;
  approvalTimeoutMs: number;
  rateLimitBackoffMs: number[];
}

const BLOCKING_STATUSES: WorkerStatus[] = ["SESSION_LOST", "ERROR"];

/** Nudge ChatGPT if submit has not landed by these elapsed ms since dispatch. */
const NUDGE_AT_MS = [30_000, 90_000] as const;

export class BrowserWorker {
  private running = false;
  private rateLimitRetryIndex = 0;
  private browser: ChatGptBrowser | null = null;
  /** In-flight task polled across ticks — worker stays READY for HTTP but won't claim another. */
  private activeTaskId: string | null = null;
  private activeTaskStartedAt = 0;
  private nudgeStage = 0;

  constructor(private readonly options: BrowserWorkerOptions) {}

  async start(): Promise<void> {
    initDatabase(this.options.dbPath);
    const repo = new TaskRepository(getDatabase());
    const taskService = new TaskService(repo);
    const workerState = new WorkerStateManager(repo);

    const browser = new ChatGptBrowser({
      cdpEndpoint: this.options.cdpEndpoint,
      workerUrl: this.options.workerUrl,
      chatGptUrl: this.options.chatGptUrl,
    });
    this.browser = browser;

    this.running = true;
    workerState.setStatus("STARTING");

    try {
      await browser.connect();

      const sessionReady = await browser.ensureSessionReady();
      if (!sessionReady) {
        workerState.setStatus("SESSION_LOST", {
          error: "SESSION_NOT_READY: log into ChatGPT in the attached Chrome",
        });
        while (this.running) {
          await sleep(10_000);
          const ok = await browser.ensureSessionReady();
          if (ok) break;
        }
        if (!this.running) return;
      }

      await browser.openWorkerConversation();
      this.recoverOnStart(taskService, workerState);
      workerState.setStatus("READY", { currentTaskId: null, error: null });

      log({
        event: "INFO",
        component: "browser-worker",
        message: "Browser worker ready (CDP attach)",
      });

      while (this.running) {
        await this.tick(taskService, workerState, browser);
        await sleep(this.options.pollIntervalMs);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      workerState.setStatus("ERROR", { error: message });
      await browser.screenshotOnFailure("worker-crash");
      log({
        event: "ERROR",
        component: "browser-worker",
        message,
      });
      throw err;
    }
  }

  stop(): void {
    this.running = false;
  }

  async close(): Promise<void> {
    this.running = false;
    await this.browser?.close();
  }

  private async tick(
    taskService: TaskService,
    workerState: WorkerStateManager,
    browser: ChatGptBrowser
  ): Promise<void> {
    if (this.activeTaskId) {
      await this.pollActiveTask(taskService, workerState, browser);
      return;
    }

    const status = workerState.getStatus();

    if (status === "RATE_LIMITED") {
      const backoff =
        this.options.rateLimitBackoffMs[this.rateLimitRetryIndex] ??
        this.options.rateLimitBackoffMs.at(-1)!;
      await sleep(backoff);
      this.rateLimitRetryIndex = Math.min(
        this.rateLimitRetryIndex + 1,
        this.options.rateLimitBackoffMs.length - 1
      );
      workerState.setStatus("READY");
      return;
    }

    if (BLOCKING_STATUSES.includes(status)) {
      return;
    }

    if (status !== "READY") {
      return;
    }

    const task = taskService.claimNextQueued();
    if (!task) {
      await this.checkStaleOpenTasks(taskService);
      return;
    }

    workerState.setStatus("BUSY", { currentTaskId: task.id });

    try {
      const rateLimited = await browser.detectRateLimit();
      if (rateLimited) {
        taskService.markDispatchFailed(task.id, "Rate limited");
        workerState.setStatus("RATE_LIMITED");
        log({
          event: "RATE_LIMITED",
          component: "browser-worker",
          taskId: task.id,
        });
        return;
      }

      await browser.openWorkerConversation();
      await browser.submitTaskId(task.id);
      taskService.markDispatched(task.id);

      this.activeTaskId = task.id;
      this.activeTaskStartedAt = Date.now();
      this.nudgeStage = 0;
      workerState.setStatus("BUSY", { currentTaskId: task.id });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await browser.screenshotOnFailure(task.id);
      taskService.markDispatchFailed(task.id, message);
      log({
        event: "WARN",
        component: "browser-worker",
        taskId: task.id,
        message: `Dispatch failed (will retry if remaining): ${message}`,
      });
      workerState.setStatus("READY", { currentTaskId: null, error: null });
    }
  }

  private async pollActiveTask(
    taskService: TaskService,
    workerState: WorkerStateManager,
    browser: ChatGptBrowser
  ): Promise<void> {
    const taskId = this.activeTaskId!;
    const elapsed = Date.now() - this.activeTaskStartedAt;
    const { status } = taskService.getTaskStatus(taskId);

    if (status === "COMPLETED") {
      this.clearActiveTask(workerState);
      this.rateLimitRetryIndex = 0;
      return;
    }

    if (
      status === "FAILED" ||
      status === "TIMED_OUT" ||
      status === "CANCELLED"
    ) {
      this.clearActiveTask(workerState);
      return;
    }

    workerState.setStatus("BUSY", { currentTaskId: taskId });

    if (this.nudgeStage < NUDGE_AT_MS.length) {
      const nextAt = NUDGE_AT_MS[this.nudgeStage]!;
      if (elapsed >= nextAt) {
        try {
          await browser.sendSubmitNudge(taskId);
        } catch {
          // Nudge is best-effort; timeout path still fails the task.
        }
        this.nudgeStage += 1;
      }
    }

    if (elapsed >= this.options.approvalTimeoutMs) {
      taskService.markSubmitTimedOut(taskId);
      this.clearActiveTask(workerState);
      log({
        event: "TASK_TIMED_OUT",
        component: "browser-worker",
        taskId,
        message:
          "Submit approval window expired — task TIMED_OUT; worker free for next QUEUED task",
      });
    }
  }

  private clearActiveTask(workerState: WorkerStateManager): void {
    this.activeTaskId = null;
    this.activeTaskStartedAt = 0;
    this.nudgeStage = 0;
    workerState.setStatus("READY", { currentTaskId: null, error: null });
  }

  private recoverOnStart(
    taskService: TaskService,
    workerState: WorkerStateManager
  ): void {
    const repo = new TaskRepository(getDatabase());
    const nowIso = new Date(Date.now() + 1000).toISOString();
    const staleIso = new Date(
      Date.now() - this.options.approvalTimeoutMs
    ).toISOString();

    for (const task of repo.findStuckDispatching(nowIso)) {
      taskService.markDispatchFailed(
        task.id,
        "Recovered stuck DISPATCHING on worker start"
      );
    }

    for (const task of repo.findStaleOpenTasks(staleIso)) {
      taskService.markSubmitTimedOut(
        task.id,
        "Recovered stale in-flight task on worker start"
      );
    }

    for (const task of repo.findLegacyWaitingApproval()) {
      taskService.markSubmitTimedOut(
        task.id,
        "Recovered legacy WAITING_APPROVAL on worker start"
      );
    }

    const prev = workerState.getStatus();
    if (prev !== "READY") {
      log({
        event: "INFO",
        component: "browser-worker",
        message: `recoverOnStart: clearing worker status ${prev} → READY`,
      });
    }
    this.clearActiveTask(workerState);
  }

  private async checkStaleOpenTasks(taskService: TaskService): Promise<void> {
    const repo = new TaskRepository(getDatabase());
    const threshold = new Date(
      Date.now() - this.options.approvalTimeoutMs
    ).toISOString();

    for (const task of repo.findStaleOpenTasks(threshold)) {
      taskService.markSubmitTimedOut(
        task.id,
        "Stale in-flight task timed out while worker idle"
      );
    }

    for (const task of repo.findLegacyWaitingApproval()) {
      taskService.markSubmitTimedOut(
        task.id,
        "Legacy WAITING_APPROVAL cleared while worker idle"
      );
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function startBrowserWorker(
  options: BrowserWorkerOptions
): Promise<BrowserWorker> {
  const worker = new BrowserWorker(options);
  void worker.start().catch((err) => {
    const message = err instanceof Error ? err.message : String(err);
    log({
      event: "ERROR",
      component: "browser-worker",
      message: `Worker start failed (process stays up for /health): ${message}`,
    });
  });
  return worker;
}
