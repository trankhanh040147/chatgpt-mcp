import { strict as assert } from "node:assert";
import {
  buildWorkerHealthRow,
  deriveOperatorPresentation,
} from "../src/ops/worker-health.js";

function baseWorker(overrides: Record<string, unknown> = {}) {
  return {
    id: "w1",
    status: "BUSY",
    readinessReason: null,
    error: null,
    mcpReadVerifiedAt: "2026-01-01T00:00:00.000Z",
    mcpWriteVerifiedAt: "2026-01-01T00:00:00.000Z",
    mcpWriteStatus: null,
    mcpWriteStatusReason: null,
    lastSeenAt: new Date().toISOString(),
    workerUrl: "https://chatgpt.com/c/abc",
    pid: process.pid,
    ...overrides,
  };
}

const brokerStatus = {
  healthy: true,
  bindings: [
    {
      workerId: "w1",
      pageUrl: "https://chatgpt.com/c/abc",
    },
  ],
} as const;

console.log("Running worker-health unit tests...\n");

{
  const row = buildWorkerHealthRow({
    worker: baseWorker() as never,
    brokerStatus: brokerStatus as never,
    brokerReachable: true,
    staleMs: 120_000,
    pinnedTerminalTaskId: "ho_completed123",
  });
  assert.equal(row.operatorState, "DEGRADED");
  assert.equal(row.healthState, "DEGRADED");
  assert(
    row.operatorDetail.includes("pinned"),
    "pinned terminal explains dispatch block"
  );
  console.log("✓ pinned terminal downgrades operator state");
}

{
  const staleAt = new Date(Date.now() - 300_000).toISOString();
  const row = buildWorkerHealthRow({
    worker: baseWorker({ status: "READY", lastSeenAt: staleAt }) as never,
    brokerStatus: brokerStatus as never,
    brokerReachable: true,
    staleMs: 120_000,
  });
  assert.equal(row.operatorState, "DEGRADED");
  assert(
    row.operatorDetail.includes("Heartbeat stale"),
    "stale heartbeat explains dispatch block"
  );
  console.log("✓ stale heartbeat downgrades infra-ready worker");
}

{
  const op = deriveOperatorPresentation({
    worker: {
      status: "READY",
      readinessReason: null,
      error: null,
    },
    healthState: "READY",
    recommendedAction: "NONE",
    brokerReachable: true,
    pinnedTerminalTaskId: "ho_done",
  });
  assert.equal(op.operatorState, "DEGRADED");
  console.log("✓ deriveOperatorPresentation handles pinned terminal");
}

console.log("\nAll worker-health tests passed.");
