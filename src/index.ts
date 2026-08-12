import { config as loadEnv } from "dotenv";
import { mkdirSync, appendFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { configureLogger } from "./logging/logger.js";
import { startMcpServer } from "./mcp/server.js";
import { startRemoteMcpServer } from "./mcp/remote-server.js";
import { startHttpApi } from "./http/api.js";
import { startBrowserWorker, type BrowserWorker } from "./browser/worker.js";
import { log } from "./logging/logger.js";

loadEnv();

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

export function loadConfig(): AppConfig {
  const rateLimitRaw =
    process.env.RATE_LIMIT_BACKOFF_MS ?? "300000,900000,1800000";
  const workerUrl = process.env.CHATGPT_WORKER_URL?.trim() ?? "";

  return {
    dbPath: resolveUserPath(
      process.env.HANDOFF_DB_PATH ?? "./data/handoff.sqlite"
    ),
    httpPort: Number(process.env.HANDOFF_HTTP_PORT ?? 8787),
    cdpEndpoint:
      process.env.CHATGPT_CDP_ENDPOINT?.trim() || "http://127.0.0.1:9222",
    workerUrl,
    chatGptUrl: process.env.CHATGPT_URL ?? "https://chatgpt.com",
    pollIntervalMs: Number(process.env.DISPATCH_POLL_INTERVAL_MS ?? 2000),
    approvalTimeoutMs: Number(
      process.env.DISPATCH_APPROVAL_TIMEOUT_MS ?? 300000
    ),
    rateLimitBackoffMs: rateLimitRaw.split(",").map((v) => Number(v.trim())),
    logDir: resolveUserPath(process.env.LOG_DIR ?? "./logs"),
    remoteMcpPort: Number(process.env.HANDOFF_REMOTE_MCP_PORT ?? 8790),
    remoteMcpToken: process.env.HANDOFF_REMOTE_MCP_TOKEN,
    remoteMcpDisableAuth: process.env.HANDOFF_REMOTE_MCP_DISABLE_AUTH === "1",
  };
}

function requireWorkerUrl(config: AppConfig): void {
  if (!config.workerUrl || !/^https?:\/\//i.test(config.workerUrl)) {
    throw new Error(
      "CHATGPT_WORKER_URL is required. Set it to the full worker conversation URL " +
        "(e.g. https://chatgpt.com/c/xxxxxxxx) in .env."
    );
  }
}

function registerShutdown(worker: BrowserWorker): void {
  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log({
      event: "INFO",
      component: "browser-worker",
      message: `Received ${signal}, disconnecting CDP (Chrome stays open)...`,
    });
    await worker.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

function startWorkerFromConfig(config: AppConfig): Promise<BrowserWorker> {
  requireWorkerUrl(config);
  return startBrowserWorker({
    dbPath: config.dbPath,
    cdpEndpoint: config.cdpEndpoint,
    workerUrl: config.workerUrl,
    chatGptUrl: config.chatGptUrl,
    pollIntervalMs: config.pollIntervalMs,
    approvalTimeoutMs: config.approvalTimeoutMs,
    rateLimitBackoffMs: config.rateLimitBackoffMs,
  });
}

async function main(): Promise<void> {
  const mode = process.argv[2] ?? "all";
  const config = loadConfig();

  mkdirSync(config.logDir, { recursive: true });
  configureLogger(config.logDir);

  if (mode === "mcp") {
    await startMcpServer({ dbPath: config.dbPath });
    return;
  }

  if (mode === "worker") {
    await startHttpApi({ port: config.httpPort, dbPath: config.dbPath });
    const worker = await startWorkerFromConfig(config);
    registerShutdown(worker);
    return;
  }

  if (mode === "http") {
    await startHttpApi({ port: config.httpPort, dbPath: config.dbPath });
    return;
  }

  if (mode === "remote-mcp") {
    if (config.remoteMcpDisableAuth) {
      console.error(
        "HANDOFF_REMOTE_MCP_DISABLE_AUTH=1 — starting remote MCP with NO AUTH. " +
          "Anyone with the tunnel URL can call it. Only use this for short-lived testing."
      );
      startRemoteMcpServer({
        port: config.remoteMcpPort,
        dbPath: config.dbPath,
        authToken: null,
      });
      return;
    }

    let token = config.remoteMcpToken;
    if (!token) {
      token = randomBytes(32).toString("hex");
      appendFileSync(
        resolve(".env"),
        `\nHANDOFF_REMOTE_MCP_TOKEN=${token}\n`
      );
      console.error(
        `Generated a new HANDOFF_REMOTE_MCP_TOKEN and appended it to .env:\n${token}\n` +
          "Use this as the bearer token when connecting ChatGPT's connector."
      );
    }
    startRemoteMcpServer({
      port: config.remoteMcpPort,
      dbPath: config.dbPath,
      authToken: token,
    });
    return;
  }

  if (mode === "all") {
    // Run HTTP status API + browser worker together.
    // MCP stdio server must run as a separate process (Cursor spawns it).
    await startHttpApi({ port: config.httpPort, dbPath: config.dbPath });
    const worker = await startWorkerFromConfig(config);
    registerShutdown(worker);
    return;
  }

  console.error(
    `Unknown mode: ${mode}. Use: mcp | worker | http | remote-mcp | all`
  );
  process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
