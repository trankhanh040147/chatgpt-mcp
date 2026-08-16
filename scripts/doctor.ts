#!/usr/bin/env npx tsx
/**
 * Validate multi-worker topology + local control plane health.
 *   npm run doctor
 */
import { config as loadEnv } from "dotenv";
import { join } from "node:path";
import { loadConfig } from "../src/config/load-config.js";
import {
  loadWorkersTopology,
  validateWorkersTopology,
} from "../src/config/workers-topology.js";
import { topologyAllowsSharedCdp } from "../src/config/write-workers-topology.js";
import { initDatabase, getDatabase, SCHEMA_USER_VERSION } from "../src/db/sqlite.js";
import { TaskRepository } from "../src/tasks/task.repository.js";

loadEnv({ path: join(process.cwd(), ".env") });

async function main(): Promise<void> {
  const config = loadConfig();
  const errors: string[] = [];

  console.log("doctor:");
  console.log(`  dbPath: ${config.dbPath}`);
  console.log(`  workerId: ${config.workerId}`);
  console.log(`  httpPort: ${config.httpPort}`);
  console.log(`  leaseMs: ${config.leaseMs}`);

  try {
    const topology = loadWorkersTopology({
      workersFile: config.workersFile || process.env.HANDOFF_WORKERS_FILE,
      workerId: config.workerId,
      workerUrl: config.workersFile || process.env.HANDOFF_WORKERS_FILE
        ? ""
        : config.workerUrl,
      cdpEndpoint: config.workersFile || process.env.HANDOFF_WORKERS_FILE
        ? ""
        : config.cdpEndpoint,
      // Do not stamp status-api port onto browser topology entries.
      httpPort: undefined,
    });
    const allowSharedCdp = topologyAllowsSharedCdp(topology);
    validateWorkersTopology(topology, { allowSharedCdp });
    console.log(
      `  topology: source=${topology.source} workers=${topology.workers.length} sharedCdp=${allowSharedCdp}`
    );
    for (const w of topology.workers) {
      console.log(
        `    - ${w.id} cdp=${w.cdpEndpoint} url=${w.workerUrl.slice(0, 48)}…`
      );
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    errors.push(`topology: ${message}`);
  }

  try {
    initDatabase(config.dbPath);
    const ver = getDatabase().prepare("PRAGMA user_version").get() as {
      user_version: number;
    };
    console.log(`  schema user_version: ${ver.user_version} (want ${SCHEMA_USER_VERSION})`);
    if (Number(ver.user_version) !== SCHEMA_USER_VERSION) {
      errors.push(`schema version mismatch`);
    }
    const repo = new TaskRepository(getDatabase());
    const workers = repo.listWorkers();
    console.log(`  worker_state rows: ${workers.length}`);
    for (const w of workers) {
      console.log(
        `    - ${w.id} status=${w.status} task=${w.currentTaskId ?? "-"} seen=${w.lastSeenAt ?? "-"}`
      );
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    errors.push(`db: ${message}`);
  }

  try {
    const res = await fetch(`http://127.0.0.1:${config.httpPort}/health`);
    const body = (await res.json()) as { ok?: boolean; lastReapAt?: string };
    console.log(
      `  status-api: ok=${body.ok} lastReapAt=${body.lastReapAt ?? "null"}`
    );
    if (!body.ok) errors.push("status-api health not ok");
  } catch {
    errors.push(`status-api not reachable on :${config.httpPort}`);
  }

  if (errors.length) {
    console.error("\nFAIL:");
    for (const e of errors) console.error(`  - ${e}`);
    process.exit(1);
  }
  console.log("\nPASS");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
