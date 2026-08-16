#!/usr/bin/env npx tsx
/**
 * Unit tests for workers.json writer (no browser).
 *   npx tsx scripts/test-create-worker-registry.ts
 */
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  nextWorkerId,
  topologyAllowsSharedCdp,
  upsertWorkerRegistryEntry,
} from "../src/config/write-workers-topology.js";
import type { ResolvedTopology } from "../src/config/workers-topology.js";

let passed = 0;
let failed = 0;

function assert(cond: unknown, msg: string): void {
  if (!cond) {
    failed += 1;
    console.error(`FAIL: ${msg}`);
  } else {
    passed += 1;
    console.log(`ok — ${msg}`);
  }
}

function main(): void {
  const dir = mkdtempSync(join(tmpdir(), "cw-reg-"));
  const file = join(dir, "workers.json");

  assert(nextWorkerId([]) === "w1", "nextWorkerId empty → w1");
  assert(
    nextWorkerId([
      {
        id: "w1",
        workerUrl: "https://chatgpt.com/c/a",
        cdpEndpoint: "http://127.0.0.1:9222",
      },
    ]) === "w2",
    "nextWorkerId skips w1"
  );

  const a = upsertWorkerRegistryEntry({
    filePath: file,
    entry: {
      id: "w1",
      workerUrl: "https://chatgpt.com/c/aaa",
      cdpEndpoint: "http://127.0.0.1:9222",
    },
  });
  assert(a.workers.length === 1, "first upsert writes one worker");

  const b = upsertWorkerRegistryEntry({
    filePath: file,
    entry: {
      id: "w2",
      workerUrl: "https://chatgpt.com/c/bbb",
      cdpEndpoint: "http://127.0.0.1:9222",
    },
  });
  assert(b.workers.length === 2, "second upsert appends");
  const topo: ResolvedTopology = {
    source: "file",
    filePath: file,
    workers: b.workers,
  };
  assert(topologyAllowsSharedCdp(topo), "shared CDP detected");

  let threw = false;
  try {
    upsertWorkerRegistryEntry({
      filePath: file,
      entry: {
        id: "w1",
        workerUrl: "https://chatgpt.com/c/ccc",
        cdpEndpoint: "http://127.0.0.1:9222",
      },
    });
  } catch {
    threw = true;
  }
  assert(threw, "duplicate id without --replace throws");

  upsertWorkerRegistryEntry({
    filePath: file,
    entry: {
      id: "w1",
      workerUrl: "https://chatgpt.com/c/ddd",
      cdpEndpoint: "http://127.0.0.1:9222",
    },
    replace: true,
  });
  const raw = JSON.parse(readFileSync(file, "utf-8")) as Array<{
    id: string;
    workerUrl: string;
  }>;
  assert(
    raw.find((w) => w.id === "w1")?.workerUrl.includes("ddd"),
    "replace updates url"
  );

  threw = false;
  try {
    upsertWorkerRegistryEntry({
      filePath: file,
      entry: {
        id: "w3",
        workerUrl: "https://chatgpt.com/c/eee",
        cdpEndpoint: "http://127.0.0.1:9223",
      },
    });
  } catch {
    threw = true;
  }
  assert(threw, "mixed CDP after shared topology rejected");

  rmSync(dir, { recursive: true, force: true });
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main();
