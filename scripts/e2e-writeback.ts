#!/usr/bin/env npx tsx
/**
 * v0.8 native writeback E2E.
 *
 * Prerequisites: worker, CDP Chrome, remote MCP, same HANDOFF_DB_PATH.
 *
 *   npm run e2e:writeback
 *   npm run e2e:writeback -- --scenario=create-new
 */
import { createHash } from "node:crypto";
import { config as loadEnv } from "dotenv";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

type Scenario = "happy" | "create-new";

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
  if (!["happy", "create-new"].includes(scenario)) {
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

function buildHappySubmitTemplate(newA: string, newB: string) {
  return {
    result: "Written: a.ts, b.ts",
    artifacts: [
      {
        path: "a.ts",
        content: `export const nonce = "${newA}";\n`,
        mode: "overwrite" as const,
      },
      {
        path: "b.ts",
        content: `export const nonce = "${newB}";\n`,
        mode: "overwrite" as const,
      },
    ],
  };
}

function buildCreateNewSubmitTemplate(newC: string) {
  return {
    result: "Written: a.ts (overwrite), c.ts (create)",
    artifacts: [
      {
        path: "a.ts",
        content: 'export const nonce = "MATCH_A";\n',
        mode: "overwrite" as const,
      },
      {
        path: "c.ts",
        content: `export const nonce = "${newC}";\n`,
        mode: "create" as const,
      },
    ],
  };
}

function buildHappyPrompt(): string {
  return [
    "Native writeback E2E. Do NOT call handoff_read_file.",
    "1) handoff_get_task — read submitTemplate",
    "2) handoff_submit_result — pass taskId + submitTemplate.result + submitTemplate.artifacts (required)",
    "Prose-only submit FAILS the server check.",
  ].join("\n");
}

function buildCreateNewPrompt(): string {
  return [
    "Native writeback E2E (create-new). Do NOT call handoff_read_file.",
    "1) handoff_get_task — read submitTemplate",
    "2) handoff_submit_result using submitTemplate (artifacts[] required)",
  ].join("\n");
}

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

async function main() {
  const { scenario, timeoutMs, pollMs } = parseArgs(process.argv.slice(2));
  const dbPath = resolveUserPath(process.env.HANDOFF_DB_PATH ?? "./data/handoff.sqlite");
  const httpPort = Number(process.env.HANDOFF_HTTP_PORT ?? 8787);
  const httpBase = `http://127.0.0.1:${httpPort}`;
  const cdpEndpoint =
    process.env.CHATGPT_CDP_ENDPOINT?.trim() || "http://127.0.0.1:9222";

  const wsRoot = resolve(process.cwd(), ".e2e-writeback-ws");
  mkdirSync(wsRoot, { recursive: true });
  process.env.HANDOFF_WORKSPACE_ROOT = wsRoot;

  const oldA = "WRITE_E2E_OLD_A";
  const oldB = "WRITE_E2E_OLD_B";
  const newA = `WRITE_E2E_NEW_A_${Date.now()}`;
  const newB = `WRITE_E2E_NEW_B_${Date.now()}`;
  const newC = `WRITE_E2E_NEW_C_${Date.now()}`;

  writeFileSync(join(wsRoot, "a.ts"), `export const nonce = "${oldA}";\n`);
  writeFileSync(join(wsRoot, "b.ts"), `export const nonce = "${oldB}";\n`);

  initDatabase(dbPath);
  const repo = new TaskRepository(getDatabase());
  const taskService = new TaskService(repo);

  console.log(`E2E writeback scenario=${scenario}`);
  await preflight(httpBase, cdpEndpoint);

  const conversationId = `e2e-writeback-${scenario}-${Date.now()}`;
  const files = scenario === "create-new" ? ["a.ts"] : ["a.ts", "b.ts"];
  const submitTemplate =
    scenario === "create-new"
      ? buildCreateNewSubmitTemplate(newC)
      : buildHappySubmitTemplate(newA, newB);
  const prompt =
    scenario === "create-new" ? buildCreateNewPrompt() : buildHappyPrompt();

  const { taskId } = taskService.createTask({
    type: "second_opinion",
    prompt,
    context: { writebackRequired: true, submitTemplate },
    cursorConversationId: conversationId,
    files,
  });
  console.log(`created taskId=${taskId}`);
  const ctxRow = getDatabase()
    .prepare("SELECT context_json FROM handoff_tasks WHERE id = ?")
    .get(taskId) as { context_json: string | null } | undefined;
  if (!ctxRow?.context_json?.includes("writebackRequired")) {
    console.error("FAIL: writebackRequired not persisted in context_json");
    process.exit(1);
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
  const manifest = result.metadata?.artifacts ?? [];
  if (manifest.length === 0) {
    console.error(
      `FAIL: metadata.artifacts empty — ChatGPT submitted prose-only.\n` +
        `result preview: ${(result.result ?? "").slice(0, 400)}`
    );
    process.exit(1);
  }

  if (scenario === "happy") {
    const aBody = readFileSync(join(wsRoot, "a.ts"), "utf8");
    const bBody = readFileSync(join(wsRoot, "b.ts"), "utf8");
    if (!aBody.includes(newA) || !bBody.includes(newB)) {
      console.error(`FAIL: disk bytes missing new nonces\na=${aBody}\nb=${bBody}`);
      process.exit(1);
    }
    for (const entry of manifest) {
      const diskSha = sha256File(join(wsRoot, entry.relativePath));
      if (diskSha !== entry.sha256) {
        console.error(
          `FAIL: sha256 mismatch ${entry.relativePath} manifest=${entry.sha256} disk=${diskSha}`
        );
        process.exit(1);
      }
    }
    console.log("ok — happy: artifacts on disk + sha256 match");
  } else {
    const cPath = join(wsRoot, "c.ts");
    try {
      const cBody = readFileSync(cPath, "utf8");
      if (!cBody.includes(newC)) {
        console.error(`FAIL: c.ts missing nonce: ${cBody}`);
        process.exit(1);
      }
    } catch {
      console.error("FAIL: c.ts not created");
      process.exit(1);
    }
    const aBody = readFileSync(join(wsRoot, "a.ts"), "utf8");
    if (!aBody.includes("MATCH_A")) {
      console.error(`FAIL: a.ts not overwritten: ${aBody}`);
      process.exit(1);
    }
    console.log("ok — create-new: c.ts created + a.ts overwritten");
  }

  const report = {
    taskId,
    scenario,
    manifest,
    wsRoot,
  };
  mkdirSync(resolve(process.cwd(), "logs"), { recursive: true });
  writeFileSync(
    join(process.cwd(), "logs", `writeback-e2e-${taskId}.json`),
    `${JSON.stringify(report, null, 2)}\n`
  );

  rmSync(wsRoot, { recursive: true, force: true });
  console.log("E2E writeback PASSED");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
