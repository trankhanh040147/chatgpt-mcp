#!/usr/bin/env npx tsx
/**
 * Backfill task_usage for COMPLETED tasks missing estimates.
 *
 *   npm run usage:backfill
 *   npm run usage:backfill -- --replace
 */
import { config as loadEnv } from "dotenv";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { initDatabase, getDatabase } from "../src/db/sqlite.js";
import { estimateTaskUsage, loadCostConfig } from "../src/usage/pricing.js";
import {
  getTaskUsage,
  insertTaskUsage,
} from "../src/usage/task-usage.repository.js";

const repoRoot = process.cwd();
loadEnv({ path: join(repoRoot, ".env") });

function resolveUserPath(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed === "~") return homedir();
  if (trimmed.startsWith("~/")) return resolve(join(homedir(), trimmed.slice(2)));
  return resolve(trimmed);
}

function defaultDbPath(): string {
  const home = resolveUserPath(
    process.env.CHATGPT_MCP_HOME?.trim() || join(homedir(), ".chatgpt-mcp")
  );
  return resolveUserPath(
    process.env.HANDOFF_DB_PATH?.trim() || join(home, "data", "handoff.sqlite")
  );
}

const replace = process.argv.includes("--replace");
const db = initDatabase(defaultDbPath());
const cfg = loadCostConfig();

const rows = db
  .prepare(
    `SELECT id, prompt, result FROM handoff_tasks
     WHERE status = 'COMPLETED' AND result IS NOT NULL`
  )
  .all() as Array<{ id: string; prompt: string; result: string }>;

let written = 0;
let skipped = 0;
let failed = 0;

for (const row of rows) {
  if (!replace && getTaskUsage(db, row.id)) {
    skipped += 1;
    continue;
  }
  try {
    const snap = estimateTaskUsage(row.prompt, row.result ?? "", cfg);
    insertTaskUsage(db, row.id, snap, replace);
    written += 1;
  } catch (err) {
    failed += 1;
    console.error(
      `fail ${row.id}:`,
      err instanceof Error ? err.message : String(err)
    );
  }
}

console.log("usage:backfill");
console.log(`  model: ${cfg.modelKey} (${cfg.priceTableVersion})`);
console.log(`  candidates: ${rows.length}`);
console.log(`  written: ${written}`);
console.log(`  skipped: ${skipped}`);
console.log(`  failed: ${failed}`);
console.log(`  replace: ${replace}`);
