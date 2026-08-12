import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { initDatabase } from "../db/sqlite.js";
import { TaskRepository } from "../tasks/task.repository.js";
import { TaskService } from "../tasks/task.service.js";
import { registerHandoffTools } from "./tools/index.js";
import { log } from "../logging/logger.js";

export interface McpServerOptions {
  dbPath: string;
}

export async function startMcpServer(options: McpServerOptions): Promise<void> {
  const db = initDatabase(options.dbPath);
  const repo = new TaskRepository(db);
  const taskService = new TaskService(repo);

  const server = new McpServer(
    {
      name: "chatgpt-mcp",
      version: "1.0.0",
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  registerHandoffTools(server, taskService);

  const transport = new StdioServerTransport();
  await server.connect(transport);

  log({
    event: "INFO",
    component: "mcp-server",
    message: "Handoff MCP server started (stdio)",
  });
}
