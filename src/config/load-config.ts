import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { DEFAULT_WORKER_ID } from "../tasks/task.types.js";

export interface AppConfig {
  dbPath: string;
  httpPort: number;
  cdpEndpoint: string;
  workerUrl: string;
  chatGptUrl: string;
  pollIntervalMs: number;
  approvalTimeoutMs: number;
  rateLimitBackoffMs: number[];
  logDir: string;
  remoteMcpPort: number;
  remoteMcpToken: string | undefined;
  remoteMcpDisableAuth: boolean;
  workerId: string;
  leaseMs: number;
  workerStaleMs: number;
  workersFile?: string;
  reaperIntervalMs: number;
}

/** Resolve env paths. Node's path.resolve does not expand `~`. */
export function resolveUserPath(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed === "~") return homedir();
  if (trimmed.startsWith("~/")) {
    return resolve(join(homedir(), trimmed.slice(2)));
  }
  return resolve(trimmed);
}

/** Per-user data root. Override with CHATGPT_MCP_HOME (absolute or ~/…). */
export function chatgptMcpHome(): string {
  return resolveUserPath(
    process.env.CHATGPT_MCP_HOME?.trim() || join(homedir(), ".chatgpt-mcp")
  );
}

export function loadConfig(): AppConfig {
  const rateLimitRaw =
    process.env.RATE_LIMIT_BACKOFF_MS ?? "300000,900000,1800000";
  const workerUrl = process.env.CHATGPT_WORKER_URL?.trim() ?? "";
  const home = chatgptMcpHome();
  const pollIntervalMs = Number(process.env.DISPATCH_POLL_INTERVAL_MS ?? 2000);
  const approvalTimeoutMs = Number(
    process.env.DISPATCH_APPROVAL_TIMEOUT_MS ?? 120000
  );
  // Default 180s: several renewals during Playwright ops (each ≤ ~30s).
  const leaseMs = Number(process.env.HANDOFF_LEASE_MS ?? 180_000);
  const renewEveryMs = Math.min(30_000, Math.max(5_000, Math.floor(leaseMs / 6)));
  /** Longest single Playwright call we allow (must leave renew margin). */
  const maxBrowserOpMs = 60_000;
  const workerStaleMs = Number(
    process.env.HANDOFF_WORKER_STALE_MS ?? Math.max(leaseMs * 2, 60_000)
  );
  const reaperIntervalMs = Number(process.env.HANDOFF_REAPER_INTERVAL_MS ?? 2000);

  if (!Number.isFinite(pollIntervalMs) || pollIntervalMs < 200) {
    throw new Error(`DISPATCH_POLL_INTERVAL_MS invalid: ${pollIntervalMs}`);
  }
  if (!Number.isFinite(approvalTimeoutMs) || approvalTimeoutMs < 10_000) {
    throw new Error(`DISPATCH_APPROVAL_TIMEOUT_MS invalid: ${approvalTimeoutMs}`);
  }
  if (!Number.isFinite(leaseMs) || leaseMs < 90_000 || leaseMs > 3_600_000) {
    throw new Error(
      `HANDOFF_LEASE_MS must be 90000–3600000 (got ${leaseMs}). ` +
        `Need leaseMs >= 3 * renewInterval (~${renewEveryMs}ms) and margin for browser ops.`
    );
  }
  if (leaseMs < 3 * renewEveryMs) {
    throw new Error(
      `HANDOFF_LEASE_MS=${leaseMs} too short for renew every ${renewEveryMs}ms (need ≥ ${3 * renewEveryMs})`
    );
  }
  if (leaseMs < maxBrowserOpMs + 2 * renewEveryMs) {
    throw new Error(
      `HANDOFF_LEASE_MS=${leaseMs} leaves no margin for browserOp≤${maxBrowserOpMs}ms + 2 renewals`
    );
  }
  if (!Number.isFinite(workerStaleMs) || workerStaleMs < leaseMs) {
    throw new Error(
      `HANDOFF_WORKER_STALE_MS must be ≥ leaseMs (got ${workerStaleMs}, lease ${leaseMs})`
    );
  }
  if (!Number.isFinite(reaperIntervalMs) || reaperIntervalMs < 500) {
    throw new Error(`HANDOFF_REAPER_INTERVAL_MS invalid: ${reaperIntervalMs}`);
  }

  return {
    dbPath: resolveUserPath(
      process.env.HANDOFF_DB_PATH?.trim() ||
        join(home, "data", "handoff.sqlite")
    ),
    httpPort: Number(process.env.HANDOFF_HTTP_PORT ?? 8787),
    cdpEndpoint:
      process.env.CHATGPT_CDP_ENDPOINT?.trim() || "http://127.0.0.1:9222",
    workerUrl,
    chatGptUrl: process.env.CHATGPT_URL ?? "https://chatgpt.com",
    pollIntervalMs,
    approvalTimeoutMs,
    rateLimitBackoffMs: rateLimitRaw.split(",").map((v) => Number(v.trim())),
    logDir: resolveUserPath(
      process.env.LOG_DIR?.trim() || join(home, "logs")
    ),
    remoteMcpPort: Number(process.env.HANDOFF_REMOTE_MCP_PORT ?? 8790),
    remoteMcpToken: process.env.HANDOFF_REMOTE_MCP_TOKEN,
    remoteMcpDisableAuth: process.env.HANDOFF_REMOTE_MCP_DISABLE_AUTH === "1",
    workerId: process.env.HANDOFF_WORKER_ID?.trim() || DEFAULT_WORKER_ID,
    leaseMs,
    workerStaleMs,
    workersFile: process.env.HANDOFF_WORKERS_FILE?.trim() || undefined,
    reaperIntervalMs,
  };
}
