import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { initDatabase, getDatabase } from "../db/sqlite.js";
import { TaskRepository } from "../tasks/task.repository.js";

export interface WorkerRegistryEntry {
  id: string;
  workerUrl: string;
  cdpEndpoint: string;
  httpPort?: number;
  /** When false, excluded from broker bind and claim scheduling. Default true. */
  enabled?: boolean;
}

export interface ResolvedTopology {
  workers: WorkerRegistryEntry[];
  source: "db" | "file" | "env-single" | "empty";
  filePath?: string;
  dbPath?: string;
}

/** Default: SQLite worker_state. Set HANDOFF_WORKERS_SOURCE=file or HANDOFF_WORKERS_FILE for legacy JSON. */
export function workersTopologySource(): "db" | "file" {
  const explicit = process.env.HANDOFF_WORKERS_SOURCE?.trim().toLowerCase();
  if (explicit === "file") return "file";
  if (explicit === "db") return "db";
  if (process.env.HANDOFF_WORKERS_FILE?.trim()) return "file";
  return "db";
}

export function loadTopologyFromDatabase(dbPath: string): ResolvedTopology {
  initDatabase(dbPath);
  const repo = new TaskRepository(getDatabase());
  const rows = repo.listWorkers().filter((w) => w.id !== "default");
  const workers: WorkerRegistryEntry[] = [];
  for (const w of rows) {
    const workerUrl = (w.workerUrl ?? "").trim();
    const cdpEndpoint = (w.cdpEndpoint ?? "").trim();
    if (!workerUrl || !cdpEndpoint) continue;
    workers.push({
      id: w.id,
      workerUrl,
      cdpEndpoint,
      httpPort: w.httpPort,
      enabled: w.error !== "DISABLED",
    });
  }
  return {
    source: "db",
    dbPath: resolve(dbPath),
    workers,
  };
}

function isHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value.trim());
}

/**
 * Load optional workers.json and/or synthesize a single-worker topology from env.
 * Env fields for the current process override matching file entry by id.
 */
export function loadWorkersTopology(opts: {
  dbPath?: string;
  workersFile?: string;
  workerId: string;
  workerUrl: string;
  cdpEndpoint: string;
  httpPort?: number;
}): ResolvedTopology {
  const dbPath = opts.dbPath?.trim();
  if (workersTopologySource() === "db" && dbPath) {
    const fromDb = loadTopologyFromDatabase(dbPath);
    if (fromDb.workers.length > 0) {
      const workers = fromDb.workers.map((w) => {
        if (w.id !== opts.workerId) return w;
        return {
          ...w,
          workerUrl: opts.workerUrl || w.workerUrl,
          cdpEndpoint: opts.cdpEndpoint || w.cdpEndpoint,
          httpPort: opts.httpPort ?? w.httpPort,
        };
      });
      return { ...fromDb, workers };
    }
  }

  const filePath =
    opts.workersFile?.trim() ||
    process.env.HANDOFF_WORKERS_FILE?.trim() ||
    "";

  let fromFile: WorkerRegistryEntry[] = [];
  if (filePath) {
    const abs = resolve(filePath);
    if (!existsSync(abs)) {
      throw new Error(`HANDOFF_WORKERS_FILE not found: ${abs}`);
    }
    const raw = JSON.parse(readFileSync(abs, "utf-8")) as unknown;
    if (!Array.isArray(raw)) {
      throw new Error("workers.json must be a JSON array");
    }
    fromFile = raw.map((row, i) => {
      const r = row as Record<string, unknown>;
      const id = String(r.id ?? "").trim();
      const workerUrl = String(r.workerUrl ?? r.worker_url ?? "").trim();
      const cdpEndpoint = String(
        r.cdpEndpoint ?? r.cdp_endpoint ?? ""
      ).trim();
      const httpPort =
        r.httpPort !== undefined
          ? Number(r.httpPort)
          : r.http_port !== undefined
            ? Number(r.http_port)
            : undefined;
      const enabled =
        r.enabled === undefined
          ? true
          : r.enabled === true || r.enabled === "true";
      if (!id || !workerUrl || !cdpEndpoint) {
        throw new Error(
          `workers.json[${i}] requires id, workerUrl, cdpEndpoint`
        );
      }
      return { id, workerUrl, cdpEndpoint, httpPort, enabled };
    });
  }

  if (fromFile.length === 0) {
    if (opts.workerUrl) {
      return {
        source: "env-single",
        workers: [
          {
            id: opts.workerId,
            workerUrl: opts.workerUrl,
            cdpEndpoint: opts.cdpEndpoint,
            httpPort: opts.httpPort,
          },
        ],
      };
    }
    return { source: "empty", workers: [] };
  }

  // Overlay current process env onto matching id.
  const workers = fromFile.map((w) => {
    if (w.id !== opts.workerId) return w;
    return {
      ...w,
      workerUrl: opts.workerUrl || w.workerUrl,
      cdpEndpoint: opts.cdpEndpoint || w.cdpEndpoint,
      httpPort: opts.httpPort ?? w.httpPort,
    };
  });

  if (!workers.some((w) => w.id === opts.workerId) && opts.workerUrl) {
    // Only synthesize when there is no registry file; dual topology must list every id.
    if (fromFile.length === 0) {
      workers.push({
        id: opts.workerId,
        workerUrl: opts.workerUrl,
        cdpEndpoint: opts.cdpEndpoint,
        httpPort: opts.httpPort,
      });
    }
  }

  return {
    source: "file",
    filePath: resolve(filePath),
    workers,
  };
}

export function validateWorkersTopology(
  topology: ResolvedTopology,
  opts?: { allowSharedCdp?: boolean }
): void {
  const { workers } = topology;
  if (workers.length === 0) return;

  const ids = new Set<string>();
  const urls = new Set<string>();
  const cdps = new Set<string>();
  const ports = new Set<number>();

  for (const w of workers) {
    if (ids.has(w.id)) {
      throw new Error(`Duplicate worker id in topology: ${w.id}`);
    }
    ids.add(w.id);

    if (!isHttpUrl(w.workerUrl)) {
      throw new Error(`Invalid workerUrl for ${w.id}`);
    }
    if (urls.has(w.workerUrl)) {
      throw new Error(`Duplicate ChatGPT workerUrl in topology: ${w.workerUrl}`);
    }
    urls.add(w.workerUrl);

    if (!isHttpUrl(w.cdpEndpoint)) {
      throw new Error(`Invalid cdpEndpoint for ${w.id}`);
    }
    cdps.add(w.cdpEndpoint);

    if (w.httpPort !== undefined && w.httpPort !== null) {
      if (ports.has(w.httpPort)) {
        throw new Error(`Duplicate httpPort in topology: ${w.httpPort}`);
      }
      ports.add(w.httpPort);
    }
  }

  if (opts?.allowSharedCdp) {
    // A1-S broker: all logical workers must share exactly one CDP endpoint.
    if (cdps.size !== 1) {
      throw new Error(
        `broker mode requires a single shared cdpEndpoint (got ${cdps.size}: ${[...cdps].join(", ")})`
      );
    }
  } else if (cdps.size !== workers.length) {
    throw new Error(
      `Duplicate cdpEndpoint in topology (0.2.0 requires separate Chrome profiles; use browser-broker / allowSharedCdp for A1-S)`
    );
  }
}
