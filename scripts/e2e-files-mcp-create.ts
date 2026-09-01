#!/usr/bin/env npx tsx
/**
 * v0.7 MCP ingress E2E (D1b): handoff_create_task(files) via stdio MCP client.
 *
 * Prerequisites: worker READY, CDP Chrome, remote MCP, same HANDOFF_DB_PATH.
 *
 *   npm run build && npm run e2e:files-mcp-create
 */
import { config as loadEnv } from "dotenv";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { initDatabase, getDatabase } from "../src/db/sqlite.js";
import { TaskRepository } from "../src/tasks/task.repository.js";
import { TaskService } from "../src/tasks/task.service.js";
import type { HandoffTaskStatus } from "../src/tasks/task.types.js";

loadEnv({ path: resolve(process.cwd(), ".env") });

function resolveUserPath(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed === "~") return homedir();
  if (trimmed.startsWith("~/")) return resolve(join(homedir(), trimmed.slice(2)));
  return resolve(trimmed);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function parseToolJson(result: { content?: Array<{ type: string; text?: string }> }): Record<string, unknown> {
  const text = result.content?.find((c) => c.type === "text")?.text ?? "";
  return JSON.parse(text) as Record<string, unknown>;
}

async function httpJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return (await res.json()) as T;
}

async function preflight(httpBase: string, cdpEndpoint: string): Promise<void> {
  const health = await httpJson<{ ok?: boolean }>(`${httpBase}/health`);
  if (!health.ok) throw new Error("HTTP /health not ok");
  const worker = await httpJson<{ status?: string }>(`${httpBase}/worker`);
  if (worker.status !== "READY" && worker.status !== "BUSY") {
    throw new Error(`Worker not READY (status=${worker.status ?? "unknown"})`);
  }
  const cdp = await fetch(`${cdpEndpoint.replace(/\/$/, "")}/json/version`);
  if (!cdp.ok) throw new Error(`CDP not reachable at ${cdpEndpoint}`);
}

async function waitForStatus(
  httpBase: string,
  taskId: string,
  want: HandoffTaskStatus[],
  timeoutMs: number,
  pollMs: number
): Promise<HandoffTaskStatus> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { status } = await httpJson<{ status: HandoffTaskStatus }>(
      `${httpBase}/tasks/${encodeURIComponent(taskId)}`
    );
    if (want.includes(status)) return status;
    await sleep(pollMs);
  }
  throw new Error(`Timed out waiting for ${want.join("|")} (task ${taskId})`);
}

function buildMcpPrompt(nonceA: string, nonceB: string): string {
  return [
    "MCP ingress E2E — read attached files from composer chips (do NOT call handoff_read_file).",
    "Return exactly two lines:",
    `LINE1=${nonceA}`,
    `LINE2=${nonceB}`,
    "Then call handoff_submit_result with those two lines in the result string.",
  ].join("\n");
}

async function main() {
  const dbPath = resolveUserPath(process.env.HANDOFF_DB_PATH ?? "./data/handoff.sqlite");
  const httpPort = Number(process.env.HANDOFF_HTTP_PORT ?? 8787);
  const httpBase = `http://127.0.0.1:${httpPort}`;
  const cdpEndpoint =
    process.env.CHATGPT_CDP_ENDPOINT?.trim() || "http://127.0.0.1:9222";
  const timeoutMs = Number(process.env.E2E_TIMEOUT_MS ?? 480_000);
  const pollMs = Number(process.env.E2E_POLL_MS ?? 1500);
  const logDir = resolve(process.cwd(), "logs");

  const wsRoot = resolve(process.cwd(), ".e2e-mcp-create-ws");
  mkdirSync(wsRoot, { recursive: true });
  mkdirSync(logDir, { recursive: true });

  const nonceA = "MCP_CREATE_NONCE_A";
  const nonceB = "MCP_CREATE_NONCE_B";
  writeFileSync(join(wsRoot, "mcp-a.ts"), `export const nonce = "${nonceA}";\n`);
  writeFileSync(join(wsRoot, "mcp-b.ts"), `export const nonce = "${nonceB}";\n`);

  initDatabase(dbPath);
  const repo = new TaskRepository(getDatabase());
  const taskService = new TaskService(repo);

  console.log("E2E files-mcp-create (D1b)");
  await preflight(httpBase, cdpEndpoint);

  const mcpEntry = resolve(process.cwd(), "dist/index.js");
  const transport = new StdioClientTransport({
    command: "node",
    args: [mcpEntry, "mcp"],
    env: {
      ...process.env,
      HANDOFF_DB_PATH: dbPath,
      HANDOFF_WORKSPACE_ROOT: wsRoot,
      LOG_DIR: logDir,
    },
  });

  const client = new Client({ name: "e2e-files-mcp-create", version: "0.7.0" });
  await client.connect(transport);

  const conversationId = `e2e-mcp-create-${Date.now()}`;
  const createResult = await client.callTool({
    name: "handoff_create_task",
    arguments: {
      type: "second_opinion",
      prompt: buildMcpPrompt(nonceA, nonceB),
      clientSessionId: conversationId,
      files: ["mcp-a.ts", "mcp-b.ts"],
    },
  });

  const created = parseToolJson(createResult);
  const taskId = created.taskId as string;
  if (!taskId?.startsWith("ho_")) {
    throw new Error(`Unexpected create response: ${JSON.stringify(created)}`);
  }
  console.log(`MCP created taskId=${taskId}`);

  const task = repo.getTaskById(taskId);
  assertTaskRefs(task?.files?.length === 2, "task has two file refs from MCP create");

  const finalStatus = await waitForStatus(
    httpBase,
    taskId,
    ["COMPLETED", "FAILED", "TIMED_OUT"],
    timeoutMs,
    pollMs
  );

  await client.close();

  if (finalStatus !== "COMPLETED") {
    const t = repo.getTaskById(taskId);
    console.error(`FAIL: final status=${finalStatus} error=${t?.error ?? ""}`);
    process.exit(1);
  }

  const result = taskService.getResult(taskId);
  const body = result.result ?? "";
  if (!body.includes(nonceA) || !body.includes(nonceB)) {
    console.error(
      `FAIL: result missing MCP ingress nonces. Got: ${body.slice(0, 300)}`
    );
    process.exit(1);
  }

  rmSync(wsRoot, { recursive: true, force: true });
  console.log("ok — MCP ingress: both nonces present in result");
  console.log("E2E files-mcp-create PASSED");
}

function assertTaskRefs(cond: boolean, msg: string): void {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
  }
  console.log(`ok — ${msg}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
