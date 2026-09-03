#!/usr/bin/env npx tsx
/**
 * Soak E2E: estimate how often ChatGPT's first archive MCP write is blocked /
 * stalled (OpenAI client-side "platform safety"), vs recovers after nudge.
 *
 * Does NOT prove a deterministic bug — measures flaky client refusal rate.
 *
 * Prerequisites: worker, CDP Chrome, remote MCP, same HANDOFF_DB_PATH.
 *
 *   npm run e2e:archive-safety-rate
 *   npm run e2e:archive-safety-rate -- --runs=20
 *   npm run e2e:archive-safety-rate -- --runs=10 --mode=artifacts
 *   npm run e2e:archive-safety-rate -- --runs=20 --fail-above=0.4
 */
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

type Mode = "archive" | "artifacts";

type TrialOutcome =
  | "first_pass"
  | "after_nudge_pass"
  | "timeout"
  | "failed"
  | "cheat_or_prose"
  | "error";

type TrialRecord = {
  i: number;
  taskId: string;
  outcome: TrialOutcome;
  status: HandoffTaskStatus | "ERROR";
  ms: number;
  nudgeStartedAt: string | null;
  completedAt: string | null;
  resultPreview: string;
  safetyPhraseInResult: boolean;
  notes?: string;
};

function resolveUserPath(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed === "~") return homedir();
  if (trimmed.startsWith("~/")) return resolve(join(homedir(), trimmed.slice(2)));
  return resolve(trimmed);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function parseArgs(argv: string[]): {
  runs: number;
  mode: Mode;
  timeoutMs: number;
  pollMs: number;
  gapMs: number;
  failAbove: number | null;
} {
  let runs = Number(process.env.E2E_SAFETY_RUNS ?? 10);
  let mode: Mode = "archive";
  let timeoutMs = Number(process.env.E2E_TIMEOUT_MS ?? 180_000);
  let pollMs = Number(process.env.E2E_POLL_MS ?? 1500);
  let gapMs = Number(process.env.E2E_SAFETY_GAP_MS ?? 5_000);
  let failAbove: number | null = null;

  for (const arg of argv) {
    if (arg.startsWith("--runs=")) runs = Number(arg.slice(7));
    else if (arg.startsWith("--mode=")) mode = arg.slice(7) as Mode;
    else if (arg.startsWith("--timeout-ms="))
      timeoutMs = Math.max(15_000, Number(arg.slice(13)));
    else if (arg.startsWith("--poll-ms="))
      pollMs = Math.max(200, Number(arg.slice(10)));
    else if (arg.startsWith("--gap-ms="))
      gapMs = Math.max(0, Number(arg.slice(9)));
    else if (arg.startsWith("--fail-above="))
      failAbove = Number(arg.slice(13));
  }

  if (!Number.isInteger(runs) || runs < 1 || runs > 50) {
    throw new Error(`--runs must be an integer 1..50 (got ${runs})`);
  }
  if (mode !== "archive" && mode !== "artifacts") {
    throw new Error(`--mode must be archive|artifacts (got ${mode})`);
  }
  if (failAbove !== null && !(failAbove >= 0 && failAbove <= 1)) {
    throw new Error(`--fail-above must be 0..1 (got ${failAbove})`);
  }
  return { runs, mode, timeoutMs, pollMs, gapMs, failAbove };
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

function safetyPhrase(text: string): boolean {
  const t = text.toLowerCase();
  return (
    (t.includes("safety") &&
      (t.includes("block") || t.includes("blocked") || t.includes("layer"))) ||
    t.includes("platform safety") ||
    t.includes("safety checks")
  );
}

function buildArchivePrompt(): string {
  return [
    "v0.9 archive safety-rate E2E. Do NOT call handoff_read_file.",
    "1) handoff_get_task — read submitTemplate (includes archive.data base64)",
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
    "v0.8 artifacts safety-rate control. Do NOT call handoff_read_file.",
    "1) handoff_get_task — read submitTemplate",
    "2) handoff_submit_result using submitTemplate (artifacts[] required, no archive)",
  ].join("\n");
}

function classifyCompleted(input: {
  mode: Mode;
  nudgeStartedAt?: string;
  completedAt?: string;
  resultBody: string;
  manifestLen: number;
  diskOk: boolean;
}): { outcome: TrialOutcome; notes?: string } {
  if (!input.diskOk || input.manifestLen === 0) {
    return {
      outcome: "cheat_or_prose",
      notes: "COMPLETED but missing archive/artifacts writeback on disk",
    };
  }
  if (input.mode === "archive" && !input.resultBody.includes("Written via archive:")) {
    return {
      outcome: "cheat_or_prose",
      notes: "COMPLETED without submitTemplate.result archive marker",
    };
  }
  if (input.nudgeStartedAt && input.completedAt) {
    const nudgeMs = Date.parse(input.nudgeStartedAt);
    const doneMs = Date.parse(input.completedAt);
    if (
      Number.isFinite(nudgeMs) &&
      Number.isFinite(doneMs) &&
      doneMs >= nudgeMs
    ) {
      return {
        outcome: "after_nudge_pass",
        notes:
          "Submit landed after worker nudge — first attempt likely stalled/blocked",
      };
    }
  }
  return { outcome: "first_pass" };
}

function pct(n: number, d: number): string {
  if (d === 0) return "n/a";
  return `${((100 * n) / d).toFixed(1)}%`;
}

async function main() {
  const { runs, mode, timeoutMs, pollMs, gapMs, failAbove } = parseArgs(
    process.argv.slice(2)
  );
  const dbPath = resolveUserPath(
    process.env.HANDOFF_DB_PATH ?? "./data/handoff.sqlite"
  );
  const httpPort = Number(process.env.HANDOFF_HTTP_PORT ?? 8787);
  const httpBase = `http://127.0.0.1:${httpPort}`;
  const cdpEndpoint =
    process.env.CHATGPT_CDP_ENDPOINT?.trim() || "http://127.0.0.1:9222";

  const wsRoot = resolve(process.cwd(), ".e2e-archive-safety-rate-ws");
  mkdirSync(wsRoot, { recursive: true });
  process.env.HANDOFF_WORKSPACE_ROOT = wsRoot;

  initDatabase(dbPath);
  const repo = new TaskRepository(getDatabase());
  const taskService = new TaskService(repo);

  console.log(
    `E2E archive-safety-rate mode=${mode} runs=${runs} timeoutMs=${timeoutMs} gapMs=${gapMs}`
  );
  await preflight(httpBase, cdpEndpoint);

  const trials: TrialRecord[] = [];
  const batchStamp = Date.now();

  for (let i = 1; i <= runs; i++) {
    const stamp = Date.now();
    const newA = `SAFETY_A_${stamp}_${i}`;
    const newB = `SAFETY_B_${stamp}_${i}`;
    writeFileSync(join(wsRoot, "a.ts"), 'export const nonce = "OLD_A";\n');
    writeFileSync(join(wsRoot, "b.ts"), 'export const nonce = "OLD_B";\n');

    let submitTemplate: Record<string, unknown>;
    let prompt: string;
    if (mode === "archive") {
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

    const t0 = Date.now();
    let taskId = "";
    try {
      ({ taskId } = taskService.createTask({
        type: "second_opinion",
        prompt,
        context: { writebackRequired: true, submitTemplate },
        cursorConversationId: `e2e-archive-safety-rate-${mode}-${batchStamp}-${i}`,
        files: mode === "archive" ? undefined : ["a.ts", "b.ts"],
        workspaceRoot: wsRoot,
      }));
      console.log(`[${i}/${runs}] created ${taskId}`);

      const status = await waitForStatus(
        httpBase,
        taskId,
        ["COMPLETED", "FAILED", "TIMED_OUT"],
        timeoutMs,
        pollMs
      );
      const ms = Date.now() - t0;
      const task = repo.getTaskById(taskId);
      const nudgeStartedAt = task?.nudgeStartedAt ?? null;
      const completedAt = task?.completedAt ?? null;

      if (status === "TIMED_OUT") {
        trials.push({
          i,
          taskId,
          outcome: "timeout",
          status,
          ms,
          nudgeStartedAt,
          completedAt,
          resultPreview: "",
          safetyPhraseInResult: false,
          notes: task?.error?.slice(0, 200),
        });
        console.log(`[${i}/${runs}] timeout (${ms}ms) nudge=${Boolean(nudgeStartedAt)}`);
      } else if (status === "FAILED") {
        const err = task?.error ?? "";
        trials.push({
          i,
          taskId,
          outcome: "failed",
          status,
          ms,
          nudgeStartedAt,
          completedAt,
          resultPreview: err.slice(0, 200),
          safetyPhraseInResult: safetyPhrase(err),
          notes: err.slice(0, 200),
        });
        console.log(`[${i}/${runs}] failed (${ms}ms)`);
      } else {
        const result = taskService.getResult(taskId);
        const body = result.result ?? "";
        const manifest = result.metadata?.artifacts ?? [];
        let diskOk = false;
        try {
          const aBody = readFileSync(join(wsRoot, "a.ts"), "utf8");
          const bBody = readFileSync(join(wsRoot, "b.ts"), "utf8");
          diskOk = aBody.includes(newA) && bBody.includes(newB);
        } catch {
          diskOk = false;
        }
        const { outcome, notes } = classifyCompleted({
          mode,
          nudgeStartedAt: nudgeStartedAt ?? undefined,
          completedAt: completedAt ?? undefined,
          resultBody: body,
          manifestLen: manifest.length,
          diskOk,
        });
        trials.push({
          i,
          taskId,
          outcome,
          status,
          ms,
          nudgeStartedAt,
          completedAt,
          resultPreview: body.slice(0, 200),
          safetyPhraseInResult: safetyPhrase(body),
          notes,
        });
        console.log(
          `[${i}/${runs}] ${outcome} (${ms}ms) nudge=${Boolean(nudgeStartedAt)}`
        );
      }
    } catch (err) {
      const ms = Date.now() - t0;
      const msg = err instanceof Error ? err.message : String(err);
      trials.push({
        i,
        taskId: taskId || `trial-${i}`,
        outcome: "error",
        status: "ERROR",
        ms,
        nudgeStartedAt: null,
        completedAt: null,
        resultPreview: "",
        safetyPhraseInResult: false,
        notes: msg.slice(0, 200),
      });
      console.log(`[${i}/${runs}] error: ${msg.slice(0, 120)}`);
    }

    if (i < runs && gapMs > 0) await sleep(gapMs);
  }

  const n = trials.length;
  const count = (o: TrialOutcome) =>
    trials.filter((t) => t.outcome === o).length;

  const firstPass = count("first_pass");
  const afterNudge = count("after_nudge_pass");
  const timeout = count("timeout");
  const failed = count("failed");
  const cheat = count("cheat_or_prose");
  const errored = count("error");

  // First-attempt problem estimate: needed nudge, or never completed cleanly.
  const firstAttemptProblem = afterNudge + timeout + failed + cheat + errored;
  const firstAttemptProblemRate = n === 0 ? 0 : firstAttemptProblem / n;
  // Hard fail (no recovery): timeout/failed/cheat/error
  const hardFail = timeout + failed + cheat + errored;
  const hardFailRate = n === 0 ? 0 : hardFail / n;
  const eventualOk = firstPass + afterNudge;
  const eventualOkRate = n === 0 ? 0 : eventualOk / n;

  const summary = {
    mode,
    runs: n,
    batchStamp,
    counts: {
      first_pass: firstPass,
      after_nudge_pass: afterNudge,
      timeout,
      failed,
      cheat_or_prose: cheat,
      error: errored,
    },
    rates: {
      first_pass: firstPass / n,
      after_nudge_pass: afterNudge / n,
      first_attempt_problem: firstAttemptProblemRate,
      hard_fail: hardFailRate,
      eventual_ok: eventualOkRate,
    },
    definitions: {
      first_pass:
        "COMPLETED with valid writeback before/without nudge — first MCP write likely OK",
      after_nudge_pass:
        "COMPLETED with valid writeback only after worker nudge — first attempt likely blocked/stalled",
      first_attempt_problem:
        "after_nudge_pass + timeout + failed + cheat_or_prose + error",
      hard_fail: "timeout + failed + cheat_or_prose + error (no good writeback)",
    },
    trials,
  };

  console.log("\n=== archive safety-rate summary ===");
  console.log(`mode=${mode} runs=${n}`);
  console.log(
    `first_pass=${firstPass} (${pct(firstPass, n)})  after_nudge_pass=${afterNudge} (${pct(afterNudge, n)})`
  );
  console.log(
    `timeout=${timeout} failed=${failed} cheat_or_prose=${cheat} error=${errored}`
  );
  console.log(
    `first_attempt_problem=${pct(firstAttemptProblem, n)}  hard_fail=${pct(hardFail, n)}  eventual_ok=${pct(eventualOk, n)}`
  );

  mkdirSync(resolve(process.cwd(), "logs"), { recursive: true });
  const outPath = join(
    process.cwd(),
    "logs",
    `archive-safety-rate-${mode}-${batchStamp}.json`
  );
  writeFileSync(outPath, `${JSON.stringify(summary, null, 2)}\n`);
  console.log(`wrote ${outPath}`);

  rmSync(wsRoot, { recursive: true, force: true });

  if (failAbove !== null && firstAttemptProblemRate > failAbove) {
    console.error(
      `FAIL: first_attempt_problem ${firstAttemptProblemRate.toFixed(3)} > --fail-above=${failAbove}`
    );
    process.exit(1);
  }
  console.log("E2E archive-safety-rate DONE");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
