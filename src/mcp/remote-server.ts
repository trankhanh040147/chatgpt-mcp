import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { initDatabase, getDatabase } from "../db/sqlite.js";
import { TaskRepository } from "../tasks/task.repository.js";
import { TaskService } from "../tasks/task.service.js";
import { registerHandoffTools } from "./tools/index.js";
import { WORKER_MCP_INSTRUCTIONS } from "./worker-policy.js";
import { log } from "../logging/logger.js";

export interface RemoteMcpOptions {
  port: number;
  dbPath: string;
  /** null disables auth entirely (ChatGPT custom connectors only support OAuth or No Auth — no static bearer field). */
  authToken: string | null;
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString("utf-8");
  return raw ? JSON.parse(raw) : undefined;
}

function jsonRpcError(res: ServerResponse, status: number, code: number, message: string): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id: null }));
}

/**
 * Remote MCP endpoint for ChatGPT (spec §6.1: "remote MCP / Secure MCP Tunnel").
 * Stateless Streamable HTTP: a fresh McpServer+transport per request, same DB as
 * the stdio server Cursor uses. Bearer-token gated since this is meant to be
 * exposed publicly via a tunnel (e.g. ngrok).
 */
export function startRemoteMcpServer(options: RemoteMcpOptions): void {
  initDatabase(options.dbPath);
  const repo = new TaskRepository(getDatabase());
  const taskService = new TaskService(repo);

  const expectedAuth = options.authToken ? `Bearer ${options.authToken}` : null;

  const httpServer = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://localhost:${options.port}`);

    if (url.pathname !== "/mcp") {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Not found" }));
      return;
    }

    if (expectedAuth && req.headers.authorization !== expectedAuth) {
      log({
        event: "WARN",
        component: "mcp-server",
        message: "Remote MCP request rejected: missing/invalid bearer token",
      });
      jsonRpcError(res, 401, -32001, "Unauthorized");
      return;
    }

    if (req.method !== "POST") {
      jsonRpcError(res, 405, -32000, "Method not allowed. Use POST.");
      return;
    }

    try {
      const body = await readJsonBody(req);

      const mcpServer = new McpServer(
        { name: "chatgpt-mcp-remote", version: "0.1.0" },
        {
          capabilities: { tools: {} },
          instructions: WORKER_MCP_INSTRUCTIONS,
        }
      );
      registerHandoffTools(mcpServer, taskService);

      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      await mcpServer.connect(transport);
      await transport.handleRequest(req, res, body);

      res.on("close", () => {
        void transport.close();
        void mcpServer.close();
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log({ event: "ERROR", component: "mcp-server", message: `Remote MCP request failed: ${message}` });
      if (!res.headersSent) {
        jsonRpcError(res, 500, -32603, "Internal server error");
      }
    }
  });

  httpServer.listen(options.port, "127.0.0.1", () => {
    log({
      event: "INFO",
      component: "mcp-server",
      message: expectedAuth
        ? `Remote MCP (stateless, bearer-auth) listening on http://127.0.0.1:${options.port}/mcp`
        : `Remote MCP (stateless, NO AUTH — anyone with the tunnel URL can call it) listening on http://127.0.0.1:${options.port}/mcp`,
    });
  });
}
