#!/usr/bin/env npx tsx
/**
 * v0.6 native attachment E2E (Phase D).
 *
 * Prerequisites: worker, CDP Chrome, remote MCP, same HANDOFF_DB_PATH.
 *
 *   npm run e2e:files-attach
 *   npm run e2e:files-attach -- --scenario=text-only
 *   HANDOFF_ATTACH_FAIL_AFTER=1 npm run e2e:files-attach -- --scenario=partial-fail
 */
import { config as loadEnv } from "dotenv";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
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

type Scenario = "happy" | "text-only" | "partial-fail";

function parseArgs(argv: string[]): { scenario: Scenario; timeoutMs: number; pollMs: number } {
  let scenario: Scenario = "happy";
  let timeoutMs = Number(process.env.E2E_TIMEOUT_MS ?? 480_000);
  let pollMs = Number(process.env.E2E_POLL_MS ?? 1500);
  for (const arg of argv) {
    if (arg.startsWith("--scenario=")) {
      scenario = arg.slice(11) as Scenario;
    } else if (arg.startsWith("--timeout-ms=")) {
      timeoutMs = Math.max(5_000, Number(arg.slice(13)));
    } else if (arg.startsWith("--poll-ms=")) {
      pollMs = Math.max(200, Number(arg.slice(10)));
    }
  }
  if (!["happy", "text-only", "partial-fail"].includes(scenario)) {
    throw new Error(`Unknown scenario: ${scenario}`);
  }
  return { scenario, timeoutMs, pollMs };
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

function buildHappyPrompt(nonceA: string, nonceB: string): string {
  return [
    "Native attachment E2E — read the attached files only (do NOT call handoff_read_file).",
    "Return exactly two lines:",
    `LINE1=${nonceA}`,
    `LINE2=${nonceB}`,
    "Then call handoff_submit_result with those two lines in the result string.",
  ].join("\n");
}

function buildTextOnlyPrompt(canary: string): string {
  return [
    "Text-only regression E2E.",
    `Call handoff_submit_result with result: TEXT_ONLY_CANARY=${canary}`,
  ].join("\n");
}

async function main() {
  const { scenario, timeoutMs, pollMs } = parseArgs(process.argv.slice(2));
  const dbPath = resolveUserPath(process.env.HANDOFF_DB_PATH ?? "./data/handoff.sqlite");
  const httpPort = Number(process.env.HANDOFF_HTTP_PORT ?? 8787);
  const httpBase = `http://127.0.0.1:${httpPort}`;
  const cdpEndpoint =
    process.env.CHATGPT_CDP_ENDPOINT?.trim() || "http://127.0.0.1:9222";

  const wsRoot = resolve(process.cwd(), ".e2e-attach-ws");
  mkdirSync(wsRoot, { recursive: true });
  process.env.HANDOFF_WORKSPACE_ROOT = wsRoot;

  const nonceA = "ATTACH_E2E_NONCE_A";
  const nonceB = "ATTACH_E2E_NONCE_B";
  writeFileSync(join(wsRoot, "a.ts"), `export const nonce = "${nonceA}";\n`);
  writeFileSync(join(wsRoot, "b.ts"), `export const nonce = "${nonceB}";\n`);

  initDatabase(dbPath);
  const repo = new TaskRepository(getDatabase());
  const taskService = new TaskService(repo);

  console.log(`E2E files-attach scenario=${scenario}`);
  await preflight(httpBase, cdpEndpoint);

  if (scenario === "partial-fail") {
    console.warn(
      "partial-fail: set HANDOFF_ATTACH_FAIL_AFTER=1 on browser-worker (not this script), then restart browser-worker"
    );
  }

  const conversationId = `e2e-files-attach-${scenario}-${Date.now()}`;
  let files: string[] | undefined;
  let prompt: string;

  if (scenario === "text-only") {
    const canary = `text-${Date.now()}`;
    files = undefined;
    prompt = buildTextOnlyPrompt(canary);
  } else {
    files = ["a.ts", "b.ts"];
    prompt = buildHappyPrompt(nonceA, nonceB);
  }

  const { taskId } = taskService.createTask({
    type: "second_opinion",
    prompt,
    cursorConversationId: conversationId,
    files,
  });
  console.log(`created taskId=${taskId}`);

  if (scenario === "partial-fail") {
    await sleep(15_000);
    const task = repo.getTaskById(taskId);
    const dispatched = Boolean(task?.dispatchStartedAt);
    const status = task?.status ?? "UNKNOWN";
    console.log(`partial-fail: status=${status} dispatch_started_at=${task?.dispatchStartedAt ?? "null"}`);
    if (dispatched) {
      console.error("FAIL: dispatch fence crossed on partial attach failure");
      process.exit(1);
    }
    if (status === "COMPLETED") {
      console.error("FAIL: task completed despite partial attach failure");
      process.exit(1);
    }
    console.log("ok — partial-fail: no fence, task not completed");
    rmSync(wsRoot, { recursive: true, force: true });
    return;
  }

  const finalStatus = await waitForStatus(
    httpBase,
    taskId,
    ["COMPLETED", "FAILED", "TIMED_OUT"],
    timeoutMs,
    pollMs
  );

  if (finalStatus !== "COMPLETED") {
    const task = repo.getTaskById(taskId);
    console.error(`FAIL: final status=${finalStatus} error=${task?.error ?? ""}`);
    process.exit(1);
  }

  const result = taskService.getResult(taskId);
  const body = result.result ?? "";

  if (scenario === "text-only") {
    if (!body.includes("TEXT_ONLY_CANARY=")) {
      console.error(`FAIL: text-only result missing canary: ${body.slice(0, 200)}`);
      process.exit(1);
    }
    console.log("ok — text-only regression passed");
  } else {
    if (!body.includes(nonceA) || !body.includes(nonceB)) {
      console.error(
        `FAIL: result missing nonces (need both A and B). Got: ${body.slice(0, 300)}`
      );
      process.exit(1);
    }
    console.log("ok — happy path: both nonces present in result");
  }

  rmSync(wsRoot, { recursive: true, force: true });
  console.log("E2E files-attach PASSED");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
