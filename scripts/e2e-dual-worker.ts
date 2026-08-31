/**
 * Dual-worker live E2E: two QUEUED tasks claimed by different lease_owners,
 * both COMPLETED with correct canaries.
 *
 * Prerequisites:
 *   - CDP Chrome on each workers.json cdpEndpoint (logged into ChatGPT)
 *   - Dual stack: ./scripts/start-dual-stack.sh
 *   - Shared remote-mcp + status-api
 *
 *   npx tsx scripts/e2e-dual-worker.ts
 */
import { config as loadEnv } from "dotenv";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { initDatabase, getDatabase, closeDatabase } from "../src/db/sqlite.js";
import { TaskRepository } from "../src/tasks/task.repository.js";
import { TaskService } from "../src/tasks/task.service.js";
import { loadConfig } from "../src/config/load-config.js";
import {
  loadWorkersTopology,
  validateWorkersTopology,
} from "../src/config/workers-topology.js";

loadEnv({ path: resolve(process.cwd(), ".env") });

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function canaryToken(): string {
  return `dual-${Date.now().toString(36)}-${randomBytes(4).toString("hex")}`;
}

function shortHash(s: string): string {
  return createHash("sha256").update(s).digest("hex").slice(0, 10);
}

async function httpJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return (await res.json()) as T;
}

function buildPrompt(canary: string): string {
  return [
    "This is an automated dual-worker reliability canary for chatgpt-mcp.",
    "Do the following and nothing else:",
    "1. If needed, call handoff_get_task with the TASK_ID from the chat message.",
    "2. Immediately call handoff_submit_result with:",
    `   - result: exactly one line: DUAL_CANARY=${canary}`,
    '   - metadata.summary: "dual canary ok"',
    '   - metadata.confidence: "high"',
    "3. Do not put any other text in the result string. Exact match required.",
  ].join("\n");
}

async function main(): Promise<void> {
  const config = loadConfig();
  const workersFile = process.env.HANDOFF_WORKERS_FILE?.trim() || undefined;

  const topology = loadWorkersTopology({
    dbPath: config.dbPath,
    workersFile,
    workerId: "w1",
    workerUrl: "",
    cdpEndpoint: config.cdpEndpoint,
  });
  validateWorkersTopology(topology, {
    allowSharedCdp: process.env.HANDOFF_A1S === "1",
  });
  if (topology.workers.length < 2) {
    throw new Error(
      `Need ≥2 workers in registry (got ${topology.workers.length})`
    );
  }

  const httpBase = `http://127.0.0.1:${config.httpPort}`;
  const timeoutMs = Number(process.env.E2E_DUAL_TIMEOUT_MS ?? 480_000);
  const pollMs = 1000;

  console.log(
    JSON.stringify({
      event: "E2E_DUAL_START",
      workersSource: workersFile ? "file" : "db",
      workers: topology.workers.map((w) => ({
        id: w.id,
        cdp: w.cdpEndpoint,
        url: w.workerUrl.slice(0, 48),
      })),
      httpBase,
      timeoutMs,
    })
  );

  const health = await httpJson<{ ok?: boolean }>(`${httpBase}/health`);
  if (!health.ok) throw new Error("/health not ok");

  for (const w of topology.workers) {
    const cdp = await fetch(`${w.cdpEndpoint.replace(/\/$/, "")}/json/version`);
    if (!cdp.ok) throw new Error(`CDP down: ${w.cdpEndpoint}`);
  }

  // Wait until ≥2 READY/BUSY workers are registered
  {
    const deadline = Date.now() + 60_000;
    for (;;) {
      const body = await httpJson<{
        workers: Array<{ id: string; status: string; healthy?: boolean }>;
      }>(`${httpBase}/workers`);
      const live = body.workers.filter(
        (w) =>
          (w.status === "READY" || w.status === "BUSY") && w.healthy !== false
      );
      if (live.length >= 2) {
        console.log(
          JSON.stringify({
            event: "E2E_DUAL_WORKERS_READY",
            workers: body.workers,
          })
        );
        break;
      }
      if (Date.now() > deadline) {
        throw new Error(
          `Need 2 live workers; got ${JSON.stringify(body.workers)}`
        );
      }
      await sleep(1000);
    }
  }

  initDatabase(config.dbPath);
  const repo = new TaskRepository(getDatabase());
  const taskService = new TaskService(repo);

  const canaries = [canaryToken(), canaryToken()];
  const created = canaries.map((canary, i) => {
    const { taskId } = taskService.createTask({
      type: "research",
      prompt: buildPrompt(canary),
      cursorConversationId: `e2e-dual-${Date.now()}-${i}`,
    });
    return { taskId, canary };
  });

  console.log(
    JSON.stringify({
      event: "E2E_DUAL_CREATED",
      tasks: created.map((t) => ({
        suffix: t.taskId.slice(-10),
        canaryHash: shortHash(t.canary),
      })),
    })
  );

  const owners = new Map<string, string>();
  const done = new Map<string, string>();
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    for (const t of created) {
      const row = repo.getTaskById(t.taskId);
      if (!row) continue;
      if (row.leaseOwner && !owners.has(t.taskId)) {
        owners.set(t.taskId, row.leaseOwner);
        console.log(
          JSON.stringify({
            event: "E2E_DUAL_CLAIMED",
            suffix: t.taskId.slice(-10),
            leaseOwner: row.leaseOwner,
            status: row.status,
          })
        );
      }
      if (
        row.status === "COMPLETED" ||
        row.status === "FAILED" ||
        row.status === "TIMED_OUT"
      ) {
        done.set(t.taskId, row.status);
      }
    }

    if (owners.size === 2) {
      const uniq = new Set(owners.values());
      if (uniq.size < 2) {
        throw new Error(
          `Both tasks claimed by same worker: ${[...owners.entries()]}`
        );
      }
    }

    if (done.size === 2) break;
    await sleep(pollMs);
  }

  if (done.size < 2) {
    throw new Error(
      `Timeout waiting for 2 terminal tasks. owners=${JSON.stringify([
        ...owners,
      ])} done=${JSON.stringify([...done])}`
    );
  }

  for (const t of created) {
    const row = repo.getTaskById(t.taskId)!;
    if (row.status === "FAILED" || row.status === "TIMED_OUT") {
      throw new Error(
        `${t.taskId} ${row.status}: ${row.error ?? "(no error)"} ownerSeen=${owners.get(t.taskId) ?? "-"}`
      );
    }
  }

  const ownerList = [...owners.values()];
  const uniqueOwners = new Set(ownerList);
  if (uniqueOwners.size < 2) {
    throw new Error(
      `Expected 2 distinct lease owners, got ${JSON.stringify(ownerList)}. ` +
        `done=${JSON.stringify([...done])}`
    );
  }

  for (const t of created) {
    const row = repo.getTaskById(t.taskId)!;
    if (row.status !== "COMPLETED") {
      throw new Error(`${t.taskId} status=${row.status} error=${row.error}`);
    }
    const expected = `DUAL_CANARY=${t.canary}`;
    if ((row.result ?? "").trim() !== expected) {
      throw new Error(
        `${t.taskId} bad result: got=${JSON.stringify(row.result)} want=${expected}`
      );
    }
  }

  const summary = {
    event: "E2E_DUAL_DONE",
    ok: true,
    owners: Object.fromEntries(
      created.map((t) => [t.taskId.slice(-10), owners.get(t.taskId)])
    ),
    canaryHashes: created.map((t) => shortHash(t.canary)),
  };
  console.log(JSON.stringify(summary));

  mkdirSync(resolve("logs/e2e"), { recursive: true });
  const out = resolve(
    "logs/e2e",
    `dual-worker-${new Date().toISOString().replace(/[:.]/g, "-")}.json`
  );
  writeFileSync(out, JSON.stringify(summary, null, 2));
  console.log(JSON.stringify({ event: "E2E_DUAL_WRITTEN", path: out }));

  closeDatabase();
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : err);
  try {
    closeDatabase();
  } catch {
    /* ignore */
  }
  process.exit(1);
});
