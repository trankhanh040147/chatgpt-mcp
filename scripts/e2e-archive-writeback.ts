#!/usr/bin/env npx tsx
/**
 * v0.9 outbound archive writeback E2E — handoff_submit_result({ archive }).
 *
 * Prerequisites: worker, CDP Chrome, remote MCP, same HANDOFF_DB_PATH.
 *
 *   npm run e2e:archive-writeback
 *   npm run e2e:archive-writeback -- --scenario=artifacts-regression
 */
import { createHash } from "node:crypto";
import { config as loadEnv } from "dotenv";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  compressTarZstd,
  encodeCanonicalBase64,
  packTarPax,
} from "../src/archive/index.js";
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

type Scenario = "archive" | "artifacts-regression";

function parseArgs(argv: string[]): { scenario: Scenario; timeoutMs: number; pollMs: number } {
  let scenario: Scenario = "archive";
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
  if (!["archive", "artifacts-regression"].includes(scenario)) {
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

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function buildArchivePrompt(): string {
  return [
    "v0.9 archive writeback E2E. Do NOT call handoff_read_file.",
    "1) handoff_get_task — read submitTemplate (it includes archive.data base64)",
    "2) handoff_submit_result — pass EXACTLY:",
    "   taskId = submitTemplate.taskId",
    "   result = submitTemplate.result",
    "   archive = submitTemplate.archive (format+encoding+data verbatim)",
    "FORBIDDEN: artifacts[], inventing file bodies, or omitting archive.data.",
    "Prose-only submit FAILS. artifacts[] submit FAILS this E2E even if COMPLETED.",
  ].join("\n");
}

function buildArtifactsPrompt(): string {
  return [
    "v0.8 artifacts regression after archive path. Do NOT call handoff_read_file.",
    "1) handoff_get_task — read submitTemplate",
    "2) handoff_submit_result using submitTemplate (artifacts[] required, no archive)",
  ].join("\n");
}

async function main() {
  const { scenario, timeoutMs, pollMs } = parseArgs(process.argv.slice(2));
  const dbPath = resolveUserPath(process.env.HANDOFF_DB_PATH ?? "./data/handoff.sqlite");
  const httpPort = Number(process.env.HANDOFF_HTTP_PORT ?? 8787);
  const httpBase = `http://127.0.0.1:${httpPort}`;
  const cdpEndpoint =
    process.env.CHATGPT_CDP_ENDPOINT?.trim() || "http://127.0.0.1:9222";

  const wsRoot = resolve(process.cwd(), ".e2e-archive-writeback-ws");
  mkdirSync(wsRoot, { recursive: true });
  process.env.HANDOFF_WORKSPACE_ROOT = wsRoot;

  const stamp = Date.now();
  const newA = `ARCHIVE_E2E_A_${stamp}`;
  const newB = `ARCHIVE_E2E_B_${stamp}`;

  writeFileSync(join(wsRoot, "a.ts"), 'export const nonce = "OLD_A";\n');
  writeFileSync(join(wsRoot, "b.ts"), 'export const nonce = "OLD_B";\n');

  initDatabase(dbPath);
  const repo = new TaskRepository(getDatabase());
  const taskService = new TaskService(repo);

  console.log(`E2E archive-writeback scenario=${scenario}`);
  await preflight(httpBase, cdpEndpoint);

  const conversationId = `e2e-archive-writeback-${scenario}-${stamp}`;
  let submitTemplate: Record<string, unknown>;
  let prompt: string;

  if (scenario === "archive") {
    const tar = packTarPax([
      {
        relativePath: "a.ts",
        bytes: Buffer.from(`export const nonce = "${newA}";\n`),
      },
      {
        relativePath: "b.ts",
        bytes: Buffer.from(`export const nonce = "${newB}";\n`),
      },
    ]);
    const data = encodeCanonicalBase64(compressTarZstd(tar));
    submitTemplate = {
      result: "Written via archive: a.ts, b.ts",
      archive: { format: "tar.zst", encoding: "base64", data },
    };
    prompt = buildArchivePrompt();
  } else {
    submitTemplate = {
      result: "Written via artifacts: a.ts, b.ts",
      artifacts: [
        {
          path: "a.ts",
          content: `export const nonce = "${newA}";\n`,
          mode: "overwrite",
        },
        {
          path: "b.ts",
          content: `export const nonce = "${newB}";\n`,
          mode: "overwrite",
        },
      ],
    };
    prompt = buildArtifactsPrompt();
  }

  const { taskId } = taskService.createTask({
    type: "second_opinion",
    prompt,
    context: { writebackRequired: true, submitTemplate },
    cursorConversationId: conversationId,
    // Archive scenario: no attach chips — otherwise the model rewrites OLD
    // attachment bodies via artifacts[] and ignores submitTemplate.archive.
    files: scenario === "archive" ? undefined : ["a.ts", "b.ts"],
    workspaceRoot: wsRoot,
  });
  console.log(`created taskId=${taskId}`);
  if (!repo.getTaskById(taskId)?.workspaceRoot) {
    console.error(
      "FAIL: workspace_root not persisted — archive ingest would hit default HANDOFF_WORKSPACE_ROOT"
    );
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
  const body = result.result ?? "";
  if (scenario === "archive" && !body.includes("Written via archive:")) {
    console.error(
      `FAIL: expected submitTemplate.result (archive path). Model likely used artifacts[] with OLD attach bodies.\n` +
        `result: ${body.slice(0, 400)}`
    );
    process.exit(1);
  }
  const manifest = result.metadata?.artifacts ?? [];
  if (manifest.length === 0) {
    console.error(
      `FAIL: metadata.artifacts empty — ChatGPT submitted prose-only.\n` +
        `result preview: ${body.slice(0, 400)}`
    );
    process.exit(1);
  }

  // Archive path writes NEW nonces; OLD_* means artifacts[] echoed attachments.
  for (const entry of manifest) {
    if (entry.sizeBytes === 30) {
      console.error(
        `FAIL: ${entry.relativePath} sizeBytes=30 looks like OLD_* seed, not archive members`
      );
      process.exit(1);
    }
  }

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

  console.log(
    scenario === "archive"
      ? "ok — archive: members on disk + sha256 match"
      : "ok — artifacts-regression: artifacts[] still works"
  );

  mkdirSync(resolve(process.cwd(), "logs"), { recursive: true });
  writeFileSync(
    join(process.cwd(), "logs", `archive-writeback-e2e-${taskId}.json`),
    `${JSON.stringify({ taskId, scenario, manifest, wsRoot }, null, 2)}\n`
  );

  rmSync(wsRoot, { recursive: true, force: true });
  console.log("E2E archive-writeback PASSED");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
