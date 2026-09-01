import { randomBytes } from "node:crypto";
import { initDatabase, getDatabase } from "../db/sqlite.js";
import { TaskRepository } from "../tasks/task.repository.js";
import { TaskService } from "../tasks/task.service.js";
import { WorkerStateManager } from "./worker-state.js";
import { ChatGptBrowser } from "./chatgpt.js";
import { createNativeDeliveryTarget } from "../transport/native-delivery.js";
import { materializeWorkspaceResources } from "../tasks/files.js";
import { HandoffFileError } from "../tasks/task.types.js";
import {
  cleanupPreparedAttachSession,
  type PreparedAttachSession,
} from "./attachment-lifecycle.js";
import type { UiWriteMutex } from "./ui-write-mutex.js";
import { log } from "../logging/logger.js";
import type { WorkerStatus } from "../tasks/task.types.js";
import { DEFAULT_WORKER_ID } from "../tasks/task.types.js";
import { classifyProbeFailure } from "../mcp/probe-failure.js";

export interface BrowserWorkerOptions {
  dbPath: string;
  cdpEndpoint: string;
  workerUrl: string;
  chatGptUrl: string;
  pollIntervalMs: number;
  approvalTimeoutMs: number;
  /** Wall-clock cap even while ChatGPT is still generating. Default 3× approval or 15m. */
  hardTimeoutMs?: number;
  rateLimitBackoffMs: number[];
  workerId?: string;
  leaseMs?: number;
  workerStaleMs?: number;
  /** When true, this process does not own HTTP (status-api is separate). */
  browserOnly?: boolean;
  /**
   * Broker-injected page adapter (A1-S). When set, this actor does not open
   * or close the CDP connection.
   */
  sharedBrowser?: ChatGptBrowser;
  /**
   * Broker: resolve the current page adapter (may change after CDP reconnect).
   * Takes precedence over sharedBrowser when present.
   */
  resolveSharedBrowser?: () => ChatGptBrowser;
  /** Global UI-write mutex — assert + type/send only (not claim/renew/CAS). */
  uiWriteMutex?: UiWriteMutex;
  /** Fail-closed chat/page check immediately before irreversible write. */
  assertBindingFresh?: () => void;
}

const BLOCKING_STATUSES: WorkerStatus[] = ["SESSION_LOST", "ERROR"];

/** Single nudge window (0.2.0: at most one fenced nudge). */
const NUDGE_AT_MS = 30_000;

export class BrowserWorker {
  private running = false;
  private rateLimitRetryIndex = 0;
  private browser: ChatGptBrowser | null = null;
  private workerState: WorkerStateManager | null = null;
  private repo: TaskRepository | null = null;
  private activeTaskId: string | null = null;
  private activeLeaseToken: string | null = null;
  private activeTaskStartedAt = 0;
  private nudgeSent = false;
  private deferredTimeoutLogged = false;
  private holdAfterTimeoutLogged = false;
  private timedOutIdleSince = 0;
  private readonly workerId: string;
  private readonly instanceToken: string;
  private readonly leaseMs: number;
  private readonly workerStaleMs: number;
  private readonly hardTimeoutMs: number;

  constructor(private readonly options: BrowserWorkerOptions) {
    this.workerId = options.workerId?.trim() || DEFAULT_WORKER_ID;
    this.instanceToken = `inst_${randomBytes(16).toString("hex")}`;
    this.leaseMs =
      options.leaseMs ??
      Math.max(120_000, options.pollIntervalMs * 10, options.approvalTimeoutMs);
    this.workerStaleMs =
      options.workerStaleMs ?? Math.max(this.leaseMs * 2, 60_000);
    this.hardTimeoutMs = Math.max(
      options.hardTimeoutMs ?? Math.max(options.approvalTimeoutMs * 3, 900_000),
      options.approvalTimeoutMs
    );
  }

  async start(): Promise<void> {
    initDatabase(this.options.dbPath);
    const repo = new TaskRepository(getDatabase());
    this.repo = repo;
    const taskService = new TaskService(repo);

    repo.registerWorkerInstance({
      workerId: this.workerId,
      instanceToken: this.instanceToken,
      workerUrl: this.options.workerUrl,
      cdpEndpoint: this.options.cdpEndpoint,
      httpPort: null,
      staleMs: this.workerStaleMs,
      pid: process.pid,
    });

    const workerState = new WorkerStateManager(
      repo,
      this.workerId,
      this.instanceToken
    );
    this.workerState = workerState;

    const ownsCdp = !this.isSharedCdp();
    const browser = ownsCdp
      ? new ChatGptBrowser({
          cdpEndpoint: this.options.cdpEndpoint,
          workerUrl: this.options.workerUrl,
          chatGptUrl: this.options.chatGptUrl,
        })
      : this.resolveBrowser();
    this.browser = browser;

    this.running = true;
    workerState.setStatus("STARTING");

    // Lease + worker heartbeat independent of tick/Playwright (event-loop only).
    // Interval ≈ leaseMs/6 so several renewals fit before expiry (P0 continuous renew).
    const renewEveryMs = Math.min(
      30_000,
      Math.max(5_000, Math.floor(this.leaseMs / 6))
    );
    let renewing = false;
    const heartbeat = setInterval(() => {
      if (!this.running || renewing) return;
      renewing = true;
      try {
        if (this.activeTaskId && this.activeLeaseToken) {
          const ok = taskService.renewLease(
            this.activeTaskId,
            this.workerId,
            this.activeLeaseToken,
            this.instanceToken,
            this.leaseMs,
            this.workerStaleMs
          );
          if (!ok) {
            log({
              event: "WARN",
              component: "browser-worker",
              taskId: this.activeTaskId,
              message: "Lease heartbeat lost ownership — clearing active task",
            });
            this.clearActiveTask(workerState);
          }
        } else {
          workerState.touchHeartbeat();
        }
      } catch {
        // best-effort — do not clear on transient throw
      } finally {
        renewing = false;
      }
    }, renewEveryMs);
    heartbeat.unref?.();

    while (this.running) {
      try {
        const browser = this.resolveBrowser();
        this.browser = browser;
        await browser.connect();

        const sessionReady = await browser.ensureSessionReady();
        if (!sessionReady) {
          workerState.setStatus("SESSION_LOST", {
            error: "SESSION_NOT_READY: log into ChatGPT in the attached Chrome",
          });
          while (this.running) {
            await sleep(10_000);
            const ok = await this.resolveBrowser().ensureSessionReady();
            if (ok) break;
          }
          if (!this.running) break;
        }

        await browser.openWorkerConversation();
        this.recoverOnStart(taskService, workerState);
        workerState.setStatus("READY", { currentTaskId: null, error: null });

        log({
          event: "INFO",
          component: "browser-worker",
          message: `Browser worker ready id=${this.workerId} (CDP attach)`,
        });

        while (this.running) {
          const live = this.resolveBrowser();
          this.browser = live;
          await this.tick(taskService, workerState, live);
          await sleep(this.options.pollIntervalMs);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (
          this.isSharedCdp() &&
          (message.includes("No broker binding") ||
            message.includes(`Worker ${this.workerId} not found`))
        ) {
          log({
            event: "INFO",
            component: "browser-worker",
            message: `Actor ${this.workerId} stopping: ${message}`,
          });
          this.running = false;
          break;
        }
        workerState.setStatus("ERROR", { error: message });
        await this.browser
          ?.screenshotOnFailure("worker-crash")
          .catch(() => undefined);
        log({
          event: "ERROR",
          component: "browser-worker",
          message: `Worker loop error (will reconnect): ${message}`,
        });
        this.activeTaskId = null;
        this.activeLeaseToken = null;
        const backoffMs =
          message.includes("CHAT_ACCESS_DENIED") ||
          message.includes("redirected away from chat") ||
          message.includes("Failed to bind") ||
          message.includes("Worker conversation not ready")
            ? 120_000
            : 5_000;
        await sleep(backoffMs);
        if (ownsCdp) {
          try {
            await this.browser?.close();
          } catch {
            // ignore
          }
        }
      }
    }

    clearInterval(heartbeat);
  }

  stop(): void {
    this.running = false;
  }

  /** Broker rebound this worker to a new tab — drop stale in-memory dispatch. */
  clearActiveTaskForBindingChange(): void {
    if (this.workerState) {
      this.clearActiveTask(this.workerState);
    } else {
      this.activeTaskId = null;
      this.activeLeaseToken = null;
      this.activeTaskStartedAt = 0;
      this.nudgeSent = false;
    }
  }

  async close(): Promise<void> {
    this.running = false;
    try {
      this.repo?.releaseWorkerInstance(this.workerId, this.instanceToken);
    } catch {
      // best-effort
    }
    if (!this.isSharedCdp()) {
      await this.browser?.close();
    }
  }

  private isSharedCdp(): boolean {
    return Boolean(
      this.options.resolveSharedBrowser || this.options.sharedBrowser
    );
  }

  private resolveBrowser(): ChatGptBrowser {
    if (this.options.resolveSharedBrowser) {
      return this.options.resolveSharedBrowser();
    }
    if (this.options.sharedBrowser) {
      return this.options.sharedBrowser;
    }
    if (this.browser) {
      return this.browser;
    }
    throw new Error("Browser not ready");
  }

  private async withUiWrite<T>(fn: () => Promise<T>): Promise<T> {
    const mutex = this.options.uiWriteMutex;
    if (!mutex) return fn();
    return mutex.run(fn);
  }

  private async tick(
    taskService: TaskService,
    workerState: WorkerStateManager,
    browser: ChatGptBrowser
  ): Promise<void> {
    if (this.activeTaskId && this.activeLeaseToken) {
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
      workerState.touchHeartbeat();
      return;
    }

    if (status !== "READY") {
      workerState.touchHeartbeat();
      return;
    }

    const claimed = taskService.claimNextQueued(
      this.workerId,
      this.instanceToken,
      this.leaseMs,
      this.workerStaleMs
    );
    if (!claimed) {
      workerState.touchHeartbeat();
      return;
    }

    const { task, leaseToken } = claimed;
    // Arm lease heartbeat immediately — covers prep + fence + type, not only post-send.
    this.activeTaskId = task.id;
    this.activeLeaseToken = leaseToken;
    this.activeTaskStartedAt = Date.now();
    this.nudgeSent = false;
    this.deferredTimeoutLogged = false;
    this.holdAfterTimeoutLogged = false;
    this.timedOutIdleSince = 0;
    workerState.setStatus("BUSY", { currentTaskId: task.id });
    taskService.renewLease(
      task.id,
      this.workerId,
      leaseToken,
      this.instanceToken,
      this.leaseMs,
      this.workerStaleMs
    );

    let attachSession: PreparedAttachSession | null = null;

    try {
      const rateLimited = await browser.detectRateLimit();
      if (rateLimited) {
        taskService.markDispatchFailed(task.id, "Rate limited", {
          workerId: this.workerId,
          leaseToken,
          instanceToken: this.instanceToken,
        });
        this.activeTaskId = null;
        this.activeLeaseToken = null;
        workerState.setStatus("RATE_LIMITED");
        log({
          event: "RATE_LIMITED",
          component: "browser-worker",
          taskId: task.id,
        });
        return;
      }

      // Reversible prep — open conversation + attach resources (outside fence).
      await browser.openWorkerConversation();
      if (
        !taskService.renewLease(
          task.id,
          this.workerId,
          leaseToken,
          this.instanceToken,
          this.leaseMs,
          this.workerStaleMs
        )
      ) {
        log({
          event: "WARN",
          component: "browser-worker",
          taskId: task.id,
          message: "Lost lease during prep — aborting without chat write",
        });
        this.clearActiveTask(workerState);
        return;
      }

      await browser.waitUntilComposerIdle();

      const taskFiles = task.files ?? [];
      if (taskFiles.length > 0) {
        const transport = createNativeDeliveryTarget(browser.getPage());
        let preparedResources;
        try {
          const root = task.workspaceRoot;
          if (!root) {
            throw new HandoffFileError(
              "FILES_INVALID",
              "Task missing workspace root for file materialization"
            );
          }
          preparedResources = materializeWorkspaceResources(taskFiles, root);
        } catch (err) {
          const code =
            err instanceof HandoffFileError ? err.code : "FILES_INVALID";
          const errMsg = `Resource materialize failed: ${code}`;
          const permanent =
            code === "FILES_SECRET_DETECTED" ||
            code === "FILE_TOO_LARGE" ||
            code === "FILES_INVALID" ||
            code === "RESOURCES_MCP_DEFERRED";
          taskService.markDispatchFailed(task.id, errMsg, {
            workerId: this.workerId,
            leaseToken,
            instanceToken: this.instanceToken,
            permanent,
          });
          log({
            event: "WARN",
            component: "browser-worker",
            taskId: task.id,
            message: `${errMsg} (permanent=${permanent})`,
          });
          this.clearActiveTask(workerState);
          return;
        }

        attachSession = { transport, prepared: false };

        const prepared = await this.withUiWrite(async () => {
          this.options.assertBindingFresh?.();
          return transport.prepare(preparedResources, task.id);
        });

        if (!prepared.ok) {
          attachSession.prepared = true;
          const clean = await this.cleanupPreparedAttachments(
            task.id,
            attachSession
          );
          const failOpts = {
            workerId: this.workerId,
            leaseToken,
            instanceToken: this.instanceToken,
          };
          const errMsg = `Resource prepare failed: ${prepared.reason}`;

          if (!clean) {
            taskService.markDispatchFailed(task.id, `${errMsg}; composer not clean`, {
              ...failOpts,
              permanent: true,
            });
          } else if (prepared.retryable) {
            taskService.markDispatchFailed(task.id, errMsg, failOpts);
          } else {
            taskService.markDispatchFailed(task.id, errMsg, {
              ...failOpts,
              permanent: true,
            });
          }

          log({
            event: "WARN",
            component: "browser-worker",
            taskId: task.id,
            message: `${errMsg} (retryable=${prepared.retryable}, clean=${clean})`,
          });
          this.clearActiveTask(workerState);
          return;
        }

        attachSession.prepared = true;
      }

      const abortBeforeTaskIdSend = async (
        message: string,
        opts?: {
          markDispatchFailed?: boolean;
          permanent?: boolean;
        }
      ): Promise<void> => {
        const clean = await this.cleanupPreparedAttachments(
          task.id,
          attachSession
        );
        const failOpts = {
          workerId: this.workerId,
          leaseToken,
          instanceToken: this.instanceToken,
        };
        if (!clean) {
          taskService.markDispatchFailed(
            task.id,
            `${message}; composer not clean after attachment cleanup`,
            { ...failOpts, permanent: true }
          );
          log({
            event: "WARN",
            component: "browser-worker",
            taskId: task.id,
            message: `${message} — composer not clean after cleanup (fail-closed)`,
          });
        } else if (opts?.markDispatchFailed) {
          taskService.markDispatchFailed(task.id, message, {
            ...failOpts,
            permanent: opts.permanent,
          });
        }
        log({
          event: "WARN",
          component: "browser-worker",
          taskId: task.id,
          message,
        });
        this.clearActiveTask(workerState);
      };

      // Lease CAS outside UI mutex (must not stall other actors on DB/MCP).
      const fenced = taskService.markDispatchStarted(
        task.id,
        this.workerId,
        leaseToken,
        this.instanceToken,
        this.leaseMs,
        this.workerStaleMs
      );
      if (!fenced) {
        await abortBeforeTaskIdSend("Dispatch fence CAS failed — not touching chat", {
          markDispatchFailed: true,
        });
        return;
      }

      if (
        this.activeTaskId !== task.id ||
        !taskService.renewLease(
          task.id,
          this.workerId,
          leaseToken,
          this.instanceToken,
          this.leaseMs,
          this.workerStaleMs
        )
      ) {
        await abortBeforeTaskIdSend(
          "Lost lease after fence — skip TASK_ID type (fail-closed)",
          { markDispatchFailed: false }
        );
        return;
      }

      // POINT OF NO RETURN — dispatch_started_at set; no automatic redispatch.
      await this.withUiWrite(async () => {
        this.options.assertBindingFresh?.();
        await browser.submitTaskId(task.id, {
          skipIdleWait: true,
          attachmentCount: taskFiles.length,
        });
      });

      const budget = taskService.recordChatDispatch(
        this.workerId,
        task.id,
        this.options.workerUrl
      );
      log({
        event: "INFO",
        component: "browser-worker",
        taskId: task.id,
        message: budget.recorded
          ? `Chat dispatch recorded (${budget.tasksOnChat} on chat)`
          : `Chat dispatch already recorded (${budget.tasksOnChat} on chat)`,
      });

      taskService.renewLease(
        task.id,
        this.workerId,
        leaseToken,
        this.instanceToken,
        this.leaseMs,
        this.workerStaleMs
      );
      workerState.setStatus("BUSY", { currentTaskId: task.id });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.cleanupPreparedAttachments(task.id, attachSession);
      await browser.screenshotOnFailure(task.id);
      taskService.markDispatchFailed(task.id, message, {
        workerId: this.workerId,
        leaseToken,
        instanceToken: this.instanceToken,
      });
      log({
        event: "WARN",
        component: "browser-worker",
        taskId: task.id,
        message: `Dispatch failed (will retry if remaining): ${message}`,
      });
      this.clearActiveTask(workerState);
    }
  }

  private async pollActiveTask(
    taskService: TaskService,
    workerState: WorkerStateManager,
    browser: ChatGptBrowser
  ): Promise<void> {
    const taskId = this.activeTaskId!;
    const leaseToken = this.activeLeaseToken!;
    const elapsed = Date.now() - this.activeTaskStartedAt;

    // Check terminal status BEFORE renew — COMPLETED is not a lease loss.
    const { status } = taskService.getTaskStatus(taskId);
    if (status === "COMPLETED") {
      this.clearActiveTask(workerState);
      this.rateLimitRetryIndex = 0;
      return;
    }
    if (status === "FAILED" || status === "CANCELLED") {
      this.clearActiveTask(workerState);
      return;
    }

    const generating = await browser.isGenerating().catch(() => false);

    if (status === "TIMED_OUT") {
      // Don't inject a new TASK_ID into a chat that is still finishing.
      if (generating) {
        this.timedOutIdleSince = 0;
        if (!this.holdAfterTimeoutLogged) {
          this.holdAfterTimeoutLogged = true;
          log({
            event: "INFO",
            component: "browser-worker",
            taskId,
            message:
              "TIMED_OUT but ChatGPT is still generating — holding worker for late submit",
          });
        }
        return;
      }
      if (this.timedOutIdleSince === 0) {
        this.timedOutIdleSince = Date.now();
      }
      // MCP submit can land after the stop button disappears.
      if (Date.now() - this.timedOutIdleSince < 20_000) {
        return;
      }
      this.clearActiveTask(workerState);
      return;
    }

    const renewed = taskService.renewLease(
      taskId,
      this.workerId,
      leaseToken,
      this.instanceToken,
      this.leaseMs,
      this.workerStaleMs
    );
    if (!renewed) {
      log({
        event: "WARN",
        component: "browser-worker",
        taskId,
        message: "Lost lease/incarnation — dropping active task without chat write",
      });
      this.clearActiveTask(workerState);
      return;
    }

    workerState.setStatus("BUSY", { currentTaskId: taskId });

    const taskRow = this.repo?.getTaskById(taskId);
    const isProbe = taskRow?.taskClass === "SYSTEM_PROBE";
    let probeToken: string | undefined;
    if (isProbe && taskRow?.prompt) {
      const m = taskRow.prompt.match(/canary:\s*([a-f0-9]+)/i);
      probeToken = m?.[1];
    }

    if (!generating) {
      const domHint = await browser.detectMcpDomHint(probeToken).catch(() => null);
      if (domHint === "approval_required") {
        taskService.markWaitingApproval(taskId);
        this.repo?.setReadinessReason(
          this.workerId,
          "MCP_APPROVAL_REQUIRED",
          "Click Always allow in ChatGPT for the Cursor connector"
        );
        log({
          event: "INFO",
          component: "browser-worker",
          taskId,
          message: "MCP approval card visible — waiting for operator",
        });
        return;
      }
      if (isProbe && domHint === "safety_blocked") {
        taskService.markMcpWriteDegraded(
          taskId,
          "PLATFORM_SAFETY: OpenAI blocked MCP write before remote-mcp"
        );
        this.clearActiveTask(workerState);
        log({
          event: "WARN",
          component: "browser-worker",
          taskId,
          message: "MCP write degraded (platform safety) — skipping nudge",
        });
        return;
      }
      if (isProbe && domHint === "canary_in_chat" && elapsed >= 15_000) {
        const classified = classifyProbeFailure({
          taskStatus: status,
          domHint: "canary_in_chat",
        });
        taskService.failProbeClassified(
          taskId,
          classified,
          "Canary appeared in chat without MCP tool invocation"
        );
        this.clearActiveTask(workerState);
        return;
      }
    }

    if (!this.nudgeSent && elapsed >= NUDGE_AT_MS) {
      if (generating) {
        // Don't fence a nudge we cannot type yet.
      } else if (isProbe) {
        const preNudgeHint = await browser
          .detectMcpDomHint(probeToken)
          .catch(() => null);
        if (preNudgeHint === "safety_blocked") {
          taskService.markMcpWriteDegraded(
            taskId,
            "PLATFORM_SAFETY: OpenAI blocked MCP write before remote-mcp"
          );
          this.clearActiveTask(workerState);
          return;
        }
      } else {
        const preNudgeHint = await browser.detectMcpDomHint().catch(() => null);
        if (preNudgeHint === "safety_blocked") {
          taskService.markMcpWriteDegraded(
            taskId,
            "PLATFORM_SAFETY: OpenAI blocked MCP write before remote-mcp"
          );
          this.clearActiveTask(workerState);
          return;
        }
      }
      if (!generating) {
        const fenced = taskService.markNudgeStarted(
          taskId,
          this.workerId,
          leaseToken,
          this.instanceToken,
          this.leaseMs,
          this.workerStaleMs
        );
        if (!fenced) {
          this.nudgeSent = true;
        } else {
          taskService.renewLease(
            taskId,
            this.workerId,
            leaseToken,
            this.instanceToken,
            this.leaseMs,
            this.workerStaleMs
          );
          try {
            await browser.waitUntilComposerIdle();
            await this.withUiWrite(async () => {
              this.options.assertBindingFresh?.();
              await browser.sendSubmitNudge(taskId, {
                skipIdleWait: true,
                probe: isProbe,
              });
              log({
                event: "INFO",
                component: "browser-worker",
                taskId,
                message: `Sent submit nudge (TASK_ID=${taskId}${isProbe ? " probe" : ""})`,
              });
            });
          } catch {
            // Fail-closed: marker already set — do not retry.
          }
          this.nudgeSent = true;
          taskService.renewLease(
            taskId,
            this.workerId,
            leaseToken,
            this.instanceToken,
            this.leaseMs,
            this.workerStaleMs
          );
        }
      }
    }

    if (elapsed >= this.hardTimeoutMs) {
      taskService.markSubmitTimedOut(
        taskId,
        `ChatGPT did not call handoff_submit_result within the hard timeout (${this.hardTimeoutMs}ms)` +
          (generating ? " while still generating" : "") +
          ". Late submit is still accepted if no result exists."
      );
      if (generating) {
        if (!this.holdAfterTimeoutLogged) {
          this.holdAfterTimeoutLogged = true;
          log({
            event: "INFO",
            component: "browser-worker",
            taskId,
            message:
              "Hard timeout reached while generating — holding worker for late submit",
          });
        }
        return;
      }
      this.clearActiveTask(workerState);
      log({
        event: "TASK_TIMED_OUT",
        component: "browser-worker",
        taskId,
        message:
          "Hard timeout expired — task TIMED_OUT; worker free for next QUEUED task",
      });
      return;
    }

    if (elapsed >= this.options.approvalTimeoutMs) {
      if (generating) {
        if (!this.deferredTimeoutLogged) {
          this.deferredTimeoutLogged = true;
          log({
            event: "INFO",
            component: "browser-worker",
            taskId,
            message:
              `Approval window (${this.options.approvalTimeoutMs}ms) elapsed but ChatGPT is still generating — deferring TIMED_OUT until idle or hard timeout ${this.hardTimeoutMs}ms`,
          });
        }
        return;
      }
      taskService.markSubmitTimedOut(
        taskId,
        "ChatGPT went idle without calling handoff_submit_result within the approval window. " +
          "If a MCP write confirmation card is visible, approve it. Late submit is still accepted."
      );
      this.clearActiveTask(workerState);
      log({
        event: "TASK_TIMED_OUT",
        component: "browser-worker",
        taskId,
        message:
          "Submit window expired while idle — task TIMED_OUT; worker free for next QUEUED task",
      });
    }
  }

  private async cleanupPreparedAttachments(
    taskId: string,
    session: PreparedAttachSession | null
  ): Promise<boolean> {
    const clean = await cleanupPreparedAttachSession(session, async () => {
      await this.withUiWrite(async () => {
        await session!.transport.cleanup();
      });
    });
    if (!clean) {
      log({
        event: "WARN",
        component: "browser-worker",
        taskId,
        message: "Composer not clean after attachment cleanup",
      });
    }
    return clean;
  }

  private clearActiveTask(workerState: WorkerStateManager): void {
    this.activeTaskId = null;
    this.activeLeaseToken = null;
    this.activeTaskStartedAt = 0;
    this.nudgeSent = false;
    this.deferredTimeoutLogged = false;
    this.holdAfterTimeoutLogged = false;
    this.timedOutIdleSince = 0;
    workerState.setStatus("READY", { currentTaskId: null, error: null });
  }

  private recoverOnStart(
    taskService: TaskService,
    workerState: WorkerStateManager
  ): void {
    // Lease expiry is owned by status-api; worker only clears local in-memory state.
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
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function startBrowserWorker(
  options: BrowserWorkerOptions
): Promise<BrowserWorker> {
  const worker = new BrowserWorker(options);
  // Await the loop so browser-worker process stays alive; reconnect is internal.
  void worker.start().catch((err) => {
    const message = err instanceof Error ? err.message : String(err);
    log({
      event: "ERROR",
      component: "browser-worker",
      message: `Worker start failed fatally: ${message}`,
    });
  });
  return worker;
}
