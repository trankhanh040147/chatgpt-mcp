import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { initDatabase, getDatabase } from "../db/sqlite.js";
import { TaskRepository } from "../tasks/task.repository.js";
import { TaskService } from "../tasks/task.service.js";
import { log } from "../logging/logger.js";
import { DEFAULT_WORKER_ID, type HandoffTask } from "../tasks/task.types.js";
import {
  dashboardContentMode,
  deriveWorkerIndicators,
  redactPreview,
  sanitizeChatUrl,
  taskTiming,
} from "../dashboard/observability.js";

export interface HttpApiOptions {
  port: number;
  dbPath: string;
  /** When true, run expireLeases on an interval (status-api ownership). */
  runLeaseReaper?: boolean;
  reaperIntervalMs?: number;
  /** Optional default worker id for GET /worker single-view (compat). */
  workerId?: string;
}

function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  extraHeaders?: Record<string, string>
): void {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
    ...extraHeaders,
  });
  res.end(JSON.stringify(body));
}

function scrubTaskListItem(t: HandoffTask, nowIso: string) {
  const timing = taskTiming(t, nowIso);
  return {
    id: t.id,
    status: t.status,
    type: t.type,
    leaseOwner: t.leaseOwner ?? null,
    createdAt: t.createdAt,
    completedAt: t.completedAt ?? null,
    dispatchStartedAt: timing.dispatchStartedAt,
    dispatchedAt: timing.dispatchedAt,
    processingAt: timing.processingAt,
    terminalAt: timing.terminalAt,
    queueMs: timing.queueMs,
    processingMs: timing.processingMs,
    totalMs: timing.totalMs,
    processingAgeMs: timing.processingAgeMs,
    errorCode: t.error
      ? t.error.split(":")[0]?.slice(0, 64) ?? "ERROR"
      : null,
    hasPrompt: Boolean(t.prompt),
    hasResult: Boolean(t.result),
  };
}

function dashboardPublicDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(here, "../dashboard/public"),
    join(process.cwd(), "src/dashboard/public"),
    join(process.cwd(), "dist/dashboard/public"),
  ];
  return (
    candidates.find((p) => existsSync(join(p, "index.html"))) ?? candidates[0]!
  );
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};

function serveDashboardAsset(
  res: ServerResponse,
  pathname: string
): boolean {
  const root = dashboardPublicDir();
  let rel = pathname.replace(/^\/dashboard\/?/, "");
  if (!rel || rel === "") rel = "index.html";
  if (rel.includes("..") || rel.startsWith("/")) {
    sendJson(res, 400, { error: "bad path" });
    return true;
  }
  const filePath = join(root, rel);
  if (!existsSync(filePath)) {
    return false;
  }
  const body = readFileSync(filePath);
  res.writeHead(200, {
    "Content-Type": MIME[extname(filePath)] ?? "application/octet-stream",
    "Cache-Control": "no-store",
  });
  res.end(body);
  return true;
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf-8");
}

const TERMINAL_WAIT_STATUSES = new Set([
  "COMPLETED",
  "FAILED",
  "CANCELLED",
]);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function startHttpApi(options: HttpApiOptions): Promise<void> {
  initDatabase(options.dbPath);
  const repo = new TaskRepository(getDatabase());
  const taskService = new TaskService(repo);
  const viewWorkerId = options.workerId?.trim() || DEFAULT_WORKER_ID;

  let lastReapAt: string | null = null;
  let lastReapStats: {
    requeued: number;
    timedOut: number;
    failed: number;
  } | null = null;

  if (options.runLeaseReaper) {
    const interval = options.reaperIntervalMs ?? 2000;
    const tick = () => {
      try {
        const stats = taskService.expireLeases();
        lastReapAt = new Date().toISOString();
        lastReapStats = stats;
        if (stats.requeued || stats.timedOut || stats.failed) {
          log({
            event: "INFO",
            component: "lease-reaper",
            message: `expireLeases requeued=${stats.requeued} timedOut=${stats.timedOut} failed=${stats.failed}`,
          });
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log({
          event: "ERROR",
          component: "lease-reaper",
          message,
        });
      }
    };
    tick();
    setInterval(tick, interval).unref?.();
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://localhost:${options.port}`);

    try {
      if (
        req.method === "GET" &&
        (url.pathname === "/dashboard" || url.pathname === "/dashboard/")
      ) {
        res.writeHead(302, { Location: "/dashboard/index.html" });
        res.end();
        return;
      }

      if (req.method === "GET" && url.pathname.startsWith("/dashboard/")) {
        if (!serveDashboardAsset(res, url.pathname)) {
          sendJson(res, 404, { error: "Dashboard asset not found" });
        }
        return;
      }

      if (req.method === "GET" && url.pathname === "/health") {
        sendJson(res, 200, {
          ok: true,
          lastReapAt,
          reaper: Boolean(options.runLeaseReaper),
        });
        return;
      }

      if (req.method === "GET" && url.pathname === "/workers") {
        const now = Date.now();
        const nowIso = new Date(now).toISOString();
        const staleMs = Number(process.env.HANDOFF_WORKER_STALE_MS ?? 120_000);
        const since24h = new Date(now - 24 * 3600_000).toISOString();
        const counts = repo.countTerminalByLeaseOwner(since24h);
        const workers = repo.listWorkers().map((w) => {
          const lastSeenMs = w.lastSeenAt
            ? Date.parse(w.lastSeenAt)
            : Number.NaN;
          const heartbeatAgeMs = Number.isFinite(lastSeenMs)
            ? now - lastSeenMs
            : null;
          const heartbeatStale =
            !Number.isFinite(lastSeenMs) || now - lastSeenMs > staleMs;
          let pidAlive = false;
          if (w.pid && w.pid > 0) {
            try {
              process.kill(w.pid, 0);
              pidAlive = true;
            } catch {
              pidAlive = false;
            }
          }
          const healthy = pidAlive && !heartbeatStale;
          const agg = counts.get(w.id) ?? {
            completed: 0,
            failed: 0,
            timedOut: 0,
          };
          let currentTaskAgeMs: number | null = null;
          if (w.currentTaskId) {
            const cur = repo.getTaskById(w.currentTaskId);
            if (cur) {
              currentTaskAgeMs = taskTiming(cur, nowIso).processingAgeMs;
            }
          }
          const chatUrl = sanitizeChatUrl(w.workerUrl);
          return {
            id: w.id,
            status: w.status,
            healthy,
            pid: w.pid ?? null,
            pidAlive,
            heartbeatStale,
            heartbeatAgeMs,
            activeTask: Boolean(w.currentTaskId),
            currentTaskId: w.currentTaskId ?? null,
            lastSeenAt: w.lastSeenAt ?? null,
            startedAt: w.startedAt ?? null,
            httpPort: w.httpPort ?? null,
            chatUrl,
            chatAvailable: Boolean(chatUrl),
            completedLast24h: agg.completed,
            failedLast24h: agg.failed,
            timedOutLast24h: agg.timedOut,
            indicators: deriveWorkerIndicators({
              status: w.status,
              healthy,
              pidAlive,
              heartbeatStale,
              heartbeatAgeMs,
              currentTaskAgeMs,
              recentFailed: agg.failed,
              recentTimedOut: agg.timedOut,
            }),
            errorCode: w.error
              ? w.error.split(":")[0]?.slice(0, 64) ?? "ERROR"
              : null,
          };
        });
        sendJson(res, 200, {
          workers,
          lastReapAt,
          lastReapStats,
          serverTime: nowIso,
        });
        return;
      }

      if (req.method === "GET" && url.pathname === "/worker") {
        const state = repo.getWorkerState(viewWorkerId);
        sendJson(res, 200, {
          status: state.status,
          activeTask: Boolean(state.currentTaskId),
          workerId: state.id,
          errorCode: state.error
            ? state.error.split(":")[0]?.slice(0, 64) ?? "ERROR"
            : null,
        });
        return;
      }

      if (req.method === "GET" && url.pathname === "/tasks") {
        const limit = Number(url.searchParams.get("limit") ?? 40);
        const nowIso = new Date().toISOString();
        const tasks = repo
          .listRecentTasks(limit)
          .map((t) => scrubTaskListItem(t, nowIso));
        sendJson(res, 200, { tasks, serverTime: nowIso });
        return;
      }

      const waitMatch = url.pathname.match(/^\/tasks\/([^/]+)\/wait$/);
      if (req.method === "GET" && waitMatch) {
        const taskId = decodeURIComponent(waitMatch[1] ?? "");
        const timeoutSeconds = Math.min(
          1800,
          Math.max(1, Number(url.searchParams.get("timeoutSeconds") ?? 480))
        );
        const tickMs = Math.min(
          2000,
          Math.max(
            100,
            Number(
              url.searchParams.get("tickMs") ??
                process.env.HANDOFF_WAIT_TICK_MS ??
                250
            )
          )
        );
        const deadline = Date.now() + timeoutSeconds * 1000;

        let lastStatus: string | null = null;
        while (Date.now() < deadline) {
          if (req.destroyed) return;
          try {
            const { status } = taskService.getTaskStatus(taskId);
            lastStatus = status;
            if (TERMINAL_WAIT_STATUSES.has(status)) {
              sendJson(res, 200, { status, timedOut: false });
              return;
            }
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            if (message.includes("Task not found")) {
              sendJson(res, 404, { error: message });
              return;
            }
            throw err;
          }
          const remaining = deadline - Date.now();
          if (remaining <= 0) break;
          await sleep(Math.min(tickMs, remaining));
        }

        sendJson(res, 200, {
          status: lastStatus,
          timedOut: true,
        });
        return;
      }

      if (req.method === "GET" && url.pathname.startsWith("/tasks/")) {
        const rest = url.pathname.slice("/tasks/".length);
        const parts = rest.split("/").filter(Boolean);
        const taskId = parts[0] ? decodeURIComponent(parts[0]) : "";
        const sub = parts[1];

        if (!taskId || taskId.includes("..")) {
          sendJson(res, 404, { error: "Not found" });
          return;
        }

        if (sub === "detail") {
          const task = repo.getTaskById(taskId);
          if (!task) {
            sendJson(res, 404, { error: `Task not found: ${taskId}` });
            return;
          }
          const nowIso = new Date().toISOString();
          sendJson(res, 200, {
            ...scrubTaskListItem(task, nowIso),
            contentMode: dashboardContentMode(),
            serverTime: nowIso,
          });
          return;
        }

        if (sub === "content") {
          const mode = dashboardContentMode();
          if (mode !== "redacted") {
            sendJson(res, 403, {
              error: "Task content disabled",
              hint: "Set HANDOFF_DASHBOARD_TASK_CONTENT=redacted to enable redacted previews",
              mode: "off",
            });
            return;
          }
          const task = repo.getTaskById(taskId);
          if (!task) {
            sendJson(res, 404, { error: `Task not found: ${taskId}` });
            return;
          }
          sendJson(res, 200, {
            taskId: task.id,
            mode: "redacted",
            prompt: redactPreview(task.prompt),
            result: redactPreview(task.result),
            warning:
              "Best-effort server redaction — not a guarantee. Localhost only.",
          });
          return;
        }

        if (sub) {
          sendJson(res, 404, { error: "Not found" });
          return;
        }

        // Compat: status-only (hooks / waiters)
        try {
          const status = taskService.getTaskStatus(taskId);
          sendJson(res, 200, status);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          if (message.includes("Task not found")) {
            sendJson(res, 404, { error: message });
            return;
          }
          throw err;
        }
        return;
      }

      if (
        req.method === "GET" &&
        url.pathname === "/conversations/pending"
      ) {
        const conversationId = url.searchParams.get("conversationId");
        if (!conversationId) {
          sendJson(res, 400, { error: "conversationId required" });
          return;
        }
        const pending = taskService.findPendingForConversation(conversationId);
        sendJson(res, 200, { pending: pending ?? null });
        return;
      }

      if (
        req.method === "GET" &&
        url.pathname === "/conversations/completed"
      ) {
        const conversationId = url.searchParams.get("conversationId");
        if (!conversationId) {
          sendJson(res, 400, { error: "conversationId required" });
          return;
        }
        const completed =
          taskService.findCompletedForConversation(conversationId);
        sendJson(res, 200, { completed: completed ?? null });
        return;
      }

      if (req.method === "POST" && url.pathname === "/tasks/mark-idle") {
        const body = JSON.parse(await readBody(req)) as { taskId?: string };
        if (!body.taskId) {
          sendJson(res, 400, { error: "taskId required" });
          return;
        }
        taskService.markReadyButCursorIdle(body.taskId);
        sendJson(res, 200, { ok: true });
        return;
      }

      sendJson(res, 404, { error: "Not found" });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      sendJson(res, 500, { error: message });
    }
  });

  server.requestTimeout = 0;
  server.headersTimeout = 0;
  server.timeout = 0;

  return new Promise((resolve, reject) => {
    server.once("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        reject(
          new Error(
            `Port ${options.port} already in use — status-api (or another process) is already bound. ` +
              `Check: curl -s http://127.0.0.1:${options.port}/health  ` +
              `For multi-worker, run one status-api on :${options.port} and separate browser-worker processes.`
          )
        );
        return;
      }
      reject(err);
    });
    server.listen(options.port, "127.0.0.1", () => {
      log({
        event: "INFO",
        component: "http-api",
        message:
          `Status API listening on http://127.0.0.1:${options.port}` +
          (options.runLeaseReaper ? " (lease reaper on)" : "") +
          ` · dashboard http://127.0.0.1:${options.port}/dashboard/`,
      });
      resolve();
    });
  });
}
