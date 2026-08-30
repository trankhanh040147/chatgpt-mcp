import { config as loadEnv } from "dotenv";
import { mkdirSync, appendFileSync } from "node:fs";
import { resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { configureLogger, log } from "./logging/logger.js";
import { startMcpServer } from "./mcp/server.js";
import { startRemoteMcpServer } from "./mcp/remote-server.js";
import { startHttpApi } from "./http/api.js";
import { startBrowserWorker, type BrowserWorker } from "./browser/worker.js";
import {
  startBrowserBroker,
  type BrowserBrokerHandle,
} from "./browser/start-broker.js";
import { resolveBrokerOpsPort } from "./ops/broker-ops-config.js";
import {
  loadWorkersTopology,
  validateWorkersTopology,
} from "./config/workers-topology.js";
import { loadConfig, type AppConfig } from "./config/load-config.js";

export { loadConfig, resolveUserPath, chatgptMcpHome } from "./config/load-config.js";
export type { AppConfig } from "./config/load-config.js";

loadEnv();

function requireWorkerUrl(config: AppConfig): void {
  if (!config.workerUrl || !/^https?:\/\//i.test(config.workerUrl)) {
    throw new Error(
      "CHATGPT_WORKER_URL is required. Set it to the full worker conversation URL " +
        "(e.g. https://chatgpt.com/c/xxxxxxxx) in .env."
    );
  }
}

function validateTopologyOrThrow(
  config: AppConfig,
  opts?: { includeHttpPort?: boolean; allowSharedCdp?: boolean }
): ReturnType<typeof loadWorkersTopology> {
  const topology = loadWorkersTopology({
    workersFile: config.workersFile,
    workerId: config.workerId,
    workerUrl: config.workerUrl,
    cdpEndpoint: config.cdpEndpoint,
    // status-api owns HANDOFF_HTTP_PORT; do not stamp it onto every browser-worker
    // or dual topology falsely reports duplicate httpPort.
    httpPort: opts?.includeHttpPort ? config.httpPort : undefined,
  });
  validateWorkersTopology(topology, {
    allowSharedCdp: opts?.allowSharedCdp === true,
  });
  log({
    event: "INFO",
    component: "config",
    message: `topology source=${topology.source} workers=${topology.workers.length} ids=[${topology.workers.map((w) => w.id).join(",")}] sharedCdp=${opts?.allowSharedCdp === true}`,
  });
  return topology;
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

function registerBrokerShutdown(handle: BrowserBrokerHandle): void {
  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log({
      event: "INFO",
      component: "browser-broker",
      message: `Received ${signal}, stopping actors + disconnecting CDP...`,
    });
    await handle.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

function startWorkerFromConfig(config: AppConfig): Promise<BrowserWorker> {
  requireWorkerUrl(config);
  validateTopologyOrThrow(config, { includeHttpPort: false });
  return startBrowserWorker({
    dbPath: config.dbPath,
    cdpEndpoint: config.cdpEndpoint,
    workerUrl: config.workerUrl,
    chatGptUrl: config.chatGptUrl,
    pollIntervalMs: config.pollIntervalMs,
    approvalTimeoutMs: config.approvalTimeoutMs,
    hardTimeoutMs: config.hardTimeoutMs,
    rateLimitBackoffMs: config.rateLimitBackoffMs,
    workerId: config.workerId,
    leaseMs: config.leaseMs,
    workerStaleMs: config.workerStaleMs,
    browserOnly: true,
  });
}

async function startBrokerFromConfig(
  config: AppConfig
): Promise<BrowserBrokerHandle> {
  const topology = validateTopologyOrThrow(config, {
    includeHttpPort: false,
    allowSharedCdp: true,
  });
  if (topology.workers.length < 1) {
    throw new Error(
      "browser-broker requires HANDOFF_WORKERS_FILE with ≥1 worker sharing one cdpEndpoint"
    );
  }
  const enabled = topology.workers.filter((w) => w.enabled !== false);
  if (enabled.length < 1) {
    throw new Error(
      "No enabled workers in HANDOFF_WORKERS_FILE — browser-broker cannot start. " +
        "Set enabled: true for at least one worker (dashboard Enable… or edit workers file)."
    );
  }
  const cdpEndpoint = enabled[0]?.cdpEndpoint ?? topology.workers[0]!.cdpEndpoint;
  const brokerOpsToken =
    process.env.HANDOFF_BROKER_OPS_TOKEN?.trim() ||
    randomBytes(32).toString("hex");
  if (!process.env.HANDOFF_BROKER_OPS_TOKEN?.trim()) {
    log({
      event: "WARN",
      component: "browser-broker",
      message:
        "HANDOFF_BROKER_OPS_TOKEN not set — generated ephemeral token for this process",
    });
  }
  return startBrowserBroker({
    dbPath: config.dbPath,
    cdpEndpoint,
    chatGptUrl: config.chatGptUrl,
    workers: enabled.map((w) => ({ id: w.id, workerUrl: w.workerUrl })),
    registryWorkerIds: enabled.map((w) => w.id),
    pollIntervalMs: config.pollIntervalMs,
    approvalTimeoutMs: config.approvalTimeoutMs,
    hardTimeoutMs: config.hardTimeoutMs,
    rateLimitBackoffMs: config.rateLimitBackoffMs,
    leaseMs: config.leaseMs,
    workerStaleMs: config.workerStaleMs,
    brokerOpsPort: resolveBrokerOpsPort(),
    brokerOpsToken,
  });
}

function registerHttpKeepalive(): Promise<void> {
  const shutdown = (signal: string) => {
    log({
      event: "INFO",
      component: "http-api",
      message: `Received ${signal}, shutting down status-api`,
    });
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("uncaughtException", (err) => {
    log({
      event: "ERROR",
      component: "http-api",
      message: `uncaughtException: ${err instanceof Error ? err.stack ?? err.message : String(err)}`,
    });
    process.exit(1);
  });
  process.on("unhandledRejection", (reason) => {
    const message =
      reason instanceof Error ? reason.stack ?? reason.message : String(reason);
    log({
      event: "ERROR",
      component: "http-api",
      message: `unhandledRejection: ${message}`,
    });
    process.exit(1);
  });
  return new Promise(() => {
    /* run until SIGINT/SIGTERM — same contract as browser-worker / broker */
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

  if (mode === "status-api" || mode === "http") {
    await startHttpApi({
      port: config.httpPort,
      dbPath: config.dbPath,
      runLeaseReaper: true,
      reaperIntervalMs: config.reaperIntervalMs,
      workerId: config.workerId,
      workersFile: config.workersFile,
    });
    await registerHttpKeepalive();
    return;
  }

  if (mode === "browser-worker") {
    const worker = await startWorkerFromConfig(config);
    registerShutdown(worker);
    await new Promise<void>(() => {
      /* run until SIGINT/SIGTERM */
    });
    return;
  }

  if (mode === "browser-broker") {
    const handle = await startBrokerFromConfig(config);
    registerBrokerShutdown(handle);
    await new Promise<void>(() => {
      /* run until SIGINT/SIGTERM */
    });
    return;
  }

  if (mode === "worker" || mode === "all") {
    await startHttpApi({
      port: config.httpPort,
      dbPath: config.dbPath,
      runLeaseReaper: true,
      reaperIntervalMs: config.reaperIntervalMs,
      workerId: config.workerId,
      workersFile: config.workersFile,
    });
    const worker = await startWorkerFromConfig(config);
    registerShutdown(worker);
    await new Promise<void>(() => {
      /* run until SIGINT/SIGTERM */
    });
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

  console.error(
    `Unknown mode: ${mode}. Use: mcp | status-api | http | worker | browser-worker | browser-broker | remote-mcp | all`
  );
  process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
