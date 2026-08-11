import { initDatabase, getDatabase } from "../db/sqlite.js";
import { TaskRepository } from "../tasks/task.repository.js";
import { TaskService } from "../tasks/task.service.js";
import { WorkerStateManager } from "./worker-state.js";
import { ChatGptBrowser } from "./chatgpt.js";
import { log } from "../logging/logger.js";

export interface BrowserWorkerOptions {
  dbPath: string;
  profilePath: string;
  chatGptUrl: string;
  workerConversationTitle: string;
  pollIntervalMs: number;
  approvalTimeoutMs: number;
  rateLimitBackoffMs: number[];
  browserChannel?: string;
}

export class BrowserWorker {
  private running = false;
  private rateLimitRetryIndex = 0;
  private browser: ChatGptBrowser | null = null;

  constructor(private readonly options: BrowserWorkerOptions) {}

  async start(): Promise<void> {
    initDatabase(this.options.dbPath);
    const repo = new TaskRepository(getDatabase());
    const taskService = new TaskService(repo);
    const workerState = new WorkerStateManager(repo);

    const browser = new ChatGptBrowser({
      profilePath: this.options.profilePath,
      chatGptUrl: this.options.chatGptUrl,
      workerConversationTitle: this.options.workerConversationTitle,
      channel: this.options.browserChannel,
    });
    this.browser = browser;

    this.running = true;
    workerState.setStatus("STARTING");

    try {
      await browser.launch();

      const loggedIn = await browser.ensureLoggedIn();
      if (!loggedIn) {
        workerState.setStatus("SESSION_LOST", {
          error: "Manual login required",
        });
        return;
      }

      await browser.openWorkerConversation();
      workerState.setStatus("READY");

      log({
        event: "INFO",
        component: "browser-worker",
        message: "Browser worker ready",
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

  /** Closes the persistent browser context so cookies/session data flush to disk. */
  async close(): Promise<void> {
    this.running = false;
    await this.browser?.close();
  }

  private async tick(
    taskService: TaskService,
    workerState: WorkerStateManager,
    browser: ChatGptBrowser
  ): Promise<void> {
    workerState.setStatus("READY");

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
    }

    if (!workerState.isReady()) return;

    const task = taskService.claimNextQueued();
    if (!task) {
      await this.checkStaleDispatched(taskService, workerState);
      return;
    }

    workerState.setStatus("BUSY", { currentTaskId: task.id });

    try {
      const rateLimited = await browser.detectRateLimit();
      if (rateLimited) {
        taskService.markDispatchFailed(task.id, "Rate limited");
        workerState.setStatus("RATE_LIMITED");
        log({ event: "RATE_LIMITED", component: "browser-worker", taskId: task.id });
        return;
      }

      await browser.openWorkerConversation();
      await browser.submitTaskId(task.id);
      taskService.markDispatched(task.id);
      workerState.setStatus("BUSY", { currentTaskId: task.id });

      await this.waitForCompletionOrApproval(
        taskService,
        workerState,
        task.id
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await browser.screenshotOnFailure(task.id);
      taskService.markDispatchFailed(task.id, message);
      workerState.setStatus("ERROR", { error: message, currentTaskId: null });
      await sleep(5000);
      workerState.setStatus("READY", { currentTaskId: null, error: null });
    }
  }

  private async waitForCompletionOrApproval(
    taskService: TaskService,
    workerState: WorkerStateManager,
    taskId: string
  ): Promise<void> {
    const deadline = Date.now() + this.options.approvalTimeoutMs;

    while (Date.now() < deadline && this.running) {
      const { status } = taskService.getTaskStatus(taskId);

      if (status === "COMPLETED" || status === "PROCESSING") {
        workerState.setStatus("READY", { currentTaskId: null });
        this.rateLimitRetryIndex = 0;
        return;
      }

      if (status === "FAILED" || status === "TIMED_OUT") {
        workerState.setStatus("READY", { currentTaskId: null });
        return;
      }

      await sleep(this.options.pollIntervalMs);
    }

    const { status } = taskService.getTaskStatus(taskId);
    if (status === "DISPATCHED") {
      taskService.markWaitingApproval(taskId);
      workerState.setStatus("NEEDS_APPROVAL", { currentTaskId: taskId });
    } else {
      workerState.setStatus("READY", { currentTaskId: null });
    }
  }

  private async checkStaleDispatched(
    taskService: TaskService,
    workerState: WorkerStateManager
  ): Promise<void> {
    const repo = new TaskRepository(getDatabase());
    const threshold = new Date(
      Date.now() - this.options.approvalTimeoutMs
    ).toISOString();
    const stale = repo.findStaleDispatched(threshold);

    for (const task of stale) {
      taskService.markWaitingApproval(task.id);
      workerState.setStatus("NEEDS_APPROVAL", { currentTaskId: task.id });
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
  void worker.start();
  return worker;
}
