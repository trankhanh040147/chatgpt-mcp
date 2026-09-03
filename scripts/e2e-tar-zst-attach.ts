#!/usr/bin/env npx tsx
/**
 * v0.9 inbound tar.zst attach E2E — many files[] → one handoff-{taskId}.tar.zst chip.
 *
 * Prerequisites: worker, CDP Chrome, remote MCP, same HANDOFF_DB_PATH.
 *
 *   npm run e2e:tar-zst-attach
 *   npm run e2e:tar-zst-attach -- --scenario=many
 *   npm run e2e:tar-zst-attach -- --scenario=text-only
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

type Scenario = "many" | "text-only";

function parseArgs(argv: string[]): { scenario: Scenario; timeoutMs: number; pollMs: number } {
  let scenario: Scenario = "many";
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
  if (!["many", "text-only"].includes(scenario)) {
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

function buildManyPrompt(nonce: string, fileCount: number): string {
  return [
    "v0.9 tar.zst attach E2E.",
    `You received ONE composer chip: handoff-<taskId>.tar.zst containing ${fileCount} members.`,
    "Open/unpack that chip (do NOT call handoff_read_file).",
    `Find member nest/nonce.txt and quote its exact contents.`,
    "Return exactly one line then submit:",
    `TAR_ZST_NONCE=${nonce}`,
    "Call handoff_submit_result with that line in the result string.",
  ].join("\n");
}

function buildTextOnlyPrompt(canary: string): string {
  return [
    "Text-only regression after tar.zst pack (no files[]).",
    `Call handoff_submit_result with result: TEXT_ONLY_TAR_ZST=${canary}`,
  ].join("\n");
}

async function main() {
  const { scenario, timeoutMs, pollMs } = parseArgs(process.argv.slice(2));
  const dbPath = resolveUserPath(process.env.HANDOFF_DB_PATH ?? "./data/handoff.sqlite");
  const httpPort = Number(process.env.HANDOFF_HTTP_PORT ?? 8787);
  const httpBase = `http://127.0.0.1:${httpPort}`;
  const cdpEndpoint =
    process.env.CHATGPT_CDP_ENDPOINT?.trim() || "http://127.0.0.1:9222";

  const wsRoot = resolve(process.cwd(), ".e2e-tar-zst-attach-ws");
  mkdirSync(wsRoot, { recursive: true });
  mkdirSync(join(wsRoot, "nest"), { recursive: true });
  process.env.HANDOFF_WORKSPACE_ROOT = wsRoot;

  const nonce = `TAR_ZST_E2E_${Date.now()}`;
  const fileCount = 25;
  const names: string[] = [];

  if (scenario === "many") {
    writeFileSync(join(wsRoot, "nest", "nonce.txt"), `TAR_ZST_NONCE=${nonce}\n`);
    names.push("nest/nonce.txt");
    for (let i = 0; i < fileCount - 1; i += 1) {
      const name = `pad/f${i}.ts`;
      mkdirSync(join(wsRoot, "pad"), { recursive: true });
      writeFileSync(join(wsRoot, name), `export const i = ${i};\n`);
      names.push(name);
    }
  }

  initDatabase(dbPath);
  const repo = new TaskRepository(getDatabase());
  const taskService = new TaskService(repo);

  console.log(`E2E tar-zst-attach scenario=${scenario}`);
  await preflight(httpBase, cdpEndpoint);

  const conversationId = `e2e-tar-zst-attach-${scenario}-${Date.now()}`;
  const canary = `text-${Date.now()}`;
  const prompt =
    scenario === "text-only"
      ? buildTextOnlyPrompt(canary)
      : buildManyPrompt(nonce, fileCount);
  const files = scenario === "text-only" ? undefined : names;

  const { taskId } = taskService.createTask({
    type: "second_opinion",
    prompt,
    cursorConversationId: conversationId,
    files,
  });
  console.log(`created taskId=${taskId}`);
  if (scenario === "many") {
    console.log(`expect chip: handoff-${taskId}.tar.zst (${fileCount} members)`);
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
  if (scenario === "many") {
    if (!body.includes(`TAR_ZST_NONCE=${nonce}`)) {
      console.error(
        `FAIL: nonce missing from result (ChatGPT may not have opened the tar.zst chip).\n` +
          `result preview: ${body.slice(0, 500)}`
      );
      process.exit(1);
    }
    console.log("ok — many: nonce quoted from tar.zst chip");
  } else {
    if (!body.includes(`TEXT_ONLY_TAR_ZST=${canary}`)) {
      console.error(`FAIL: text-only canary missing: ${body.slice(0, 400)}`);
      process.exit(1);
    }
    console.log("ok — text-only: no files path still works");
  }

  mkdirSync(resolve(process.cwd(), "logs"), { recursive: true });
  writeFileSync(
    join(process.cwd(), "logs", `tar-zst-attach-e2e-${taskId}.json`),
    `${JSON.stringify({ taskId, scenario, nonce, fileCount, result: body }, null, 2)}\n`
  );

  rmSync(wsRoot, { recursive: true, force: true });
  console.log("E2E tar-zst-attach PASSED");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
