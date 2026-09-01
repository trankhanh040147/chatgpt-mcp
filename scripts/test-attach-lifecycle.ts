#!/usr/bin/env npx tsx
/**
 * Attachment lifecycle + pre-submit cleanup regressions (v0.7).
 *   npm run test:attach-lifecycle
 */
import {
  cleanupPreparedAttachSession,
  type PreparedAttachSession,
} from "../src/browser/attachment-lifecycle.js";
import type {
  PrepareResult,
  ResourceDeliveryTarget,
} from "../src/transport/types.js";
import type { PreparedResource } from "../src/tasks/task.types.js";
import {
  isAllowedResourceExtension,
  materializeWorkspaceResources,
  MAX_BYTES_PER_FILE,
  registerTaskResourcePaths,
  resourceExtensionSuffixesForChipMatch,
} from "../src/tasks/files.js";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HandoffFileError } from "../src/tasks/task.types.js";
import {
  initDatabase,
  closeDatabase,
  resetDatabaseForTests,
  getDatabase,
} from "../src/db/sqlite.js";
import { TaskRepository } from "../src/tasks/task.repository.js";
import { TaskService } from "../src/tasks/task.service.js";

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

class MockTransport implements ResourceDeliveryTarget {
  cleanupCalls = 0;
  cleanAfterCleanup = true;

  async prepare(
    _prepared: readonly PreparedResource[],
    _taskId: string
  ): Promise<PrepareResult> {
    return { ok: true, expected: [], added: [] };
  }

  async cleanup(): Promise<void> {
    this.cleanupCalls += 1;
  }

  async isClean(): Promise<boolean> {
    return this.cleanAfterCleanup;
  }
}

async function main() {
  // --- cleanup helper: no session ---
  {
    let ran = false;
    const clean = await cleanupPreparedAttachSession(null, async () => {
      ran = true;
    });
    assert(!ran, "cleanup: null session skips runner");
    assert(clean === true, "cleanup: null session returns clean");
  }

  // --- cleanup helper: prepared session invokes cleanup ---
  {
    const transport = new MockTransport();
    const session: PreparedAttachSession = { transport, prepared: true };
    const clean = await cleanupPreparedAttachSession(session, async () => {
      await transport.cleanup();
    });
    assert(transport.cleanupCalls === 1, "cleanup: prepared session calls transport.cleanup");
    assert(clean === true, "cleanup: returns isClean true");
  }

  // --- cleanup helper: not clean fail-closed signal ---
  {
    const transport = new MockTransport();
    transport.cleanAfterCleanup = false;
    const session: PreparedAttachSession = { transport, prepared: true };
    const clean = await cleanupPreparedAttachSession(session, async () => {
      await transport.cleanup();
    });
    assert(clean === false, "cleanup: reports not clean when isClean false");
  }

  // --- extension allowlist shared with chip matcher ---
  {
    const suffixes = resourceExtensionSuffixesForChipMatch();
    assert(suffixes.includes("mjs"), "allowlist: mjs in chip suffixes");
    assert(suffixes.includes("cjs"), "allowlist: cjs in chip suffixes");
    assert(isAllowedResourceExtension("lib.mts"), "allowlist: mts path allowed");
  }

  // --- materialize enforces buf.length after read (TOCTOU) ---
  {
    const ws = mkdtempSync(join(tmpdir(), "handoff-attach-ws-"));
    const now = new Date().toISOString();
    try {
      const path = join(ws, "grow.ts");
      writeFileSync(path, "x".repeat(MAX_BYTES_PER_FILE + 1));
      const refs = registerTaskResourcePaths(["grow.ts"], now);
      try {
        materializeWorkspaceResources(refs, ws);
        assert(false, "materialize: oversize file must throw");
      } catch (err) {
        assert(
          err instanceof HandoffFileError && err.code === "FILE_TOO_LARGE",
          "materialize: oversize rejected (stat or post-read)"
        );
      }
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  }

  // --- fence CAS: second markDispatchStarted fails (worker must cleanup before abort) ---
  {
    const dbDir = mkdtempSync(join(tmpdir(), "handoff-attach-db-"));
    resetDatabaseForTests();
    initDatabase(join(dbDir, "t.sqlite"));
    const repo = new TaskRepository(getDatabase());
    const service = new TaskService(repo);
    repo.registerWorkerInstance({
      workerId: "w1",
      instanceToken: "tok1",
      workerUrl: "https://chatgpt.com/c/w1",
      cdpEndpoint: "http://127.0.0.1:9222",
      staleMs: 60_000,
    });
    repo.updateWorkerState("w1", "READY", { instanceToken: "tok1" });
    const { taskId } = service.createTask({
      type: "research",
      prompt: "fence",
      cursorConversationId: "c-fence",
    });
    const claimed = service.claimNextQueued("w1", "tok1", 30_000, 60_000);
    assert(claimed !== null, "fence: task claimed");
    const first = service.markDispatchStarted(
      taskId,
      "w1",
      claimed!.leaseToken,
      "tok1",
      30_000,
      60_000
    );
    const second = service.markDispatchStarted(
      taskId,
      "w1",
      claimed!.leaseToken,
      "tok1",
      30_000,
      60_000
    );
    assert(first && !second, "fence: markDispatchStarted idempotent CAS");
    closeDatabase();
    rmSync(dbDir, { recursive: true, force: true });
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
