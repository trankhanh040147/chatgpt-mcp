#!/usr/bin/env npx tsx
/**
 * Lease / fencing unit tests (no browser).
 *   npx tsx scripts/test-leases.ts
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

function freshDb(): { repo: TaskRepository; service: TaskService; path: string } {
  resetDatabaseForTests();
  const dir = mkdtempSync(join(tmpdir(), "handoff-lease-"));
  const path = join(dir, "test.sqlite");
  initDatabase(path);
  const repo = new TaskRepository(getDatabase());
  const service = new TaskService(repo);
  return { repo, service, path: dir };
}

function register(
  repo: TaskRepository,
  id: string,
  token: string,
  url = `https://chatgpt.com/c/${id}`,
  cdp = `http://127.0.0.1:${9000 + id.charCodeAt(0)}`
): void {
  repo.registerWorkerInstance({
    workerId: id,
    instanceToken: token,
    workerUrl: url,
    cdpEndpoint: cdp,
    staleMs: 60_000,
  });
  repo.updateWorkerState(id, "READY", { instanceToken: token });
}

async function main(): Promise<void> {
  // 1) two workers claim distinct tasks
  {
    const { repo, service, path } = freshDb();
    register(repo, "w1", "t1");
    register(repo, "w2", "t2");
    service.createTask({
      type: "research",
      prompt: "a",
      cursorConversationId: "c1",
    });
    service.createTask({
      type: "research",
      prompt: "b",
      cursorConversationId: "c1",
    });
    const a = service.claimNextQueued("w1", "t1", 30_000, 60_000);
    const b = service.claimNextQueued("w2", "t2", 30_000, 60_000);
    assert(a && b && a.task.id !== b.task.id, "two workers claim two tasks");
    assert(
      service.claimNextQueued("w1", "t1", 30_000, 60_000) === null,
      "w1 cannot claim second while holding first"
    );
    closeDatabase();
    rmSync(path, { recursive: true, force: true });
  }

  // 2) claim race — only one owner
  {
    const { repo, service, path } = freshDb();
    register(repo, "w1", "t1");
    register(repo, "w2", "t2");
    service.createTask({
      type: "research",
      prompt: "one",
      cursorConversationId: "c1",
    });
    const a = service.claimNextQueued("w1", "t1", 30_000, 60_000);
    const b = service.claimNextQueued("w2", "t2", 30_000, 60_000);
    assert(a && !b, "second worker gets null when only one queued");
    closeDatabase();
    rmSync(path, { recursive: true, force: true });
  }

  // 3) dispatch fence then submit
  {
    const { repo, service, path } = freshDb();
    register(repo, "w1", "t1");
    const { taskId } = service.createTask({
      type: "research",
      prompt: "fence",
      cursorConversationId: "c1",
    });
    const claimed = service.claimNextQueued("w1", "t1", 30_000, 60_000)!;
    let threw = false;
    try {
      service.submitResult({ taskId, result: "early" });
    } catch {
      threw = true;
    }
    assert(threw, "submit before fence throws");

    const ok = service.markDispatchStarted(
      taskId,
      "w1",
      claimed.leaseToken,
      "t1",
      30_000,
      60_000
    );
    assert(ok, "dispatch fence CAS succeeds");
    const done = service.submitResult({ taskId, result: "ok-result" });
    assert(done.success && done.status === "COMPLETED", "submit after fence completes");
    const again = service.submitResult({ taskId, result: "ok-result" });
    assert(again.idempotent === true, "identical submit is idempotent");
    closeDatabase();
    rmSync(path, { recursive: true, force: true });
  }

  // 4) stale instance cannot renew / fence
  {
    const { repo, service, path } = freshDb();
    register(repo, "w1", "old");
    const { taskId } = service.createTask({
      type: "research",
      prompt: "stale",
      cursorConversationId: "c1",
    });
    const claimed = service.claimNextQueued("w1", "old", 30_000, 60_000)!;
    // Age heartbeat so takeover is allowed
    getDatabase()
      .prepare(`UPDATE worker_state SET last_seen_at = ? WHERE id = ?`)
      .run(new Date(Date.now() - 120_000).toISOString(), "w1");
    repo.registerWorkerInstance({
      workerId: "w1",
      instanceToken: "new",
      workerUrl: "https://chatgpt.com/c/w1b",
      cdpEndpoint: "http://127.0.0.1:9333",
      staleMs: 60_000,
    });
    repo.updateWorkerState("w1", "READY", { instanceToken: "new" });

    const renewed = service.renewLease(
      taskId,
      "w1",
      claimed.leaseToken,
      "old",
      30_000,
      60_000
    );
    assert(!renewed, "stale instance cannot renew");

    // Re-claim under new instance after releasing — first expire the old claim
    getDatabase()
      .prepare(
        `UPDATE handoff_tasks SET lease_expires_at = ? WHERE id = ?`
      )
      .run(new Date(Date.now() - 1000).toISOString(), taskId);
    service.expireLeases();
    const task = repo.getTaskById(taskId)!;
    assert(task.status === "QUEUED", "pre-dispatch expiry requeues");

    const claimed2 = service.claimNextQueued("w1", "new", 30_000, 60_000)!;
    const fencedOld = service.markDispatchStarted(
      claimed2.task.id,
      "w1",
      claimed2.leaseToken,
      "old",
      30_000,
      60_000
    );
    assert(!fencedOld, "old instance cannot fence");
    const fencedNew = service.markDispatchStarted(
      claimed2.task.id,
      "w1",
      claimed2.leaseToken,
      "new",
      30_000,
      60_000
    );
    assert(fencedNew, "new instance can fence");
    closeDatabase();
    rmSync(path, { recursive: true, force: true });
  }

  // 5) post-dispatch expiry → TIMED_OUT not requeue
  {
    const { repo, service, path } = freshDb();
    register(repo, "w1", "t1");
    const { taskId } = service.createTask({
      type: "research",
      prompt: "post",
      cursorConversationId: "c1",
    });
    const claimed = service.claimNextQueued("w1", "t1", 30_000, 60_000)!;
    service.markDispatchStarted(
      taskId,
      "w1",
      claimed.leaseToken,
      "t1",
      30_000,
      60_000
    );
    getDatabase()
      .prepare(`UPDATE handoff_tasks SET lease_expires_at = ? WHERE id = ?`)
      .run(new Date(Date.now() - 1000).toISOString(), taskId);
    const stats = service.expireLeases();
    assert(stats.timedOut === 1, "post-dispatch expiry times out");
    assert(repo.getTaskById(taskId)?.status === "TIMED_OUT", "status TIMED_OUT");
    const late = service.submitResult({
      taskId,
      result: "finished-after-timeout",
    });
    assert(
      late.success && late.status === "COMPLETED" && late.lateSubmit === true,
      "late submit after TIMED_OUT completes"
    );
    const againLate = service.submitResult({
      taskId,
      result: "finished-after-timeout",
    });
    assert(againLate.idempotent === true, "late submit replay is idempotent");
    closeDatabase();
    rmSync(path, { recursive: true, force: true });
  }

  // 6) one nudge fence
  {
    const { repo, service, path } = freshDb();
    register(repo, "w1", "t1");
    const { taskId } = service.createTask({
      type: "research",
      prompt: "nudge",
      cursorConversationId: "c1",
    });
    const claimed = service.claimNextQueued("w1", "t1", 30_000, 60_000)!;
    service.markDispatchStarted(
      taskId,
      "w1",
      claimed.leaseToken,
      "t1",
      30_000,
      60_000
    );
    const n1 = service.markNudgeStarted(
      taskId,
      "w1",
      claimed.leaseToken,
      "t1",
      30_000,
      60_000
    );
    const n2 = service.markNudgeStarted(
      taskId,
      "w1",
      claimed.leaseToken,
      "t1",
      30_000,
      60_000
    );
    assert(n1 && !n2, "exactly one nudge fence succeeds");
    assert(
      repo.getTaskById(taskId)?.status === "WAITING_APPROVAL",
      "nudge promotes to WAITING_APPROVAL"
    );
    assert(
      service.findPendingForConversation("c1")?.id === taskId,
      "WAITING_APPROVAL still pending for Cursor wait hook"
    );
    closeDatabase();
    rmSync(path, { recursive: true, force: true });
  }

  // 6b) expired lease cannot nudge
  {
    const { repo, service, path } = freshDb();
    register(repo, "w1", "t1");
    const { taskId } = service.createTask({
      type: "research",
      prompt: "nudge-expired",
      cursorConversationId: "c1",
    });
    const claimed = service.claimNextQueued("w1", "t1", 30_000, 60_000)!;
    service.markDispatchStarted(
      taskId,
      "w1",
      claimed.leaseToken,
      "t1",
      30_000,
      60_000
    );
    getDatabase()
      .prepare(`UPDATE handoff_tasks SET lease_expires_at = ? WHERE id = ?`)
      .run(new Date(Date.now() - 1000).toISOString(), taskId);
    const n = service.markNudgeStarted(
      taskId,
      "w1",
      claimed.leaseToken,
      "t1",
      30_000,
      60_000
    );
    assert(!n, "expired lease cannot nudge");
    closeDatabase();
    rmSync(path, { recursive: true, force: true });
  }

  // 6c) expireLeases clears current_task_id only for the expired task id
  {
    const { repo, service, path } = freshDb();
    register(repo, "w1", "t1");
    const a = service.createTask({
      type: "research",
      prompt: "a",
      cursorConversationId: "c1",
    });
    const claimed = service.claimNextQueued("w1", "t1", 30_000, 60_000)!;
    service.markDispatchStarted(
      a.taskId,
      "w1",
      claimed.leaseToken,
      "t1",
      30_000,
      60_000
    );
    getDatabase()
      .prepare(`UPDATE handoff_tasks SET lease_expires_at = ? WHERE id = ?`)
      .run(new Date(Date.now() - 1000).toISOString(), a.taskId);
    // Simulate a newer diagnostic assignment that must not be wiped by A's expiry.
    getDatabase()
      .prepare(`UPDATE worker_state SET current_task_id = ? WHERE id = ?`)
      .run("ho_OTHER_TASK", "w1");
    const stats = service.expireLeases();
    assert(stats.timedOut === 1, "expired A times out");
    const ws = repo.listWorkers().find((w) => w.id === "w1");
    assert(
      ws?.currentTaskId === "ho_OTHER_TASK",
      "expiry must not clear unrelated current_task_id"
    );
    closeDatabase();
    rmSync(path, { recursive: true, force: true });
  }

  // 7) live duplicate worker id fails
  {
    const { repo, path } = freshDb();
    register(repo, "w1", "t1");
    let threw = false;
    try {
      repo.registerWorkerInstance({
        workerId: "w1",
        instanceToken: "t2",
        workerUrl: "https://chatgpt.com/c/other",
        cdpEndpoint: "http://127.0.0.1:9444",
        staleMs: 60_000,
      });
    } catch {
      threw = true;
    }
    assert(threw, "live duplicate worker id rejected");

    // Dead PID may be taken over even with fresh heartbeat
    getDatabase()
      .prepare(`UPDATE worker_state SET pid = ?, last_seen_at = ? WHERE id = ?`)
      .run(process.pid, new Date().toISOString(), "w1");
    // Fake a dead pid
    getDatabase()
      .prepare(`UPDATE worker_state SET pid = ? WHERE id = ?`)
      .run(999_999_999, "w1");
    let tookOver = false;
    try {
      repo.registerWorkerInstance({
        workerId: "w1",
        instanceToken: "t3",
        workerUrl: "https://chatgpt.com/c/other2",
        cdpEndpoint: "http://127.0.0.1:9555",
        staleMs: 60_000,
        pid: process.pid,
      });
      tookOver = true;
    } catch {
      tookOver = false;
    }
    assert(tookOver, "dead pid allows worker id takeover");
    closeDatabase();
    rmSync(path, { recursive: true, force: true });
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
