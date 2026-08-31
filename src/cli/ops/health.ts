import { existsSync } from "node:fs";
import { initDatabase, getDatabase } from "../../db/sqlite.js";
import { resolveWorkersFilePath } from "../../config/load-config.js";
import type { AppConfig } from "../../config/load-config.js";
import { loadWorkersTopology } from "../../config/workers-topology.js";
import { statusBaseUrl, remoteMcpUrl } from "../context.js";

export type ServiceState = "healthy" | "degraded" | "down" | "unknown";

export interface SystemSnapshot {
  statusApi: ServiceState;
  remoteMcp: ServiceState;
  broker: ServiceState;
  chromeCdp: ServiceState;
  overall: ServiceState;
  workers: WorkerSnapshot[];
  queue: QueueSnapshot;
  brokerBindings: number;
  registryWorkerIds: string[];
  ports: {
    http: number;
    remoteMcp: number;
    brokerOps: number;
    cdp: string;
  };
  dashboardUrl: string;
  running: boolean;
}

export interface WorkerSnapshot {
  id: string;
  status: string;
  healthState?: string;
  healthy: boolean;
  enabled?: boolean;
  detail?: string;
  readinessReason?: string | null;
  recommendedAction?: string;
}

export interface QueueSnapshot {
  queued: number;
  dispatching: number;
  failed: number;
  open: number;
}

async function fetchJson<T>(url: string, timeoutMs = 3000): Promise<T | null> {
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

export async function probeCdp(cdpEndpoint: string): Promise<boolean> {
  try {
    const res = await fetch(`${cdpEndpoint.replace(/\/$/, "")}/json/version`, {
      signal: AbortSignal.timeout(2000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export async function probeRemoteMcp(config: AppConfig): Promise<boolean> {
  try {
    const res = await fetch(remoteMcpUrl(config), {
      method: "GET",
      signal: AbortSignal.timeout(2000),
    });
    return res.status > 0;
  } catch {
    return false;
  }
}

function queueCounts(dbPath: string): QueueSnapshot {
  if (!existsSync(dbPath)) {
    return { queued: 0, dispatching: 0, failed: 0, open: 0 };
  }
  initDatabase(dbPath);
  const db = getDatabase();
  const row = (sql: string) =>
    (db.prepare(sql).get() as { n: number } | undefined)?.n ?? 0;
  return {
    queued: row(`SELECT COUNT(*) AS n FROM handoff_tasks WHERE status = 'QUEUED'`),
    dispatching: row(
      `SELECT COUNT(*) AS n FROM handoff_tasks WHERE status = 'DISPATCHING'`
    ),
    failed: row(
      `SELECT COUNT(*) AS n FROM handoff_tasks WHERE status = 'FAILED'`
    ),
    open: row(
      `SELECT COUNT(*) AS n FROM handoff_tasks WHERE status IN ('QUEUED','DISPATCHING','DISPATCHED','PROCESSING','WAITING_APPROVAL')`
    ),
  };
}

function deriveOverall(parts: ServiceState[]): ServiceState {
  if (parts.every((p) => p === "healthy")) return "healthy";
  if (parts.every((p) => p === "down")) return "down";
  if (parts.some((p) => p === "down")) return "degraded";
  if (parts.some((p) => p === "degraded")) return "degraded";
  return "unknown";
}

function workerIsReady(w: {
  id: string;
  healthState?: string;
  status?: string;
}): boolean {
  return w.healthState === "READY";
}

export function filterRegistryWorkers(
  workers: WorkerSnapshot[],
  registryIds: string[]
): WorkerSnapshot[] {
  const ids = new Set(registryIds);
  return workers.filter((w) => ids.has(w.id));
}

export async function collectSystemSnapshot(
  config: AppConfig,
  brokerOpsPort: number
): Promise<SystemSnapshot> {
  const base = statusBaseUrl(config);
  const workersFile = resolveWorkersFilePath(config.workersFile);
  let registryWorkerIds: string[] = [];
  try {
    const topo = loadWorkersTopology({
      dbPath: config.dbPath,
      workersFile: config.workersFile,
      workerId: config.workerId,
      workerUrl: "",
      cdpEndpoint: config.cdpEndpoint,
    });
    registryWorkerIds = topo.workers.map((w) => w.id);
  } catch {
    registryWorkerIds = [];
  }

  const health = await fetchJson<{ ok?: boolean }>(`${base}/health`);
  const statusApi: ServiceState = health?.ok ? "healthy" : "down";

  const brokerStatus = await fetchJson<{
    healthy?: boolean;
    bindings?: unknown[];
    registryWorkerIds?: string[];
  }>(`${base}/broker/status`);
  let broker: ServiceState = "down";
  if (brokerStatus?.healthy) broker = "healthy";
  else if (brokerStatus) broker = "degraded";
  const brokerBindings = brokerStatus?.bindings?.length ?? 0;
  if (brokerStatus?.registryWorkerIds?.length) {
    registryWorkerIds = brokerStatus.registryWorkerIds;
  }

  const remoteOk = await probeRemoteMcp(config);
  const remoteMcp: ServiceState = remoteOk ? "healthy" : "down";

  const cdpOk = await probeCdp(config.cdpEndpoint);
  const chromeCdp: ServiceState = cdpOk ? "healthy" : "down";

  const workersHealth = await fetchJson<{
    workers?: Array<{
      id: string;
      status: string;
      healthState?: string;
      healthy?: boolean;
      enabled?: boolean;
      readinessReason?: string | null;
      recommendedAction?: string;
    }>;
  }>(`${base}/workers/health`);

  let workers: WorkerSnapshot[] = [];
  if (workersHealth?.workers?.length) {
    workers = workersHealth.workers.map((w) => ({
      id: w.id,
      status: w.status,
      healthState: w.healthState,
      healthy: w.healthState === "READY" || (w.healthy ?? false),
      enabled: w.enabled !== false,
      readinessReason: w.readinessReason ?? null,
      recommendedAction: w.recommendedAction,
      detail:
        w.healthState && w.healthState !== "READY"
          ? w.healthState
          : w.status,
    }));
  } else {
    const plain = await fetchJson<{
      workers?: Array<{
        id: string;
        status: string;
        healthy?: boolean;
      }>;
    }>(`${base}/workers`);
    workers =
      plain?.workers?.map((w) => ({
        id: w.id,
        status: w.status,
        healthy: Boolean(w.healthy) || w.status === "READY",
        detail: w.status,
      })) ?? [];
  }

  const workerStates = workers.map((w) =>
    workerIsReady(w) ? "healthy" : "down"
  ) as ServiceState[];

  const overall = deriveOverall([
    statusApi,
    remoteMcp,
    broker,
    chromeCdp,
    ...(workerStates.length ? workerStates : (["unknown"] as ServiceState[])),
  ]);

  const running =
    statusApi !== "down" || remoteMcp !== "down" || broker !== "down";

  return {
    statusApi,
    remoteMcp,
    broker,
    chromeCdp,
    overall,
    workers,
    queue: queueCounts(config.dbPath),
    brokerBindings,
    registryWorkerIds,
    ports: {
      http: config.httpPort,
      remoteMcp: config.remoteMcpPort,
      brokerOps: brokerOpsPort,
      cdp: config.cdpEndpoint,
    },
    dashboardUrl: `${base}/dashboard/`,
    running,
  };
}

export function serviceLabel(state: ServiceState): string {
  switch (state) {
    case "healthy":
      return "healthy";
    case "degraded":
      return "degraded";
    case "down":
      return "down";
    default:
      return "unknown";
  }
}
