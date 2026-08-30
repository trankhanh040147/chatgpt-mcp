#!/usr/bin/env npx tsx
/**
 * Thin adapter — logic lives in src/ops/rotate-worker-cli.ts
 *
 *   npm run rotate-worker -- --id=w2
 */
import { config as loadEnv } from "dotenv";
import { resolve } from "node:path";
import { runRotateWorker } from "../src/ops/rotate-worker-cli.js";

loadEnv({ path: resolve(process.cwd(), ".env") });

function argValue(name: string): string | undefined {
  const prefix = `--${name}=`;
  const hit = process.argv.find((a) => a.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : undefined;
}

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

const workerId = argValue("id");
if (!workerId) {
  console.error("rotate-worker: required --id=wN");
  process.exit(1);
}

runRotateWorker({
  workerId,
  workersFile: argValue("workers-file"),
  workerUrl: argValue("worker-url"),
  yes: hasFlag("yes"),
  assumeConsent: hasFlag("assume-consent"),
})
  .then((r) => {
    process.exit(r.ok ? 0 : 1);
  })
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
