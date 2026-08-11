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

export function startHttpApi(options: HttpApiOptions): void {
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

      if (req.method === "GET" && url.pathname.startsWith("/tasks/")) {
        const taskId = url.pathname.slice("/tasks/".length);
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

  server.listen(options.port, "127.0.0.1", () => {
    log({
      event: "INFO",
      component: "http-api",
      message: `Status API listening on http://127.0.0.1:${options.port}`,
    });
  });
}
