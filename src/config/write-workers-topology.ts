import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  type ResolvedTopology,
  type WorkerRegistryEntry,
  validateWorkersTopology,
} from "./workers-topology.js";

export function topologyAllowsSharedCdp(topology: ResolvedTopology): boolean {
  const cdps = new Set(topology.workers.map((w) => w.cdpEndpoint));
  return topology.workers.length >= 2 && cdps.size === 1;
}

/** Suggest next worker id: w1, w2, … skipping used ids. */
export function nextWorkerId(existing: WorkerRegistryEntry[]): string {
  const used = new Set(existing.map((w) => w.id));
  for (let i = 1; i < 10_000; i++) {
    const id = `w${i}`;
    if (!used.has(id)) return id;
  }
  throw new Error("Could not allocate worker id");
}

export function withWorkersFileLock<T>(filePath: string, fn: () => T): T {
  const abs = resolve(filePath);
  mkdirSync(dirname(abs), { recursive: true });
  const lockPath = `${abs}.lock`;
  try {
    writeFileSync(lockPath, `${process.pid}\n`, { flag: "wx" });
  } catch {
    throw new Error(
      `Workers file is locked (${lockPath}). Another rotate/create-worker may be in progress.`
    );
  }
  try {
    return fn();
  } finally {
    try {
      unlinkSync(lockPath);
    } catch {
      // ignore
    }
  }
}

/**
 * Atomically append (or replace-by-id) a worker entry in workers.json.
 * Validates topology before commit (A1-S: allowSharedCdp when all CDPs match).
 */
export function upsertWorkerRegistryEntry(opts: {
  filePath: string;
  entry: WorkerRegistryEntry;
  /** Replace existing id instead of throwing. */
  replace?: boolean;
}): { workers: WorkerRegistryEntry[]; filePath: string } {
  return withWorkersFileLock(opts.filePath, () =>
    upsertWorkerRegistryEntryUnlocked(opts)
  );
}

function upsertWorkerRegistryEntryUnlocked(opts: {
  filePath: string;
  entry: WorkerRegistryEntry;
  replace?: boolean;
}): { workers: WorkerRegistryEntry[]; filePath: string } {
  const abs = resolve(opts.filePath);
  mkdirSync(dirname(abs), { recursive: true });

  let workers: WorkerRegistryEntry[] = [];
  if (existsSync(abs)) {
    const raw = JSON.parse(readFileSync(abs, "utf-8")) as unknown;
    if (!Array.isArray(raw)) {
      throw new Error(`${abs} must be a JSON array`);
    }
    workers = raw.map((row, i) => {
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
        throw new Error(`${abs}[${i}] requires id, workerUrl, cdpEndpoint`);
      }
      return { id, workerUrl, cdpEndpoint, httpPort, enabled };
    });
  }

  const idx = workers.findIndex((w) => w.id === opts.entry.id);
  if (idx >= 0) {
    if (!opts.replace) {
      throw new Error(
        `Worker id already exists: ${opts.entry.id} (pass --replace to overwrite)`
      );
    }
    workers[idx] = { ...opts.entry };
  } else {
    workers.push({ ...opts.entry });
  }

  const topology: ResolvedTopology = {
    source: "file",
    filePath: abs,
    workers,
  };
  validateWorkersTopology(topology, {
    allowSharedCdp: topologyAllowsSharedCdp(topology),
  });

  const tmp = `${abs}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(workers, null, 2)}\n`, "utf-8");
  renameSync(tmp, abs);
  return { workers, filePath: abs };
}
