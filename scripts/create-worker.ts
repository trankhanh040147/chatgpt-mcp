#!/usr/bin/env npx tsx
/**
 * Thin adapter — logic lives in src/ops/create-worker.ts
 *
 *   npx tsx scripts/create-worker.ts
 *   npx tsx scripts/create-worker.ts --id=w3 --workers-file=~/.chatgpt-mcp/data/workers.json
 */
import { config as loadEnv } from "dotenv";
import { resolve } from "node:path";
import { runCreateWorker } from "../src/ops/create-worker.js";

loadEnv({ path: resolve(process.cwd(), ".env") });

function argValue(name: string): string | undefined {
  const prefix = `--${name}=`;
  const hit = process.argv.find((a) => a.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : undefined;
}

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

runCreateWorker({
  yes: hasFlag("yes"),
  skipCanary: hasFlag("skip-canary"),
  replace: hasFlag("replace"),
  workersFile: argValue("workers-file"),
  cdpEndpoint: argValue("cdp"),
  workerUrl: argValue("worker-url"),
  id: argValue("id"),
})
  .then((r) => {
    process.exit(r.ok ? 0 : 1);
  })
  .catch((err) => {
    console.error(err instanceof Error ? err.stack ?? err.message : err);
    process.exit(1);
  });
