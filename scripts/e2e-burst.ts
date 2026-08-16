#!/usr/bin/env npx tsx
/**
 * Burst canary: enqueue N tasks at once, measure wall-clock to all COMPLETED.
 *
 *   npx tsx scripts/e2e-burst.ts --n=4
 */
import { config as loadEnv } from "dotenv";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { initDatabase, getDatabase, closeDatabase } from "../src/db/sqlite.js";
import { TaskRepository } from "../src/tasks/task.repository.js";
import { TaskService } from "../src/tasks/task.service.js";
import { loadConfig } from "../src/config/load-config.js";

loadEnv({ path: resolve(process.cwd(), ".env") });

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function canaryToken(): string {
  return `burst-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
}

function shortHash(s: string): string {
  return createHash("sha256").update(s).digest("hex").slice(0, 10);
}

function argN(): number {
  const hit = process.argv.find((a) => a.startsWith("--n="));
  return Number(hit?.slice(4) ?? process.env.E2E_BURST_N ?? 4);
}

function buildPrompt(canary: string): string {
  return [
    "This is an automated burst canary for chatgpt-mcp.",
    "Do the following and nothing else:",
    "1. If needed, call handoff_get_task with the TASK_ID from the chat message.",
    "2. Immediately call handoff_submit_result with:",
    `   - result: exactly one line: BURST_CANARY=${canary}`,
    '   - metadata.summary: "burst canary ok"',
    '   - metadata.confidence: "high"',
    "3. Do not put any other text in the result string. Exact match required.",
  ].join("\n");
}

async function main(): Promise<void> {
  const n = argN();
  const config = loadConfig();
  const timeoutMs = Number(process.env.E2E_BURST_TIMEOUT_MS ?? 600_000);
  const t0 = Date.now();

  initDatabase(config.dbPath);
  const repo = new TaskRepository(getDatabase());
  const taskService = new TaskService(repo);

  const httpBase = `http://127.0.0.1:${config.httpPort}`;
  const health = await fetch(`${httpBase}/health`).then((r) => r.json()) as {
    ok?: boolean;
  };
  if (!health.ok) throw new Error("/health not ok");

  const workersBody = (await fetch(`${httpBase}/workers`).then((r) =>
    r.json()
  )) as {
    workers: Array<{ id: string; healthy?: boolean; status: string }>;
  };
  const live = workersBody.workers.filter(
    (w) =>
      w.id !== "default" &&
      w.healthy !== false &&
      (w.status === "READY" || w.status === "BUSY")
  );

  console.log(
    JSON.stringify({
      event: "E2E_BURST_START",
      n,
      liveWorkers: live.map((w) => w.id),
      timeoutMs,
      t0Iso: new Date(t0).toISOString(),
    })
  );

  const created = Array.from({ length: n }, (_, i) => {
    const canary = canaryToken();
    const { taskId } = taskService.createTask({
      type: "research",
      prompt: buildPrompt(canary),
      cursorConversationId: `e2e-burst-${t0}-${i}`,
    });
    return { taskId, canary, i };
  });

  const createdAt = Date.now();
  console.log(
    JSON.stringify({
      event: "E2E_BURST_CREATED",
      elapsedMs: createdAt - t0,
      tasks: created.map((t) => ({
        i: t.i,
        suffix: t.taskId.slice(-10),
        canaryHash: shortHash(t.canary),
      })),
    })
  );

  const owners = new Map<string, string>();
  const firstClaimAt = new Map<string, number>();
  const completedAt = new Map<string, number>();
  const terminal = new Map<string, string>();
  const deadline = t0 + timeoutMs;

  while (Date.now() < deadline) {
    for (const t of created) {
      const row = repo.getTaskById(t.taskId);
      if (!row) continue;
      if (row.leaseOwner && !owners.has(t.taskId)) {
        owners.set(t.taskId, row.leaseOwner);
        firstClaimAt.set(t.taskId, Date.now());
        console.log(
          JSON.stringify({
            event: "E2E_BURST_CLAIMED",
            i: t.i,
            suffix: t.taskId.slice(-10),
            leaseOwner: row.leaseOwner,
            status: row.status,
            elapsedMs: Date.now() - t0,
          })
        );
      }
      if (
        (row.status === "COMPLETED" ||
          row.status === "FAILED" ||
          row.status === "TIMED_OUT") &&
        !terminal.has(t.taskId)
      ) {
        terminal.set(t.taskId, row.status);
        completedAt.set(t.taskId, Date.now());
        console.log(
          JSON.stringify({
            event: "E2E_BURST_TERMINAL",
            i: t.i,
            suffix: t.taskId.slice(-10),
            status: row.status,
            leaseOwner: owners.get(t.taskId) ?? row.leaseOwner ?? null,
            elapsedMs: Date.now() - t0,
          })
        );
      }
    }
    if (terminal.size === n) break;
    await sleep(500);
  }

  const tEnd = Date.now();
  const results = created.map((t) => {
    const row = repo.getTaskById(t.taskId)!;
    const expected = `BURST_CANARY=${t.canary}`;
    const ok =
      row.status === "COMPLETED" && (row.result ?? "").trim() === expected;
    return {
      i: t.i,
      suffix: t.taskId.slice(-10),
      status: row.status,
      owner: owners.get(t.taskId) ?? row.leaseOwner ?? null,
      claimMs: firstClaimAt.has(t.taskId)
        ? firstClaimAt.get(t.taskId)! - t0
        : null,
      doneMs: completedAt.has(t.taskId)
        ? completedAt.get(t.taskId)! - t0
        : null,
      canaryOk: ok,
      error: row.error ?? null,
    };
  });

  const allOk = results.every((r) => r.canaryOk);
  const summary = {
    event: "E2E_BURST_DONE",
    ok: allOk,
    n,
    liveWorkersAtStart: live.map((w) => w.id),
    uniqueOwners: [...new Set(results.map((r) => r.owner).filter(Boolean))],
    elapsedMs: tEnd - t0,
    elapsedSec: Number(((tEnd - t0) / 1000).toFixed(2)),
    createMs: createdAt - t0,
    results,
  };
  console.log(JSON.stringify(summary, null, 2));

  mkdirSync(resolve("logs/e2e"), { recursive: true });
  const out = resolve(
    "logs/e2e",
    `burst-${n}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`
  );
  writeFileSync(out, JSON.stringify(summary, null, 2));
  console.log(JSON.stringify({ event: "E2E_BURST_WRITTEN", path: out }));

  closeDatabase();
  if (!allOk) process.exit(1);
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
