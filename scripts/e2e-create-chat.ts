/**
 * Live E2E: new chat (@Cursor → bootstrap OK → /c/<id>) → handoff → COMPLETED.
 *
 * Prerequisites: logged-in CDP Chrome, broker stack + browser-worker + status-api.
 *
 *   npm run e2e:create-chat
 *   npm run e2e:create-chat -- --runs=5
 *   npm run e2e:create-chat -- --skip-handoff   # browser automation only
 */
import { config as loadEnv } from "dotenv";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { initDatabase, getDatabase } from "../src/db/sqlite.js";
import { TaskRepository } from "../src/tasks/task.repository.js";
import { TaskService } from "../src/tasks/task.service.js";
import type { HandoffTaskStatus } from "../src/tasks/task.types.js";
import { loadConfig } from "../src/config/load-config.js";
import { brokerOpsClientFromEnv } from "../src/ops/broker-client.js";

loadEnv({ path: resolve(process.cwd(), ".env") });

function resolveUserPath(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed === "~") return homedir();
  if (trimmed.startsWith("~/")) return resolve(join(homedir(), trimmed.slice(2)));
  return resolve(trimmed);
}

type FailureClass =
  | "NONE"
  | "PREFLIGHT"
  | "CREATE_CHAT"
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
  | "create_chat"
  | "chat_bound"
  | "handshake_created"
  | "handshake_completed"
  | "handoff_created"
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
  chatId?: string;
  workerUrl?: string;
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
  skipHandoff: boolean;
  outDir: string;
} {
  let runs = 1;
  let timeoutMs = Number(process.env.E2E_TIMEOUT_MS ?? 480_000);
  let pollMs = Number(process.env.E2E_POLL_MS ?? 800);
  let skipHandoff = false;
  let outDir = resolveUserPath(process.env.LOG_DIR ?? "./logs");

  for (const arg of argv) {
    if (arg.startsWith("--runs=")) runs = Number(arg.slice(7));
    else if (arg.startsWith("--timeout-ms="))
      timeoutMs = Math.max(5_000, Number(arg.slice(13)));
    else if (arg.startsWith("--poll-ms="))
      pollMs = Math.max(200, Number(arg.slice(10)));
    else if (arg === "--skip-handoff") skipHandoff = true;
    else if (arg.startsWith("--out-dir=")) outDir = resolve(arg.slice(10));
  }

  if (!Number.isInteger(runs) || runs < 1 || runs > 100) {
    throw new Error(`--runs must be an integer 1..100 (got ${runs})`);
  }

  return { runs, timeoutMs, pollMs, skipHandoff, outDir };
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

function buildHandoffPrompt(canary: string): string {
  return [
    "Automated E2E for chatgpt-mcp after new chat.",
    "Do the following and nothing else:",
    "1. If needed, call handoff_get_task with the TASK_ID from the chat message.",
    "2. Immediately call handoff_submit_result with:",
    `   - result: exactly one line: E2E_CANARY=${canary}`,
    '   - metadata.summary: "e2e ok"',
    '   - metadata.confidence: "high"',
    "3. Do not put any other text in the result string. Exact match required.",
  ].join("\n");
}

async function httpJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
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
      }). Start: node dist/gptmcp.js restart`
    );
  }

  const cdp = await fetch(`${cdpEndpoint.replace(/\/$/, "")}/json/version`);
  if (!cdp.ok) {
    throw new Error(`CDP not reachable at ${cdpEndpoint}`);
  }

  const broker = brokerOpsClientFromEnv();
  if (!broker) {
    throw new Error(
      "Broker ops unavailable — set HANDOFF_BROKER_OPS_TOKEN or run ./scripts/start-broker-stack.sh"
    );
  }
  const ok = await broker.ping();
  if (!ok) throw new Error("Broker ops ping failed");
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
  const get = (name: StageName) => stages.find((s) => s.stage === name)?.atMs;
  const out: Record<string, number> = {};
  const create = get("create_chat");
  const bound = get("chat_bound");
  const created = get("handoff_created");
  const dispatched = get("dispatched");
  const processing = get("processing");
  const completed =
    get("completed") ?? get("failed") ?? get("timed_out");
  if (create != null && bound != null) out.createChatMs = bound - create;
  if (bound != null && created != null) out.bindToHandoffMs = created - bound;
  if (created != null && dispatched != null)
    out.createToDispatchedMs = dispatched - created;
  if (dispatched != null && processing != null)
    out.dispatchedToProcessingMs = processing - dispatched;
  if (processing != null && completed != null)
    out.processingToDoneMs = completed - processing;
  if (create != null && completed != null) out.fullFlowMs = completed - create;
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
    if (worker.status === "READY" && !worker.activeTask) return;
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

async function createAndBindChat(
  workerId: string,
  repo: TaskRepository
): Promise<{ workerUrl: string; chatId: string }> {
  const broker = brokerOpsClientFromEnv();
  if (!broker) throw new Error("Broker ops client unavailable");
  const created = await broker.createChat(workerId, "OK");
  repo.setWorkerChatUrl(workerId, created.workerUrl);
  return created;
}

async function waitHandoffComplete(
  opts: {
    httpBase: string;
    taskService: TaskService;
    repo: TaskRepository;
    taskId: string;
    canary: string;
    expected: string;
    timeoutMs: number;
    pollMs: number;
    stages: StageEvent[];
    t0: number;
  }
): Promise<RunResult> {
  const deadline = opts.t0 + opts.timeoutMs;
  let lastStatus: HandoffTaskStatus = "QUEUED";
  let sawDispatchAttempt = false;
  let lastProgressMs = opts.t0;
  let lastObserved: HandoffTaskStatus | null = null;

  while (nowMs() < deadline) {
    const { status } = await httpJson<{ status: HandoffTaskStatus }>(
      `${opts.httpBase}/tasks/${encodeURIComponent(opts.taskId)}`
    );
    lastStatus = status;
    if (status !== lastObserved) {
      lastProgressMs = nowMs();
      lastObserved = status;
    }

    if (status === "QUEUED") recordStage(opts.stages, "queued", opts.t0, status);
    else if (status === "DISPATCHING") {
      sawDispatchAttempt = true;
      recordStage(opts.stages, "dispatching", opts.t0, status);
    } else if (status === "DISPATCHED") {
      sawDispatchAttempt = true;
      recordStage(opts.stages, "dispatched", opts.t0, status);
    } else if (status === "PROCESSING") {
      sawDispatchAttempt = true;
      recordStage(opts.stages, "processing", opts.t0, status);
    } else if (status === "WAITING_APPROVAL") {
      recordStage(opts.stages, "waiting_approval", opts.t0, status);
    } else if (status === "COMPLETED") {
      recordStage(opts.stages, "completed", opts.t0, status);
      const got = opts.taskService.getResult(opts.taskId);
      const ok = got.result === opts.expected;
      return {
        index: 0,
        taskId: opts.taskId,
        canary: opts.canary,
        ok,
        failureClass: ok ? "NONE" : "CANARY_MISMATCH",
        stages: opts.stages,
        durationsMs: durationsFromStages(opts.stages),
        finalStatus: status,
        error: ok ? undefined : "result !== expected canary line",
      };
    } else if (
      status === "FAILED" ||
      status === "TIMED_OUT" ||
      status === "CANCELLED"
    ) {
      recordStage(
        opts.stages,
        status === "TIMED_OUT" ? "timed_out" : "failed",
        opts.t0,
        status
      );
      const task = opts.repo.getTaskById(opts.taskId);
      return {
        index: 0,
        taskId: opts.taskId,
        canary: opts.canary,
        ok: false,
        failureClass: status === "TIMED_OUT" ? "TIMEOUT" : "FAILED",
        stages: opts.stages,
        durationsMs: durationsFromStages(opts.stages),
        finalStatus: status,
        error: task?.error ?? status,
      };
    }

    if (status === "QUEUED" && !sawDispatchAttempt && nowMs() - opts.t0 > 60_000) {
      return {
        index: 0,
        taskId: opts.taskId,
        canary: opts.canary,
        ok: false,
        failureClass: "STUCK_QUEUED",
        stages: opts.stages,
        durationsMs: durationsFromStages(opts.stages),
        finalStatus: status,
        error: "Still QUEUED after 60s — worker may not be claiming tasks",
      };
    }

    if (
      status === "DISPATCHING" &&
      nowMs() - lastProgressMs > 120_000
    ) {
      return {
        index: 0,
        taskId: opts.taskId,
        canary: opts.canary,
        ok: false,
        failureClass: "DISPATCH_TIMEOUT",
        stages: opts.stages,
        durationsMs: durationsFromStages(opts.stages),
        finalStatus: status,
        error: "Stuck DISPATCHING >120s",
      };
    }

    await sleep(opts.pollMs);
  }

  recordStage(opts.stages, "timed_out", opts.t0, lastStatus);
  return {
    index: 0,
    taskId: opts.taskId,
    canary: opts.canary,
    ok: false,
    failureClass: "TIMEOUT",
    stages: opts.stages,
    durationsMs: durationsFromStages(opts.stages),
    finalStatus: lastStatus,
    error: `Exceeded handoff timeout (last=${lastStatus})`,
  };
}

async function runOnce(
  index: number,
  opts: {
    httpBase: string;
    workerId: string;
    taskService: TaskService;
    repo: TaskRepository;
    timeoutMs: number;
    pollMs: number;
    skipHandoff: boolean;
  }
): Promise<RunResult> {
  const canary = canaryToken();
  const stages: StageEvent[] = [];
  const t0 = nowMs();
  const expected = `E2E_CANARY=${canary}`;

  try {
    recordStage(stages, "preflight", t0);
    await waitWorkerIdle(
      opts.httpBase,
      Math.min(opts.timeoutMs, 90_000),
      opts.pollMs
    );

    recordStage(stages, "create_chat", t0);
    const created = await createAndBindChat(opts.workerId, opts.repo);
    recordStage(stages, "chat_bound", t0);

    if (opts.skipHandoff) {
      return {
        index,
        chatId: created.chatId,
        workerUrl: created.workerUrl,
        canary,
        ok: true,
        failureClass: "NONE",
        stages,
        durationsMs: durationsFromStages(stages),
      };
    }

    await waitWorkerIdle(
      opts.httpBase,
      Math.min(opts.timeoutMs, 60_000),
      opts.pollMs
    );

    // New chat needs MCP write approval — handshake before canary (same as dashboard).
    const { taskId: handshakeId, skipped: handshakeSkipped } =
      opts.taskService.createConnectorHandshake({ workerId: opts.workerId });
    if (!handshakeSkipped && handshakeId) {
      recordStage(stages, "handshake_created", t0, "QUEUED");
      const handshake = await waitHandoffComplete({
        httpBase: opts.httpBase,
        taskService: opts.taskService,
        repo: opts.repo,
        taskId: handshakeId,
        canary: "handshake",
        expected: "OK",
        timeoutMs: opts.timeoutMs,
        pollMs: opts.pollMs,
        stages,
        t0,
      });
      if (!handshake.ok) {
        return {
          ...handshake,
          index,
          chatId: created.chatId,
          workerUrl: created.workerUrl,
          error:
            handshake.error ??
            "Connector handshake failed — click Always allow for handoff_submit_result in the new chat tab",
        };
      }
      recordStage(stages, "handshake_completed", t0, "COMPLETED");
      await waitWorkerIdle(
        opts.httpBase,
        Math.min(opts.timeoutMs, 60_000),
        opts.pollMs
      );
    }

    const { taskId } = opts.taskService.createTask({
      type: "second_opinion",
      prompt: buildHandoffPrompt(canary),
      cursorConversationId: `e2e-create-chat-${index}-${canary}`,
      targetWorkerId: opts.workerId,
      context: {
        objective: "post-new-chat handoff canary",
        constraints: ["exact result string"],
      },
    });
    recordStage(stages, "handoff_created", t0, "QUEUED");

    const handoff = await waitHandoffComplete({
      httpBase: opts.httpBase,
      taskService: opts.taskService,
      repo: opts.repo,
      taskId,
      canary,
      expected,
      timeoutMs: opts.timeoutMs,
      pollMs: opts.pollMs,
      stages,
      t0,
    });

    return {
      ...handoff,
      index,
      chatId: created.chatId,
      workerUrl: created.workerUrl,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    let failureClass: FailureClass = "FAILED";
    if (message.includes("Worker")) failureClass = "WORKER_NOT_READY";
    else if (message.startsWith("HTTP")) failureClass = "HTTP_ERROR";
    else if (
      message.includes("create-chat") ||
      message.includes("create-worker") ||
      message.includes("Broker")
    ) {
      failureClass = "CREATE_CHAT";
    }
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
        ok: false,
        stage: "preflight",
        error: err instanceof Error ? err.message : String(err),
      })
    );
    process.exit(2);
  }

  const appConfig = loadConfig();
  const dbPath = resolveUserPath(
    process.env.HANDOFF_DB_PATH ?? appConfig.dbPath
  );
  const httpBase = `http://127.0.0.1:${appConfig.httpPort}`;
  const cdpEndpoint =
    process.env.CHATGPT_CDP_ENDPOINT?.trim() || appConfig.cdpEndpoint;

  mkdirSync(args.outDir, { recursive: true });

  try {
    await preflight(httpBase, cdpEndpoint);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(JSON.stringify({ ok: false, stage: "preflight", error: message }));
    process.exit(2);
  }

  initDatabase(dbPath);
  const repo = new TaskRepository(getDatabase());
  const taskService = new TaskService(repo);
  const workerId = appConfig.workerId;

  const results: RunResult[] = [];
  for (let i = 0; i < args.runs; i++) {
    const result = await runOnce(i + 1, {
      httpBase,
      workerId,
      taskService,
      repo,
      timeoutMs: args.timeoutMs,
      pollMs: args.pollMs,
      skipHandoff: args.skipHandoff,
    });
    results.push(result);

    console.log(
      JSON.stringify({
        ok: result.ok,
        index: result.index,
        failureClass: result.failureClass,
        chatId: result.chatId ?? null,
        workerUrl: result.workerUrl ?? null,
        taskIdSuffix: result.taskId?.slice(-10) ?? null,
        durationsMs: result.durationsMs,
        stages: result.stages,
        error: sanitizeError(result.error) ?? null,
      })
    );

    if (!result.ok) {
      process.exit(1);
    }

    if (i + 1 < args.runs) {
      await waitWorkerIdle(
        httpBase,
        Math.min(args.timeoutMs, 120_000),
        args.pollMs
      );
    }
  }

  const summaryPath = join(args.outDir, "e2e-create-chat-summary.json");
  writeFileSync(
    summaryPath,
    JSON.stringify(
      {
        ok: true,
        runs: args.runs,
        skipHandoff: args.skipHandoff,
        workerId,
        results: results.map((r) => ({
          index: r.index,
          chatId: r.chatId,
          canaryHash: shortHash(r.canary),
          durationsMs: r.durationsMs,
        })),
      },
      null,
      2
    )
  );

  console.log(
    JSON.stringify({
      ok: true,
      stage: args.skipHandoff ? "capture_chat_id" : "handoff_completed",
      runs: args.runs,
      summary: summaryPath,
    })
  );
}

main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(JSON.stringify({ ok: false, stage: "fatal", error: message }));
  process.exit(1);
});
