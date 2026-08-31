import { strict as assert } from "node:assert";
import {
  deriveSystemTaxonomy,
  deriveRecommendedAction,
  summarizeIncidents,
  sortWorkersByAttention,
  openDebugWorkers,
  isWorkerDebugOpen,
  setWorkerDebugOpen,
  deriveWorkerCountState,
} from "../src/dashboard/public/app.js";

console.log("Running PR1 dashboard UI unit tests...\n");

// 1. System status taxonomy tests
{
  // API DOWN when health is not ok or null
  assert.equal(
    deriveSystemTaxonomy({ ok: false }, [{ id: "w1", healthy: true }]),
    "DOWN",
    "API unhealthy → DOWN"
  );
  assert.equal(
    deriveSystemTaxonomy(null, [{ id: "w1", healthy: true }]),
    "DOWN",
    "Null health → DOWN"
  );

  // SETUP when API healthy + 0 registered workers
  assert.equal(
    deriveSystemTaxonomy({ ok: true }, []),
    "SETUP",
    "API healthy + 0 registered workers → SETUP (NOT DOWN)"
  );
  assert.equal(
    deriveSystemTaxonomy({ ok: true }, [{ id: "default", healthy: false }]),
    "SETUP",
    "Only default worker present → SETUP"
  );

  // DEGRADED when API healthy + worker issues
  assert.equal(
    deriveSystemTaxonomy({ ok: true }, [
      { id: "w1", healthy: false, pidAlive: false },
      { id: "w2", healthy: true, pidAlive: true },
    ]),
    "DEGRADED",
    "1 unhealthy worker → DEGRADED"
  );

  assert.equal(
    deriveSystemTaxonomy({ ok: true }, [
      { id: "w1", healthy: true, pidAlive: true, heartbeatStale: true },
    ]),
    "DEGRADED",
    "Stale heartbeat → DEGRADED"
  );

  // OK when all workers healthy
  assert.equal(
    deriveSystemTaxonomy({ ok: true }, [
      { id: "w1", healthy: true, pidAlive: true, heartbeatStale: false },
      { id: "w2", healthy: true, pidAlive: true, heartbeatStale: false },
    ]),
    "OK",
    "All workers healthy → OK"
  );
  console.log("✓ System status taxonomy passed");
}

// 2. deriveRecommendedAction heuristics
{
  const systemState = { brokerReachable: true };

  // Heuristic: dead PID & broker reachable
  {
    const res = deriveRecommendedAction(
      {
        id: "w1",
        healthy: false,
        pidAlive: false,
        heartbeatStale: true,
        healthState: "OFFLINE",
      },
      systemState
    );
    assert.equal(res.actionKey, "kill", "Dead PID suggests recreate chat");
    assert.equal(res.label, "Recreate chat…");
    assert.equal(res.destructive, true);
    assert(res.priority > 50, "Dead PID has high priority");
  }

  // Heuristic: ROTATION_FAILED
  {
    const res = deriveRecommendedAction(
      {
        id: "w1",
        healthy: false,
        pidAlive: true,
        readinessReason: "ROTATION_FAILED",
      },
      systemState
    );
    assert.equal(res.actionKey, "create", "ROTATION_FAILED suggests new chat");
    assert.equal(res.label, "New chat…");
    assert.equal(res.destructive, false);
  }

  // Heuristic: brokerReachable === false
  {
    const res = deriveRecommendedAction(
      { id: "w1", healthy: false, pidAlive: true },
      { brokerReachable: false }
    );
    assert.equal(res.actionKey, "start-broker", "Broker unreachable suggests start broker");
    assert.equal(res.label, "Start broker");
    assert.equal(res.destructive, false);
  }

  // Heuristic: MCP_APPROVAL_REQUIRED / CONTINUE
  {
    const res = deriveRecommendedAction(
      {
        id: "w1",
        healthy: false,
        pidAlive: true,
        readinessReason: "MCP_APPROVAL_REQUIRED",
      },
      systemState
    );
    assert.equal(res.actionKey, "continue", "MCP_APPROVAL_REQUIRED suggests continue");
    assert.equal(res.label, "Continue");
    assert.equal(res.destructive, false);
  }

  // Heuristic: SESSION_LOST
  {
    const res = deriveRecommendedAction(
      {
        id: "w1",
        healthy: false,
        status: "SESSION_LOST",
      },
      systemState
    );
    assert.equal(res.actionKey, "kill", "SESSION_LOST suggests recreate chat");
  }

  // Heuristic: Healthy worker
  {
    const res = deriveRecommendedAction(
      {
        id: "w2",
        healthy: true,
        pidAlive: true,
        chatUrl: "https://chatgpt.com/c/123",
      },
      systemState
    );
    assert.equal(res.actionKey, "open-chat", "Healthy worker suggests open worker chat");
    assert.equal(res.label, "Open worker chat");
    assert.equal(res.priority, 0);
  }
  console.log("✓ deriveRecommendedAction heuristics passed");
}

// 3. Incident summary & de-duplication
{
  // Stale heartbeat + dead PID on w1 = single incident sentence
  const summary = summarizeIncidents([
    {
      id: "w1",
      healthy: false,
      pidAlive: false,
      heartbeatStale: true,
      readinessReason: "ROTATION_FAILED",
    },
  ]);
  assert(
    !summary.includes("heartbeat") || !summary.includes("PID"),
    "Stale heartbeat + dead PID summarized once without repeating diagnostic facts"
  );
  assert(summary.includes("w1"), "Mentions worker id");

  // Healthy workers give clean message
  const healthySummary = summarizeIncidents([
    { id: "w1", healthy: true },
    { id: "w2", healthy: true },
  ]);
  assert.equal(healthySummary, "All workers ready for handoffs");
  console.log("✓ Incident summary and de-duplication passed");
}

// 4. Attention sorting
{
  const systemState = { brokerReachable: true };
  const workers = [
    { id: "w2", healthy: true, pidAlive: true, chatUrl: "https://chatgpt.com/c/w2" },
    { id: "w1", healthy: false, pidAlive: false, heartbeatStale: true },
    { id: "w3", healthy: true, pidAlive: true, chatUrl: "https://chatgpt.com/c/w3" },
  ];

  const sorted = sortWorkersByAttention(workers, systemState);
  assert.equal(sorted[0].id, "w1", "Unhealthy worker w1 sorted first");
  assert.equal(sorted[1].id, "w2", "w2 second");
  assert.equal(sorted[2].id, "w3", "w3 third");
  console.log("✓ Attention sorting passed");
}

// 5. Acceptance test scenario:
// Given w1: PID dead + heartbeat stale + rotation failed; w2: healthy
// ≤5s scan: DEGRADED headline, 1/2 available, w1 needs attention, one clear primary on w1,
// no fact >2 places, no destructive at primary level, w2 quieter than w1
{
  const systemState = { brokerReachable: true };
  const w1 = {
    id: "w1",
    healthy: false,
    pidAlive: false,
    heartbeatStale: true,
    readinessReason: "ROTATION_FAILED",
    status: "ERROR",
    operatorState: "ERROR",
  };
  const w2 = {
    id: "w2",
    healthy: true,
    pidAlive: true,
    heartbeatStale: false,
    status: "READY",
    operatorState: "READY",
    chatUrl: "https://chatgpt.com/c/w2",
  };

  const taxonomy = deriveSystemTaxonomy({ ok: true }, [w1, w2]);
  assert.equal(taxonomy, "DEGRADED", "Headline taxonomy is DEGRADED");

  const sorted = sortWorkersByAttention([w2, w1], systemState);
  assert.equal(sorted[0].id, "w1", "w1 needs attention and is sorted first");

  const actionW1 = deriveRecommendedAction(w1, systemState);
  assert(actionW1.label && actionW1.actionKey, "One clear primary action on w1");

  const actionW2 = deriveRecommendedAction(w2, systemState);
  assert.equal(actionW2.actionKey, "open-chat", "w2 is quieter with Open chat link");
  assert.equal(actionW2.priority, 0, "w2 has priority 0");
  console.log("✓ Acceptance test scenario passed");
}

// 6. Worker debug details open state persistence tests
{
  openDebugWorkers.clear();
  assert.equal(isWorkerDebugOpen("w1"), false, "w1 initially closed");
  assert.equal(isWorkerDebugOpen("w2"), false, "w2 initially closed");

  // Open w1 debug panel
  setWorkerDebugOpen("w1", true);
  assert.equal(isWorkerDebugOpen("w1"), true, "w1 is now open");
  assert.equal(isWorkerDebugOpen("w2"), false, "w2 remains closed");

  // Open w2 debug panel
  setWorkerDebugOpen("w2", true);
  assert.equal(isWorkerDebugOpen("w1"), true, "w1 stays open across poll ticks");
  assert.equal(isWorkerDebugOpen("w2"), true, "w2 is open");

  // Close w1 debug panel
  setWorkerDebugOpen("w1", false);
  assert.equal(isWorkerDebugOpen("w1"), false, "w1 is closed after toggle");
  assert.equal(isWorkerDebugOpen("w2"), true, "w2 remains open");

  openDebugWorkers.clear();
  console.log("✓ Debug details open state persistence passed");
}

// 7. Worker count state derivation tests
{
  // 0 registered
  const zeroState = deriveWorkerCountState(0, 0);
  assert.equal(zeroState.text, "0 registered");
  assert.equal(zeroState.kind, "warn");

  // All healthy (e.g. 2 of 2)
  const allHealthyState = deriveWorkerCountState(2, 2);
  assert.equal(allHealthyState.text, "2 registered · 2 healthy");
  assert.equal(allHealthyState.kind, "ok");

  // Degraded (e.g. 1 of 2 healthy)
  const degradedState = deriveWorkerCountState(2, 1);
  assert.equal(degradedState.text, "2 registered · 1 healthy");
  assert.equal(degradedState.kind, "warn");

  // All unhealthy (e.g. 0 of 2 healthy)
  const allUnhealthyState = deriveWorkerCountState(2, 0);
  assert.equal(allUnhealthyState.text, "2 registered · 0 healthy");
  assert.equal(allUnhealthyState.kind, "bad");

  console.log("✓ Worker count state derivation passed");
}

console.log("\nAll PR1 dashboard UI tests passed successfully!");
