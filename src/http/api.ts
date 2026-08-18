import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { initDatabase, getDatabase } from "../db/sqlite.js";
import { TaskRepository } from "../tasks/task.repository.js";
import { TaskService } from "../tasks/task.service.js";
import { log } from "../logging/logger.js";
import { DEFAULT_WORKER_ID, type HandoffTask } from "../tasks/task.types.js";
import {
  dashboardContentMode,
  deriveWorkerIndicators,
  redactPreview,
  sanitizeChatUrl,
  taskTiming,
} from "../dashboard/observability.js";
import { loadWorkersTopology } from "../config/workers-topology.js";
import {
  isChatBudgetExhausted,
  parseMaxTasksPerChat,
  shouldWarnChatBudget,
} from "../workers/chat-budget.js";
import {
  executeRecover,
  failTaskById,
  newOpsToken,
  planRecover,
  redactCdpEndpoint,
  type RecoverPlan,
} from "../ops/recover.js";
import {
  getTaskUsage,
  getTaskUsageMap,
  usageBundleForWorker,
  usageBundleTotal,
  usageEstimateDetailJson,
  usageEstimateListJson,
} from "../usage/task-usage.repository.js";
import { loadCostConfig } from "../usage/pricing.js";
import type { TaskUsageSnapshot } from "../usage/usage.types.js";

const OPS_BODY_MAX = 8_192;
const PLAN_TTL_MS = 90_000;

type OpsPlanEntry = {
  plan: RecoverPlan;
  expiresAt: number;
  consumed: boolean;
};

function parseJsonObject(
  raw: string
): { ok: true; value: Record<string, unknown> } | { ok: false; error: string } {
  if (raw.length > OPS_BODY_MAX) {
    return { ok: false, error: "body too large" };
  }
  if (!raw.trim()) return { ok: false, error: "empty body" };
  try {
    const value = JSON.parse(raw) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return { ok: false, error: "JSON object required" };
    }
    return { ok: true, value: value as Record<string, unknown> };
  } catch {
    return { ok: false, error: "invalid JSON" };
  }
}

function allowOnlyKeys(
  body: Record<string, unknown>,
  keys: string[]
): string | null {
  const allowed = new Set(keys);
  for (const k of Object.keys(body)) {
    if (!allowed.has(k)) return `unknown field: ${k}`;
  }
  return null;
}

function usageOpts() {
  try {
    const cfg = loadCostConfig();
    return {
      referencePricingEnabled: cfg.referencePricingEnabled,
      scenarioDisplayName: cfg.scenarioDisplayName,
    };
  } catch {
    return { referencePricingEnabled: false as const };
  }
}

export interface HttpApiOptions {
  port: number;
  dbPath: string;
  /** When true, run expireLeases on an interval (status-api ownership). */
  runLeaseReaper?: boolean;
  reaperIntervalMs?: number;
  /** Optional default worker id for GET /worker single-view (compat). */
  workerId?: string;
}

/** Retain the listen handle so V8 cannot GC the server after startHttpApi() returns. */
let httpServer: Server | undefined;

function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  extraHeaders?: Record<string, string>
): void {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
    ...extraHeaders,
  });
  res.end(JSON.stringify(body));
}

function scrubTaskListItem(
  t: HandoffTask,
  nowIso: string,
  usage?: TaskUsageSnapshot | null
) {
  const timing = taskTiming(t, nowIso);
  return {
    id: t.id,
    status: t.status,
    type: t.type,
    leaseOwner: t.leaseOwner ?? null,
    createdAt: t.createdAt,
    completedAt: t.completedAt ?? null,
    dispatchStartedAt: timing.dispatchStartedAt,
    dispatchedAt: timing.dispatchedAt,
    processingAt: timing.processingAt,
    terminalAt: timing.terminalAt,
    queueMs: timing.queueMs,
    processingMs: timing.processingMs,
    totalMs: timing.totalMs,
    processingAgeMs: timing.processingAgeMs,
    errorCode: t.error
      ? t.error.split(":")[0]?.slice(0, 64) ?? "ERROR"
      : null,
    hasPrompt: Boolean(t.prompt),
    hasResult: Boolean(t.result),
    usageEstimate: usageEstimateListJson(usage ?? null, usageOpts()),
  };
}

function dashboardPublicDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    // Prefer checkout src so a stale dist/ copy cannot pin an old dashboard.
    join(process.cwd(), "src/dashboard/public"),
    join(here, "../dashboard/public"),
    join(process.cwd(), "dist/dashboard/public"),
  ];
  return (
    candidates.find((p) => existsSync(join(p, "index.html"))) ?? candidates[0]!
  );
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};

function serveDashboardAsset(
  res: ServerResponse,
  pathname: string
): boolean {
  const root = dashboardPublicDir();
  let rel = pathname.replace(/^\/dashboard\/?/, "");
  if (!rel || rel === "") rel = "index.html";
  if (rel.includes("..") || rel.startsWith("/")) {
    sendJson(res, 400, { error: "bad path" });
    return true;
  }
  const filePath = join(root, rel);
  if (!existsSync(filePath)) {
    return false;
  }
  const body = readFileSync(filePath);
  res.writeHead(200, {
    "Content-Type": MIME[extname(filePath)] ?? "application/octet-stream",
    "Cache-Control": "no-store",
  });
  res.end(body);
  return true;
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf-8");
}

const TERMINAL_WAIT_STATUSES = new Set([
  "COMPLETED",
  "FAILED",
  "CANCELLED",
]);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function startHttpApi(options: HttpApiOptions): Promise<void> {
  initDatabase(options.dbPath);
  const repo = new TaskRepository(getDatabase());
  const taskService = new TaskService(repo);
  const viewWorkerId = options.workerId?.trim() || DEFAULT_WORKER_ID;

  let lastReapAt: string | null = null;
  let lastReapStats: {
    requeued: number;
    timedOut: number;
    failed: number;
  } | null = null;

  let opsCsrf = newOpsToken();
  const opsPlans = new Map<string, OpsPlanEntry>();
  let opsBusy = false;

  const allowedOrigins = new Set([
    `http://127.0.0.1:${options.port}`,
    `http://localhost:${options.port}`,
  ]);

  function requireOpsBrowser(req: IncomingMessage): string | null {
    const origin = req.headers.origin;
    if (typeof origin === "string" && origin.length > 0) {
      if (origin === "null") return "Origin null forbidden";
      if (!allowedOrigins.has(origin)) return "Origin not allowed";
      return null;
    }
    const site = req.headers["sec-fetch-site"];
    if (typeof site === "string" && site !== "same-origin") {
      return "Sec-Fetch-Site must be same-origin";
    }
    // Non-browser clients (curl) must still present CSRF.
    return null;
  }

  function requireOpsCsrf(req: IncomingMessage): string | null {
    const hdr = req.headers["x-ops-csrf"];
    const token = Array.isArray(hdr) ? hdr[0] : hdr;
    if (!token || token !== opsCsrf) return "invalid CSRF token";
    return null;
  }

  function rotateOpsCsrf(): void {
    opsCsrf = newOpsToken();
  }

  function prunePlans(now = Date.now()): void {
    for (const [id, entry] of opsPlans) {
      if (entry.consumed || entry.expiresAt <= now) opsPlans.delete(id);
    }
  }

  function auditOps(data: Record<string, unknown>): void {
    const affectedTaskIds = Array.isArray(data.affectedTaskIds)
      ? (data.affectedTaskIds as string[]).slice(0, 20)
      : undefined;
    const affectedWorkerIds = Array.isArray(data.affectedWorkerIds)
      ? (data.affectedWorkerIds as string[]).slice(0, 20)
      : undefined;
    log({
      event: "INFO",
      component: "ops",
      message: "ops_mutation",
      data: {
        ...data,
        affectedTaskIds,
        affectedWorkerIds,
        affectedTruncated:
          (Array.isArray(data.affectedTaskIds) &&
            (data.affectedTaskIds as string[]).length > 20) ||
          (Array.isArray(data.affectedWorkerIds) &&
            (data.affectedWorkerIds as string[]).length > 20) ||
          undefined,
      },
    });
  }

  if (options.runLeaseReaper) {
    const interval = options.reaperIntervalMs ?? 2000;
    const tick = () => {
      try {
        const stats = taskService.expireLeases();
        lastReapAt = new Date().toISOString();
        lastReapStats = stats;
        if (stats.requeued || stats.timedOut || stats.failed) {
          log({
            event: "INFO",
            component: "lease-reaper",
            message: `expireLeases requeued=${stats.requeued} timedOut=${stats.timedOut} failed=${stats.failed}`,
          });
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log({
          event: "ERROR",
          component: "lease-reaper",
          message,
        });
      }
    };
    tick();
    // Keep the timer referenced: in status-api mode it is a backup event-loop
    // keep-alive if the HTTP handle is dropped. worker/all already hang in main().
    setInterval(tick, interval);
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://localhost:${options.port}`);

    try {
      if (
        req.method === "GET" &&
        (url.pathname === "/dashboard" || url.pathname === "/dashboard/")
      ) {
        res.writeHead(302, { Location: "/dashboard/index.html" });
        res.end();
        return;
      }

      if (req.method === "GET" && url.pathname.startsWith("/dashboard/")) {
        if (!serveDashboardAsset(res, url.pathname)) {
          sendJson(res, 404, { error: "Dashboard asset not found" });
        }
        return;
      }

      if (req.method === "GET" && url.pathname === "/health") {
        const since24h = new Date(Date.now() - 24 * 3600_000).toISOString();
        let costMeta: {
          model: string;
          scenarioDisplayName: string;
          priceTableVersion: string;
          referencePricingEnabled: boolean;
        } | null = null;
        try {
          const cfg = loadCostConfig();
          costMeta = {
            model: cfg.modelKey,
            scenarioDisplayName: cfg.scenarioDisplayName,
            priceTableVersion: cfg.priceTableVersion,
            referencePricingEnabled: cfg.referencePricingEnabled,
          };
        } catch {
          costMeta = null;
        }
        sendJson(res, 200, {
          ok: true,
          lastReapAt,
          reaper: Boolean(options.runLeaseReaper),
          usageTotals: usageBundleTotal(getDatabase(), since24h),
          costConfig: costMeta,
          referencePricingEnabled: costMeta?.referencePricingEnabled ?? false,
        });
        return;
      }

      if (req.method === "GET" && url.pathname === "/workers") {
        const now = Date.now();
        const nowIso = new Date(now).toISOString();
        const staleMs = Number(process.env.HANDOFF_WORKER_STALE_MS ?? 120_000);
        const since24h = new Date(now - 24 * 3600_000).toISOString();
        const maxTasksPerChat = parseMaxTasksPerChat(
          process.env.HANDOFF_MAX_TASKS_PER_CHAT
        );
        const counts = repo.countTerminalByLeaseOwner(since24h);
        const db = getDatabase();
        const workers = repo.listWorkers().map((w) => {
          const lastSeenMs = w.lastSeenAt
            ? Date.parse(w.lastSeenAt)
            : Number.NaN;
          const heartbeatAgeMs = Number.isFinite(lastSeenMs)
            ? now - lastSeenMs
            : null;
          const heartbeatStale =
            !Number.isFinite(lastSeenMs) || now - lastSeenMs > staleMs;
          let pidAlive = false;
          if (w.pid && w.pid > 0) {
            try {
              process.kill(w.pid, 0);
              pidAlive = true;
            } catch {
              pidAlive = false;
            }
          }
          const healthy = pidAlive && !heartbeatStale;
          const agg = counts.get(w.id) ?? {
            completed: 0,
            failed: 0,
            timedOut: 0,
          };
          let currentTaskAgeMs: number | null = null;
          if (w.currentTaskId) {
            const cur = repo.getTaskById(w.currentTaskId);
            if (cur) {
              currentTaskAgeMs = taskTiming(cur, nowIso).processingAgeMs;
            }
          }
          const chatUrl = sanitizeChatUrl(w.workerUrl);
          const tasksOnChat = w.tasksOnChat ?? 0;
          return {
            id: w.id,
            status: w.status,
            healthy,
            pid: w.pid ?? null,
            pidAlive,
            heartbeatStale,
            heartbeatAgeMs,
            activeTask: Boolean(w.currentTaskId),
            currentTaskId: w.currentTaskId ?? null,
            lastSeenAt: w.lastSeenAt ?? null,
            startedAt: w.startedAt ?? null,
            httpPort: w.httpPort ?? null,
            chatUrl,
            chatAvailable: Boolean(chatUrl),
            tasksOnChat,
            maxTasksPerChat,
            chatBudgetWarn: shouldWarnChatBudget(tasksOnChat, maxTasksPerChat),
            chatBudgetExhausted: isChatBudgetExhausted(
              tasksOnChat,
              maxTasksPerChat
            ),
            readinessReason: w.readinessReason ?? null,
            completedLast24h: agg.completed,
            failedLast24h: agg.failed,
            timedOutLast24h: agg.timedOut,
            usage: usageBundleForWorker(db, w.id, since24h),
            indicators: deriveWorkerIndicators({
              status: w.status,
              healthy,
              pidAlive,
              heartbeatStale,
              heartbeatAgeMs,
              currentTaskAgeMs,
              recentFailed: agg.failed,
              recentTimedOut: agg.timedOut,
              readinessReason: w.readinessReason,
              chatBudgetWarn: shouldWarnChatBudget(tasksOnChat, maxTasksPerChat),
              chatBudgetExhausted: isChatBudgetExhausted(
                tasksOnChat,
                maxTasksPerChat
              ),
            }),
            errorCode: w.error
              ? w.error.split(":")[0]?.slice(0, 64) ?? "ERROR"
              : null,
          };
        });
        sendJson(res, 200, {
          workers,
          lastReapAt,
          lastReapStats,
          serverTime: nowIso,
          usageTotals: usageBundleTotal(db, since24h),
        });
        return;
      }

      if (req.method === "GET" && url.pathname === "/worker") {
        const state = repo.getWorkerState(viewWorkerId);
        sendJson(res, 200, {
          status: state.status,
          activeTask: Boolean(state.currentTaskId),
          workerId: state.id,
          errorCode: state.error
            ? state.error.split(":")[0]?.slice(0, 64) ?? "ERROR"
            : null,
        });
        return;
      }

      if (req.method === "GET" && url.pathname === "/tasks") {
        const limit = Number(url.searchParams.get("limit") ?? 40);
        const nowIso = new Date().toISOString();
        const recent = repo.listRecentTasks(limit);
        const usageMap = getTaskUsageMap(
          getDatabase(),
          recent.map((t) => t.id)
        );
        const tasks = recent.map((t) =>
          scrubTaskListItem(t, nowIso, usageMap.get(t.id) ?? null)
        );
        sendJson(res, 200, { tasks, serverTime: nowIso });
        return;
      }

      const waitMatch = url.pathname.match(/^\/tasks\/([^/]+)\/wait$/);
      if (req.method === "GET" && waitMatch) {
        const taskId = decodeURIComponent(waitMatch[1] ?? "");
        const timeoutSeconds = Math.min(
          1800,
          Math.max(1, Number(url.searchParams.get("timeoutSeconds") ?? 480))
        );
        const tickMs = Math.min(
          2000,
          Math.max(
            100,
            Number(
              url.searchParams.get("tickMs") ??
                process.env.HANDOFF_WAIT_TICK_MS ??
                250
            )
          )
        );
        const deadline = Date.now() + timeoutSeconds * 1000;

        let lastStatus: string | null = null;
        while (Date.now() < deadline) {
          if (req.destroyed) return;
          try {
            const { status } = taskService.getTaskStatus(taskId);
            lastStatus = status;
            if (TERMINAL_WAIT_STATUSES.has(status)) {
              sendJson(res, 200, { status, timedOut: false });
              return;
            }
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            if (message.includes("Task not found")) {
              sendJson(res, 404, { error: message });
              return;
            }
            throw err;
          }
          const remaining = deadline - Date.now();
          if (remaining <= 0) break;
          await sleep(Math.min(tickMs, remaining));
        }

        sendJson(res, 200, {
          status: lastStatus,
          timedOut: true,
        });
        return;
      }

      if (req.method === "GET" && url.pathname.startsWith("/tasks/")) {
        const rest = url.pathname.slice("/tasks/".length);
        const parts = rest.split("/").filter(Boolean);
        const taskId = parts[0] ? decodeURIComponent(parts[0]) : "";
        const sub = parts[1];

        if (!taskId || taskId.includes("..")) {
          sendJson(res, 404, { error: "Not found" });
          return;
        }

        if (sub === "detail") {
          const task = repo.getTaskById(taskId);
          if (!task) {
            sendJson(res, 404, { error: `Task not found: ${taskId}` });
            return;
          }
          const nowIso = new Date().toISOString();
          const usage = getTaskUsage(getDatabase(), taskId);
          sendJson(res, 200, {
            ...scrubTaskListItem(task, nowIso, usage),
            usageEstimate: usageEstimateDetailJson(usage, usageOpts()),
            contentMode: dashboardContentMode(),
            serverTime: nowIso,
          });
          return;
        }

        if (sub === "content") {
          const mode = dashboardContentMode();
          if (mode !== "redacted") {
            sendJson(res, 403, {
              error: "Task content disabled",
              hint: "Set HANDOFF_DASHBOARD_TASK_CONTENT=redacted to enable redacted previews",
              mode: "off",
            });
            return;
          }
          const task = repo.getTaskById(taskId);
          if (!task) {
            sendJson(res, 404, { error: `Task not found: ${taskId}` });
            return;
          }
          sendJson(res, 200, {
            taskId: task.id,
            mode: "redacted",
            prompt: redactPreview(task.prompt),
            result: redactPreview(task.result),
            warning:
              "Best-effort server redaction — not a guarantee. Localhost only.",
          });
          return;
        }

        if (sub) {
          sendJson(res, 404, { error: "Not found" });
          return;
        }

        // Compat: status-only (hooks / waiters)
        try {
          const status = taskService.getTaskStatus(taskId);
          sendJson(res, 200, status);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          if (message.includes("Task not found")) {
            sendJson(res, 404, { error: message });
            return;
          }
          throw err;
        }
        return;
      }

      if (
        req.method === "GET" &&
        url.pathname === "/conversations/pending"
      ) {
        const conversationId = url.searchParams.get("conversationId");
        if (!conversationId) {
          sendJson(res, 400, { error: "conversationId required" });
          return;
        }
        const pending = taskService.findPendingForConversation(conversationId);
        sendJson(res, 200, { pending: pending ?? null });
        return;
      }

      if (
        req.method === "GET" &&
        url.pathname === "/conversations/completed"
      ) {
        const conversationId = url.searchParams.get("conversationId");
        if (!conversationId) {
          sendJson(res, 400, { error: "conversationId required" });
          return;
        }
        const completed =
          taskService.findCompletedForConversation(conversationId);
        sendJson(res, 200, { completed: completed ?? null });
        return;
      }

      if (req.method === "POST" && url.pathname === "/tasks/mark-idle") {
        const body = JSON.parse(await readBody(req)) as { taskId?: string };
        if (!body.taskId) {
          sendJson(res, 400, { error: "taskId required" });
          return;
        }
        taskService.markReadyButCursorIdle(body.taskId);
        sendJson(res, 200, { ok: true });
        return;
      }

      // Dashboard 0.3 — guarded mutations (CSRF + confirm + plan token).
      if (req.method === "GET" && url.pathname === "/ops/session") {
        const gate = requireOpsBrowser(req);
        if (gate) {
          sendJson(res, 403, { error: gate });
          return;
        }
        sendJson(res, 200, { csrf: opsCsrf }, { "Cache-Control": "no-store" });
        return;
      }

      if (req.method === "POST" && url.pathname === "/ops/recover/preview") {
        const gate = requireOpsBrowser(req) ?? requireOpsCsrf(req);
        if (gate) {
          sendJson(res, 403, { error: gate });
          return;
        }
        const parsed = parseJsonObject(await readBody(req));
        if (!parsed.ok) {
          sendJson(res, 400, { error: parsed.error });
          return;
        }
        const unknown = allowOnlyKeys(parsed.value, ["failQueued", "keepId"]);
        if (unknown) {
          sendJson(res, 400, { error: unknown });
          return;
        }
        if ("failOpen" in parsed.value) {
          sendJson(res, 400, {
            error: "failOpen is CLI-only in dashboard 0.3",
          });
          return;
        }
        const failQueued = Boolean(parsed.value.failQueued);
        const keepId =
          typeof parsed.value.keepId === "string"
            ? parsed.value.keepId
            : undefined;
        if (keepId && !keepId.startsWith("ho_")) {
          sendJson(res, 400, { error: "keepId must start with ho_" });
          return;
        }
        prunePlans();
        const plan = planRecover(getDatabase(), { failQueued, keepId });
        const planToken = newOpsToken();
        const expiresAt = Date.now() + PLAN_TTL_MS;
        opsPlans.set(planToken, { plan, expiresAt, consumed: false });
        auditOps({
          operation: "recover_preview",
          dryRun: true,
          options: plan.options,
          counts: {
            dispatching: plan.dispatching.length,
            waiting: plan.waiting.length,
            queued: plan.queued.length,
            workers: plan.workers.length,
            mutationCount: plan.mutationCount,
          },
          planHash: plan.planHash,
          outcome: "success",
        });
        sendJson(
          res,
          200,
          {
            planToken,
            expiresAt: new Date(expiresAt).toISOString(),
            confirmPhrase: plan.confirmPhrase,
            mutationCount: plan.mutationCount,
            planHash: plan.planHash,
            willExpireLeases: true,
            options: plan.options,
            dispatching: plan.dispatching.slice(0, 20),
            waiting: plan.waiting.slice(0, 20),
            queued: plan.queued.slice(0, 20),
            workers: plan.workers.slice(0, 20),
            truncated:
              plan.dispatching.length > 20 ||
              plan.waiting.length > 20 ||
              plan.queued.length > 20 ||
              plan.workers.length > 20,
          },
          { "Cache-Control": "no-store" }
        );
        return;
      }

      if (req.method === "POST" && url.pathname === "/ops/recover") {
        const gate = requireOpsBrowser(req) ?? requireOpsCsrf(req);
        if (gate) {
          sendJson(res, 403, { error: gate });
          return;
        }
        if (opsBusy) {
          sendJson(res, 409, { error: "ops busy", code: "ops_busy" });
          return;
        }
        const parsed = parseJsonObject(await readBody(req));
        if (!parsed.ok) {
          sendJson(res, 400, { error: parsed.error });
          return;
        }
        const unknown = allowOnlyKeys(parsed.value, [
          "confirm",
          "planToken",
        ]);
        if (unknown) {
          sendJson(res, 400, { error: unknown });
          return;
        }
        const confirm =
          typeof parsed.value.confirm === "string"
            ? parsed.value.confirm.trim()
            : "";
        const planToken =
          typeof parsed.value.planToken === "string"
            ? parsed.value.planToken
            : "";
        if (!planToken) {
          sendJson(res, 400, { error: "planToken required — preview first" });
          return;
        }
        prunePlans();
        const entry = opsPlans.get(planToken);
        if (!entry || entry.consumed || entry.expiresAt <= Date.now()) {
          sendJson(res, 409, {
            error: "plan expired or unknown — preview again",
            code: "plan_stale",
          });
          return;
        }
        if (confirm !== entry.plan.confirmPhrase) {
          sendJson(res, 400, {
            error: `confirm must be exactly "${entry.plan.confirmPhrase}"`,
          });
          return;
        }
        opsBusy = true;
        try {
          entry.consumed = true;
          opsPlans.delete(planToken);
          const result = executeRecover(getDatabase(), entry.plan);
          rotateOpsCsrf();
          auditOps({
            operation: "recover",
            dryRun: false,
            source: "dashboard",
            options: entry.plan.options,
            planHash: result.planHash,
            counts: {
              tasksChanged:
                result.dispatchingFailed +
                result.waitingTimedOut +
                result.queuedFailed +
                result.openFailed,
              workersReset: result.workersReset,
              expiredRequeued: result.expired.requeued,
              expiredTimedOut: result.expired.timedOut,
              expiredFailed: result.expired.failed,
            },
            affectedTaskIds: result.affectedTaskIds,
            affectedWorkerIds: result.affectedWorkerIds,
            outcome: "success",
          });
          sendJson(res, 200, { ok: true, csrf: opsCsrf, ...result });
        } catch (err) {
          const code =
            err instanceof Error &&
            (err as Error & { code?: string }).code === "plan_stale"
              ? "plan_stale"
              : "failed";
          auditOps({
            operation: "recover",
            dryRun: false,
            source: "dashboard",
            outcome: "failed",
            errorCode: code,
          });
          sendJson(
            res,
            code === "plan_stale" ? 409 : 500,
            {
              error:
                code === "plan_stale"
                  ? "plan_stale — preview again"
                  : err instanceof Error
                    ? err.message
                    : String(err),
              code,
            }
          );
        } finally {
          opsBusy = false;
        }
        return;
      }

      if (req.method === "POST" && url.pathname === "/ops/tasks/fail") {
        const gate = requireOpsBrowser(req) ?? requireOpsCsrf(req);
        if (gate) {
          sendJson(res, 403, { error: gate });
          return;
        }
        if (opsBusy) {
          sendJson(res, 409, { error: "ops busy", code: "ops_busy" });
          return;
        }
        const parsed = parseJsonObject(await readBody(req));
        if (!parsed.ok) {
          sendJson(res, 400, { error: parsed.error });
          return;
        }
        const unknown = allowOnlyKeys(parsed.value, [
          "confirm",
          "taskId",
          "reason",
        ]);
        if (unknown) {
          sendJson(res, 400, { error: unknown });
          return;
        }
        const taskId =
          typeof parsed.value.taskId === "string"
            ? parsed.value.taskId.trim()
            : "";
        if (!taskId) {
          sendJson(res, 400, { error: "taskId required" });
          return;
        }
        const expected = `FAIL ${taskId}`;
        const confirm =
          typeof parsed.value.confirm === "string"
            ? parsed.value.confirm.trim()
            : "";
        if (confirm !== expected) {
          sendJson(res, 400, {
            error: `confirm must be exactly "${expected}"`,
          });
          return;
        }
        const reason =
          typeof parsed.value.reason === "string"
            ? parsed.value.reason
            : undefined;
        opsBusy = true;
        try {
          const result = failTaskById(getDatabase(), taskId, reason);
          if (!result.ok) {
            const status =
              result.code === "not_found"
                ? 404
                : result.code === "conflict"
                  ? 409
                  : 400;
            auditOps({
              operation: "fail_task",
              targetTaskId: taskId,
              outcome: "rejected",
              errorCode: result.code ?? "bad_request",
            });
            sendJson(res, status, result);
            return;
          }
          rotateOpsCsrf();
          auditOps({
            operation: "fail_task",
            source: "dashboard",
            targetTaskId: taskId,
            counts: { tasksChanged: 1 },
            affectedTaskIds: [taskId],
            outcome: "success",
          });
          sendJson(res, 200, { ...result, csrf: opsCsrf });
        } finally {
          opsBusy = false;
        }
        return;
      }

      if (req.method === "GET" && url.pathname === "/ops/topology") {
        try {
          const topology = loadWorkersTopology({
            workersFile: process.env.HANDOFF_WORKERS_FILE,
            workerId:
              process.env.HANDOFF_WORKER_ID?.trim() || DEFAULT_WORKER_ID,
            workerUrl: process.env.HANDOFF_WORKER_URL?.trim() || "",
            cdpEndpoint: process.env.CDP_ENDPOINT?.trim() || "",
            httpPort: process.env.HANDOFF_HTTP_PORT
              ? Number(process.env.HANDOFF_HTTP_PORT)
              : undefined,
          });
          const live = new Map(
            repo.listWorkers().map((w) => [w.id, w] as const)
          );
          sendJson(
            res,
            200,
            {
              source: topology.source,
              filePath: topology.filePath ?? null,
              workers: topology.workers.map((w) => {
                const state = live.get(w.id);
                return {
                  id: w.id,
                  httpPort: w.httpPort ?? state?.httpPort ?? null,
                  chatUrl: sanitizeChatUrl(w.workerUrl),
                  cdpHost: redactCdpEndpoint(w.cdpEndpoint),
                  status: state?.status ?? null,
                  currentTaskId: state?.currentTaskId ?? null,
                  lastSeenAt: state?.lastSeenAt ?? null,
                };
              }),
            },
            { "Cache-Control": "no-store" }
          );
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          sendJson(res, 500, { error: message });
        }
        return;
      }

      sendJson(res, 404, { error: "Not found" });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      sendJson(res, 500, { error: message });
    }
  });

  httpServer = server;
  server.requestTimeout = 0;
  server.headersTimeout = 0;
  server.timeout = 0;

  return new Promise((resolve, reject) => {
    server.once("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        reject(
          new Error(
            `Port ${options.port} already in use — status-api (or another process) is already bound. ` +
              `Check: curl -s http://127.0.0.1:${options.port}/health  ` +
              `For multi-worker, run one status-api on :${options.port} and separate browser-worker processes.`
          )
        );
        return;
      }
      reject(err);
    });
    server.listen(options.port, "127.0.0.1", () => {
      log({
        event: "INFO",
        component: "http-api",
        message:
          `Status API listening on http://127.0.0.1:${options.port}` +
          (options.runLeaseReaper ? " (lease reaper on)" : "") +
          ` · dashboard http://127.0.0.1:${options.port}/dashboard/`,
      });
      resolve();
    });
  });
}
