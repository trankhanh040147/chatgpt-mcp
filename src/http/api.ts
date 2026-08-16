import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { initDatabase, getDatabase } from "../db/sqlite.js";
import { TaskRepository } from "../tasks/task.repository.js";
import { TaskService } from "../tasks/task.service.js";
import { log } from "../logging/logger.js";
import { DEFAULT_WORKER_ID } from "../tasks/task.types.js";

export interface HttpApiOptions {
  port: number;
  dbPath: string;
  /** When true, run expireLeases on an interval (status-api ownership). */
  runLeaseReaper?: boolean;
  reaperIntervalMs?: number;
  /** Optional default worker id for GET /worker single-view (compat). */
  workerId?: string;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
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
  "TIMED_OUT",
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
        const staleMs = Number(process.env.HANDOFF_WORKER_STALE_MS ?? 120_000);
        const workers = repo.listWorkers().map((w) => {
          const lastSeenMs = w.lastSeenAt
            ? Date.parse(w.lastSeenAt)
            : Number.NaN;
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
          return {
            id: w.id,
            status: w.status,
            healthy,
            pidAlive,
            heartbeatStale,
            activeTask: Boolean(w.currentTaskId),
            currentTaskId: w.currentTaskId ?? null,
            lastSeenAt: w.lastSeenAt ?? null,
            startedAt: w.startedAt ?? null,
            httpPort: w.httpPort ?? null,
            errorCode: w.error
              ? w.error.split(":")[0]?.slice(0, 64) ?? "ERROR"
              : null,
          };
        });
        sendJson(res, 200, {
          workers,
          lastReapAt,
          lastReapStats,
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

      const waitMatch = url.pathname.match(/^\/tasks\/([^/]+)\/wait$/);
      if (req.method === "GET" && waitMatch) {
        const taskId = decodeURIComponent(waitMatch[1] ?? "");
        const timeoutSeconds = Math.min(
          600,
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
        const taskId = url.pathname.slice("/tasks/".length);
        if (!taskId || taskId.includes("/")) {
          sendJson(res, 404, { error: "Not found" });
          return;
        }
        const status = taskService.getTaskStatus(taskId);
        sendJson(res, 200, status);
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
        message: `Status API listening on http://127.0.0.1:${options.port}` +
          (options.runLeaseReaper ? " (lease reaper on)" : ""),
      });
      resolve();
    });
  });
}
