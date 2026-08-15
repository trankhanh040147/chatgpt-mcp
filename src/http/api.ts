import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { initDatabase, getDatabase } from "../db/sqlite.js";
import { TaskRepository } from "../tasks/task.repository.js";
import { TaskService } from "../tasks/task.service.js";
import { log } from "../logging/logger.js";

export interface HttpApiOptions {
  port: number;
  dbPath: string;
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

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://localhost:${options.port}`);

    try {
      if (req.method === "GET" && url.pathname === "/health") {
        sendJson(res, 200, { ok: true });
        return;
      }

      if (req.method === "GET" && url.pathname === "/worker") {
        const state = repo.getWorkerState();
        // Minimal schema for harness/diagnostics — no raw paths or full error blobs.
        sendJson(res, 200, {
          status: state.status,
          activeTask: Boolean(state.currentTaskId),
          errorCode: state.error
            ? state.error.split(":")[0]?.slice(0, 64) ?? "ERROR"
            : null,
        });
        return;
      }

      // Long-poll: GET /tasks/:id/wait?timeoutSeconds=480
      // Must be matched before the plain /tasks/:id status route.
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

  // Stop hook may long-poll up to ~500s; disable default request timeouts.
  server.requestTimeout = 0;
  server.headersTimeout = 0;
  server.timeout = 0;

  return new Promise((resolve, reject) => {
    server.once("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        reject(
          new Error(
            `Port ${options.port} already in use — a worker is already running. ` +
              `Check: curl -s http://127.0.0.1:${options.port}/health  ` +
              `Do not start a second \`npm run worker\`.`
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
        message: `Status API listening on http://127.0.0.1:${options.port}`,
      });
      resolve();
    });
  });
}
