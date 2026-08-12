/**
 * Stage-instrumented reliability harness (spec §37).
 *
 * Prerequisites: worker (:8787), CDP Chrome, remote MCP for ChatGPT, same HANDOFF_DB_PATH.
 *
 *   npx tsx scripts/e2e-reliability.ts --runs=1
 *   npx tsx scripts/e2e-reliability.ts --runs=20
 *
 * Do not import src/index.ts — it auto-runs main().
 */
import { config as loadEnv } from "dotenv";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync, renameSync } from "node:fs";
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
  if (trimmed.startsWith("~/")) {
    return resolve(join(homedir(), trimmed.slice(2)));
  }
  return resolve(trimmed);
}

function loadHarnessConfig(): {
  dbPath: string;
  httpPort: number;
  cdpEndpoint: string;
  logDir: string;
} {
  return {
    dbPath: resolveUserPath(
      process.env.HANDOFF_DB_PATH ?? "./data/handoff.sqlite"
    ),
    httpPort: Number(process.env.HANDOFF_HTTP_PORT ?? 8787),
    cdpEndpoint:
      process.env.CHATGPT_CDP_ENDPOINT?.trim() || "http://127.0.0.1:9222",
    logDir: resolveUserPath(process.env.LOG_DIR ?? "./logs"),
  };
}

type FailureClass =
  | "NONE"
  | "PREFLIGHT"
  | "WORKER_NOT_READY"
  | "STUCK_QUEUED"
  | "DISPATCH_TIMEOUT"
  | "TIMEOUT"
  | "FAILED"
  | "CANARY_MISMATCH"
  | "HTTP_ERROR"
  | "ABORTED";

type StageName =
  | "preflight"
  | "created"
  | "queued"
  | "dispatching"
  | "dispatched"
  | "processing"
  | "waiting_approval"
  | "completed"
  | "failed"
  | "timed_out";

interface StageEvent {
  stage: StageName;
  atMs: number;
  status?: HandoffTaskStatus;
}

interface RunResult {
  index: number;
  taskId?: string;
  canary: string;
  ok: boolean;
  failureClass: FailureClass;
  stages: StageEvent[];
  durationsMs: Record<string, number>;
  finalStatus?: HandoffTaskStatus;
  error?: string;
}

interface WorkerDiag {
  status?: string;
  activeTask?: boolean;
  errorCode?: string | null;
}

function parseArgs(argv: string[]): {
  runs: number;
  timeoutMs: number;
  pollMs: number;
  outDir: string;
} {
  let runs = 1;
  let timeoutMs = Number(process.env.E2E_TIMEOUT_MS ?? 480_000);
  let pollMs = Number(process.env.E2E_POLL_MS ?? 1500);
  let outDir = resolveUserPath(process.env.LOG_DIR ?? "./logs");

  for (const arg of argv) {
    if (arg.startsWith("--runs=")) runs = Number(arg.slice(7));
    else if (arg.startsWith("--timeout-ms="))
      timeoutMs = Math.max(5_000, Number(arg.slice(13)));
    else if (arg.startsWith("--poll-ms="))
      pollMs = Math.max(200, Number(arg.slice(10)));
    else if (arg.startsWith("--out-dir=")) outDir = resolve(arg.slice(10));
  }

  if (!Number.isInteger(runs) || runs < 1 || runs > 100) {
    throw new Error(`--runs must be an integer 1..100 (got ${runs})`);
  }

  return { runs, timeoutMs, pollMs, outDir };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function nowMs(): number {
  return performance.now();
}

function canaryToken(): string {
  return randomBytes(8).toString("hex");
}

function shortHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

function sanitizeError(message: string | undefined): string | undefined {
  if (!message) return undefined;
  return message
    .replace(/https?:\/\/[^\s]+/gi, "[url]")
    .replace(/\/Users\/[^\s]+/g, "[path]")
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
    .slice(0, 160);
}

function buildPrompt(canary: string): string {
  return [
    "This is an automated reliability canary for chatgpt-mcp (transport test).",
    "Do the following and nothing else:",
    "1. If needed, call handoff_get_task with the TASK_ID from the chat message.",
    "2. Immediately call handoff_submit_result with:",
    `   - result: exactly one line: RELIABILITY_CANARY=${canary}`,
    '   - metadata.summary: "canary ok"',
    '   - metadata.confidence: "high"',
    "3. Do not put any other text in the result string. Exact match required.",
  ].join("\n");
}

async function httpJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} for ${url}`);
  }
  return (await res.json()) as T;
}

async function preflight(httpBase: string, cdpEndpoint: string): Promise<void> {
  const health = await httpJson<{ ok?: boolean }>(`${httpBase}/health`);
  if (!health.ok) throw new Error("HTTP /health not ok");

  const worker = await httpJson<WorkerDiag>(`${httpBase}/worker`);
  if (worker.status !== "READY" && worker.status !== "BUSY") {
    throw new Error(
      `Worker not READY (status=${worker.status ?? "unknown"}${
        worker.errorCode ? `; code=${worker.errorCode}` : ""
      }). Start: npm run worker`
    );
  }

  const cdp = await fetch(`${cdpEndpoint.replace(/\/$/, "")}/json/version`);
  if (!cdp.ok) {
    throw new Error(
      `CDP not reachable at ${cdpEndpoint}. Run ./scripts/start-chrome-cdp.sh`
    );
  }
}

function recordStage(
  stages: StageEvent[],
  stage: StageName,
  t0: number,
  status?: HandoffTaskStatus
): void {
  if (stages.some((s) => s.stage === stage)) return;
  stages.push({ stage, atMs: Math.round(nowMs() - t0), status });
}

function durationsFromStages(stages: StageEvent[]): Record<string, number> {
  const byName = new Map(stages.map((s) => [s.stage, s.atMs]));
  const get = (name: StageName) => byName.get(name);
  const out: Record<string, number> = {};
  const created = get("created");
  const dispatched = get("dispatched");
  const processing = get("processing");
  const completed = get("completed") ?? get("failed") ?? get("timed_out");
  if (created != null && dispatched != null)
    out.createToDispatchedMs = dispatched - created;
  if (dispatched != null && processing != null)
    out.dispatchedToProcessingMs = processing - dispatched;
  if (processing != null && completed != null)
    out.processingToDoneMs = completed - processing;
  if (created != null && completed != null)
    out.createToDoneMs = completed - created;
  return out;
}

async function waitWorkerIdle(
  httpBase: string,
  timeoutMs: number,
  pollMs: number
): Promise<void> {
  const deadline = nowMs() + timeoutMs;
  while (nowMs() < deadline) {
    const worker = await httpJson<WorkerDiag>(`${httpBase}/worker`);
    if (worker.status === "READY" && !worker.activeTask) {
      return;
    }
    if (worker.status === "ERROR" || worker.status === "SESSION_LOST") {
      throw new Error(
        `Worker unhealthy: ${worker.status}${
          worker.errorCode ? ` (${worker.errorCode})` : ""
        }`
      );
    }
    await sleep(pollMs);
  }
  throw new Error("Timed out waiting for worker READY/idle");
}

function toPublicRun(r: RunResult): Record<string, unknown> {
  return {
    index: r.index,
    taskIdSuffix: r.taskId ? r.taskId.slice(-10) : null,
    canaryHash: shortHash(r.canary),
    ok: r.ok,
    failureClass: r.failureClass,
    finalStatus: r.finalStatus ?? null,
    durationsMs: r.durationsMs,
    stages: r.stages,
    error: sanitizeError(r.error) ?? null,
  };
}

async function runOnce(
  index: number,
  opts: {
    httpBase: string;
    taskService: TaskService;
    repo: TaskRepository;
    timeoutMs: number;
    pollMs: number;
  }
): Promise<RunResult> {
  const canary = canaryToken();
  const stages: StageEvent[] = [];
  const t0 = nowMs();
  const conversationId = `e2e-reliability-${index}-${canary}`;
  const expected = `RELIABILITY_CANARY=${canary}`;

  try {
    recordStage(stages, "preflight", t0);
    await waitWorkerIdle(
      opts.httpBase,
      Math.min(opts.timeoutMs, 120_000),
      opts.pollMs
    );

    const { taskId } = opts.taskService.createTask({
      type: "second_opinion",
      prompt: buildPrompt(canary),
      cursorConversationId: conversationId,
      context: {
        objective: "reliability canary — echo token via handoff_submit_result",
        constraints: ["exact result string", "no extra prose"],
      },
    });
    recordStage(stages, "created", t0, "QUEUED");

    const deadline = t0 + opts.timeoutMs;
    let lastStatus: HandoffTaskStatus = "QUEUED";
    let sawDispatchAttempt = false;
    let lastProgressMs = t0;
    let lastObserved: HandoffTaskStatus | null = null;

    while (nowMs() < deadline) {
      const { status } = await httpJson<{ status: HandoffTaskStatus }>(
        `${opts.httpBase}/tasks/${encodeURIComponent(taskId)}`
      );
      lastStatus = status;
      if (status !== lastObserved) {
        lastProgressMs = nowMs();
        lastObserved = status;
      }

      if (status === "QUEUED") recordStage(stages, "queued", t0, status);
      else if (status === "DISPATCHING") {
        sawDispatchAttempt = true;
        recordStage(stages, "dispatching", t0, status);
      } else if (status === "DISPATCHED") {
        sawDispatchAttempt = true;
        recordStage(stages, "dispatched", t0, status);
      } else if (status === "PROCESSING") {
        sawDispatchAttempt = true;
        recordStage(stages, "processing", t0, status);
      } else if (status === "WAITING_APPROVAL") {
        recordStage(stages, "waiting_approval", t0, status);
      } else if (status === "COMPLETED") {
        recordStage(stages, "completed", t0, status);
        const got = opts.taskService.getResult(taskId);
        // Exact equality only — no trim/includes (prevents false PASS).
        const ok = got.result === expected;
        return {
          index,
          taskId,
          canary,
          ok,
          failureClass: ok ? "NONE" : "CANARY_MISMATCH",
          stages,
          durationsMs: durationsFromStages(stages),
          finalStatus: status,
          error: ok ? undefined : "result !== expected canary line",
        };
      } else if (
        status === "FAILED" ||
        status === "TIMED_OUT" ||
        status === "CANCELLED"
      ) {
        recordStage(
          stages,
          status === "TIMED_OUT" ? "timed_out" : "failed",
          t0,
          status
        );
        const task = opts.repo.getTaskById(taskId);
        return {
          index,
          taskId,
          canary,
          ok: false,
          failureClass: status === "TIMED_OUT" ? "TIMEOUT" : "FAILED",
          stages,
          durationsMs: durationsFromStages(stages),
          finalStatus: status,
          error: task?.error ?? status,
        };
      }

      if (status === "QUEUED" && !sawDispatchAttempt && nowMs() - t0 > 90_000) {
        return {
          index,
          taskId,
          canary,
          ok: false,
          failureClass: "STUCK_QUEUED",
          stages,
          durationsMs: durationsFromStages(stages),
          finalStatus: status,
          error:
            "Still QUEUED after 90s with no DISPATCHING — worker may not be claiming tasks",
        };
      }

      if (
        status === "QUEUED" &&
        sawDispatchAttempt &&
        nowMs() - lastProgressMs > 120_000
      ) {
        return {
          index,
          taskId,
          canary,
          ok: false,
          failureClass: "DISPATCH_TIMEOUT",
          stages,
          durationsMs: durationsFromStages(stages),
          finalStatus: status,
          error:
            "QUEUED again >120s after dispatch attempts (retries exhausted or worker stuck)",
        };
      }

      if (status === "DISPATCHING" && nowMs() - lastProgressMs > 150_000) {
        return {
          index,
          taskId,
          canary,
          ok: false,
          failureClass: "DISPATCH_TIMEOUT",
          stages,
          durationsMs: durationsFromStages(stages),
          finalStatus: status,
          error: "Stuck DISPATCHING >150s",
        };
      }

      await sleep(opts.pollMs);
    }

    recordStage(stages, "timed_out", t0, lastStatus);
    return {
      index,
      taskId,
      canary,
      ok: false,
      failureClass: "TIMEOUT",
      stages,
      durationsMs: durationsFromStages(stages),
      finalStatus: lastStatus,
      error: `Exceeded timeout ${opts.timeoutMs}ms (last=${lastStatus})`,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const failureClass: FailureClass = message.includes("Worker")
      ? "WORKER_NOT_READY"
      : message.startsWith("HTTP")
        ? "HTTP_ERROR"
        : "FAILED";
    return {
      index,
      canary,
      ok: false,
      failureClass,
      stages,
      durationsMs: durationsFromStages(stages),
      error: message,
    };
  }
}

async function main(): Promise<void> {
  let args: ReturnType<typeof parseArgs>;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(
      JSON.stringify({
        event: "E2E_PREFLIGHT_FAIL",
        error: err instanceof Error ? err.message : String(err),
      })
    );
    process.exit(2);
  }

  const config = loadHarnessConfig();
  const outDir = process.argv.some((a) => a.startsWith("--out-dir="))
    ? args.outDir
    : config.logDir;
  const httpBase = `http://127.0.0.1:${config.httpPort}`;
  const startedWall = new Date().toISOString();

  console.log(
    JSON.stringify({
      event: "E2E_START",
      runs: args.runs,
      timeoutMs: args.timeoutMs,
      httpBase,
      cdpEndpoint: config.cdpEndpoint,
      threshold: args.runs >= 20 ? ">=18/20" : "all must pass",
    })
  );

  try {
    await preflight(httpBase, config.cdpEndpoint);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(
      JSON.stringify({ event: "E2E_PREFLIGHT_FAIL", error: message })
    );
    process.exit(2);
  }

  initDatabase(config.dbPath);
  const repo = new TaskRepository(getDatabase());
  const taskService = new TaskService(repo);

  const runs: RunResult[] = Array.from({ length: args.runs }, (_, i) => ({
    index: i + 1,
    canary: "",
    ok: false,
    failureClass: "ABORTED" as FailureClass,
    stages: [],
    durationsMs: {},
    error: "not attempted",
  }));

  let attempted = 0;
  try {
    for (let i = 0; i < args.runs; i++) {
      console.log(JSON.stringify({ event: "E2E_RUN_START", index: i + 1 }));
      const result = await runOnce(i + 1, {
        httpBase,
        taskService,
        repo,
        timeoutMs: args.timeoutMs,
        pollMs: args.pollMs,
      });
      runs[i] = result;
      attempted += 1;
      console.log(
        JSON.stringify({
          event: "E2E_RUN_END",
          index: i + 1,
          ok: result.ok,
          failureClass: result.failureClass,
          taskIdSuffix: result.taskId?.slice(-10),
          durationsMs: result.durationsMs,
          error: sanitizeError(result.error),
        })
      );

      // Barrier: next run only after worker is idle again.
      try {
        await waitWorkerIdle(
          httpBase,
          Math.min(args.timeoutMs, 120_000),
          args.pollMs
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (!result.ok) {
          // keep original failure; still stop gate on unhealthy worker
        }
        console.error(
          JSON.stringify({
            event: "E2E_WORKER_BARRIER_FAIL",
            error: sanitizeError(message),
          })
        );
        for (let j = i + 1; j < args.runs; j++) {
          runs[j] = {
            index: j + 1,
            canary: "",
            ok: false,
            failureClass: "ABORTED",
            stages: [],
            durationsMs: {},
            error: "aborted after worker barrier failure",
          };
        }
        break;
      }

      if (!result.ok && process.env.E2E_FAIL_FAST === "1") {
        for (let j = i + 1; j < args.runs; j++) {
          runs[j] = {
            index: j + 1,
            canary: "",
            ok: false,
            failureClass: "ABORTED",
            stages: [],
            durationsMs: {},
            error: "aborted by E2E_FAIL_FAST",
          };
        }
        break;
      }
    }
  } finally {
    const passed = runs.filter((r) => r.ok).length;
    const failed = runs.filter((r) => !r.ok && r.failureClass !== "ABORTED").length;
    const aborted = runs.filter((r) => r.failureClass === "ABORTED").length;
    const byClass: Record<string, number> = {};
    for (const r of runs) {
      byClass[r.failureClass] = (byClass[r.failureClass] ?? 0) + 1;
    }

    const gatePass =
      args.runs >= 20
        ? attempted === args.runs && passed >= 18
        : attempted === args.runs && passed === args.runs;

    const report = {
      schemaVersion: 1,
      startedAt: startedWall,
      finishedAt: new Date().toISOString(),
      configuredRuns: args.runs,
      attempted,
      threshold: args.runs >= 20 ? { minPass: 18, of: 20 } : { minPass: args.runs, of: args.runs },
      gatePass,
      summary: {
        total: runs.length,
        passed,
        failed,
        aborted,
        passRate: attempted ? passed / attempted : 0,
        byFailureClass: byClass,
      },
      runs: runs.map(toPublicRun),
    };

    const reportDir = resolve(outDir, "e2e");
    mkdirSync(reportDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const jsonPath = resolve(reportDir, `reliability-${stamp}.json`);
    const tmpPath = `${jsonPath}.tmp`;
    writeFileSync(tmpPath, JSON.stringify(report, null, 2));
    renameSync(tmpPath, jsonPath);

    const mdPath = resolve(reportDir, `reliability-${stamp}.md`);
    const lines = [
      `# Reliability E2E report`,
      ``,
      `- Configured runs: ${args.runs}`,
      `- Attempted: ${attempted}`,
      `- Passed: ${passed}`,
      `- Failed: ${failed}`,
      `- Aborted: ${aborted}`,
      `- Pass rate (attempted): ${(report.summary.passRate * 100).toFixed(1)}%`,
      `- Gate: ${gatePass ? "PASS" : "FAIL"}`,
      ``,
      `| # | ok | class | task suffix | create→done ms |`,
      `|---|----|-------|-------------|----------------|`,
      ...runs.map(
        (r) =>
          `| ${r.index} | ${r.ok} | ${r.failureClass} | ${r.taskId?.slice(-10) ?? ""} | ${r.durationsMs.createToDoneMs ?? ""} |`
      ),
      ``,
    ];
    writeFileSync(mdPath, lines.join("\n"));

    console.log(
      JSON.stringify({
        event: "E2E_DONE",
        summary: report.summary,
        gatePass,
        jsonPath,
        mdPath,
      })
    );

    if (!gatePass) process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
