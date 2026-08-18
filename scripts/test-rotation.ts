#!/usr/bin/env npx tsx
/**
 * Chat rotation budget unit tests (no browser).
 *   npm run test:rotation
 */
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
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
import { commitRotatedWorker } from "../src/ops/rotate-worker.js";
import {
  isChatBudgetExhausted,
  parseMaxTasksPerChat,
  shouldWarnChatBudget,
} from "../src/workers/chat-budget.js";

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

function freshRepo(): { repo: TaskRepository; dir: string } {
  resetDatabaseForTests();
  const dir = mkdtempSync(join(tmpdir(), "handoff-rot-"));
  const path = join(dir, "test.sqlite");
  initDatabase(path);
  return { repo: new TaskRepository(getDatabase()), dir };
}

function register(
  repo: TaskRepository,
  id: string,
  url: string,
  token = "tok"
): void {
  repo.registerWorkerInstance({
    workerId: id,
    instanceToken: token,
    workerUrl: url,
    cdpEndpoint: "http://127.0.0.1:9222",
    staleMs: 60_000,
  });
}

async function main(): Promise<void> {
  assert(parseMaxTasksPerChat(undefined) === 20, "default max = 20");
  try {
    parseMaxTasksPerChat("0");
    assert(false, "max 0 should throw");
  } catch {
    assert(true, "max 0 throws");
  }

  assert(!isChatBudgetExhausted(19, 20), "19/20 not exhausted");
  assert(isChatBudgetExhausted(20, 20), "20/20 exhausted");
  assert(shouldWarnChatBudget(19, 20), "warn at N-1");
  assert(!shouldWarnChatBudget(18, 20), "no warn at N-2");

  {
    const { repo, dir } = freshRepo();
    const url = "https://chatgpt.com/c/aaa";
    register(repo, "w1", url);
    const a = repo.recordChatDispatch({
      workerId: "w1",
      taskId: "ho_TASK1",
      chatUrl: url,
    });
    assert(a.recorded && a.tasksOnChat === 1, "first dispatch increments");
    const b = repo.recordChatDispatch({
      workerId: "w1",
      taskId: "ho_TASK1",
      chatUrl: url,
    });
    assert(!b.recorded && b.tasksOnChat === 1, "same task idempotent");
    const c = repo.recordChatDispatch({
      workerId: "w1",
      taskId: "ho_TASK2",
      chatUrl: url,
    });
    assert(c.recorded && c.tasksOnChat === 2, "second task increments");
    const w = repo.getWorkerState("w1");
    assert(w.tasksOnChat === 2 && w.tasksOnChatUrl === url, "state persisted");
    closeDatabase();
    rmSync(dir, { recursive: true, force: true });
  }

  {
    const { repo, dir } = freshRepo();
    const url1 = "https://chatgpt.com/c/old";
    register(repo, "w1", url1);
    repo.recordChatDispatch({
      workerId: "w1",
      taskId: "ho_T1",
      chatUrl: url1,
    });
    const url2 = "https://chatgpt.com/c/new";
    repo.releaseWorkerInstance("w1", "tok");
    register(repo, "w1", url2, "tok2");
    const w = repo.getWorkerState("w1");
    assert(w.tasksOnChat === 0, "URL change resets counter");
    assert(w.tasksOnChatUrl === url2, "counter bound to new URL");
    assert(w.previousWorkerUrl === url1, "previous URL recorded");
    assert(
      w.readinessReason === "CONSENT_REQUIRED",
      "URL change fail-closes as CONSENT_REQUIRED"
    );
    closeDatabase();
    rmSync(dir, { recursive: true, force: true });
  }

  {
    const prev = process.env.HANDOFF_MAX_TASKS_PER_CHAT;
    process.env.HANDOFF_MAX_TASKS_PER_CHAT = "2";
    const { repo, dir } = freshRepo();
    const url = "https://chatgpt.com/c/budget";
    register(repo, "w1", url);
    repo.updateWorkerState("w1", "READY", { instanceToken: "tok" });
    const service = new TaskService(repo);
    repo.recordChatDispatch({
      workerId: "w1",
      taskId: "ho_A",
      chatUrl: url,
    });
    repo.recordChatDispatch({
      workerId: "w1",
      taskId: "ho_B",
      chatUrl: url,
    });
    assert(
      repo.getWorkerState("w1").readinessReason === "THRESHOLD_REACHED",
      "Nth dispatch sets THRESHOLD_REACHED"
    );
    service.createTask({
      type: "research",
      prompt: "x",
      cursorConversationId: "c1",
    });
    const claimed = service.claimNextQueued("w1", "tok", 30_000, 60_000);
    assert(claimed === null, "cannot claim task N+1 at threshold");
    if (prev === undefined) delete process.env.HANDOFF_MAX_TASKS_PER_CHAT;
    else process.env.HANDOFF_MAX_TASKS_PER_CHAT = prev;
    closeDatabase();
    rmSync(dir, { recursive: true, force: true });
  }

  {
    const { repo, dir } = freshRepo();
    register(repo, "w1", "https://chatgpt.com/c/busy");
    repo.updateWorkerState("w1", "BUSY", {
      instanceToken: "tok",
      currentTaskId: "ho_LIVE",
    });
    try {
      repo.assertWorkerIdle("w1");
      assert(false, "busy worker should refuse idle assert");
    } catch (err) {
      assert(
        err instanceof Error && err.message.includes("busy"),
        "manual rotate refuses busy worker"
      );
    }
    try {
      repo.beginRotationReservation("w1");
      assert(false, "busy worker should refuse reservation");
    } catch (err) {
      assert(
        err instanceof Error && err.message.includes("busy"),
        "reservation refuses busy worker"
      );
    }
    closeDatabase();
    rmSync(dir, { recursive: true, force: true });
  }

  {
    const { repo, dir } = freshRepo();
    const oldUrl = "https://chatgpt.com/c/oldchat";
    const newUrl = "https://chatgpt.com/c/newchat";
    register(repo, "w1", oldUrl);
    repo.updateWorkerState("w1", "READY", { instanceToken: "tok" });
    repo.recordChatDispatch({
      workerId: "w1",
      taskId: "ho_OLD",
      chatUrl: oldUrl,
    });
    repo.beginRotationReservation("w1");
    const workersFile = join(dir, "workers.json");
    writeFileSync(
      workersFile,
      JSON.stringify(
        [
          {
            id: "w1",
            workerUrl: oldUrl,
            cdpEndpoint: "http://127.0.0.1:9222",
          },
        ],
        null,
        2
      )
    );
    const result = commitRotatedWorker({
      repo,
      workersFile,
      workerId: "w1",
      existing: {
        id: "w1",
        workerUrl: oldUrl,
        cdpEndpoint: "http://127.0.0.1:9222",
      },
      newWorkerUrl: newUrl,
    });
    const w = repo.getWorkerState("w1");
    assert(result.previousWorkerUrl === oldUrl, "commit reports previous URL");
    assert(w.tasksOnChat === 0, "commit resets counter");
    assert(w.tasksOnChatUrl === newUrl, "commit binds new URL");
    assert(w.readinessReason === "CONSENT_REQUIRED", "commit is CONSENT_REQUIRED");
    const service = new TaskService(repo);
    service.createTask({
      type: "research",
      prompt: "y",
      cursorConversationId: "c1",
    });
    assert(
      service.claimNextQueued("w1", "tok", 30_000, 60_000) === null,
      "cannot claim after rotation commit"
    );
    repo.setReadinessReason("w1", "RESTART_REQUIRED");
    repo.releaseWorkerInstance("w1", "tok");
    register(repo, "w1", newUrl, "tok3");
    const after = repo.getWorkerState("w1");
    assert(
      after.readinessReason == null,
      "broker restart on matching URL clears RESTART_REQUIRED"
    );
    closeDatabase();
    rmSync(dir, { recursive: true, force: true });
  }

  {
    const { repo, dir } = freshRepo();
    const url = "https://chatgpt.com/c/race";
    register(repo, "w1", url);
    repo.updateWorkerState("w1", "READY", { instanceToken: "tok" });
    const service = new TaskService(repo);
    service.createTask({
      type: "research",
      prompt: "race",
      cursorConversationId: "c1",
    });
    const reserved = repo.beginRotationReservation("w1");
    assert(reserved.previousReason == null, "reserve from idle");
    assert(
      repo.getWorkerState("w1").readinessReason === "ROTATION_PENDING",
      "reservation is ROTATION_PENDING"
    );
    assert(
      service.claimNextQueued("w1", "tok", 30_000, 60_000) === null,
      "claim blocked while ROTATION_PENDING"
    );
    try {
      repo.beginRotationReservation("w1");
      assert(false, "second reservation should fail");
    } catch (err) {
      assert(
        err instanceof Error && err.message.includes("already blocked"),
        "concurrent rotate loses CAS"
      );
    }
    repo.abortRotationReservation("w1", reserved.previousReason);
    assert(
      repo.getWorkerState("w1").readinessReason == null,
      "abort restores previous reason"
    );
    const claimed = service.claimNextQueued("w1", "tok", 30_000, 60_000);
    assert(claimed !== null, "claim allowed after abort reservation");
    closeDatabase();
    rmSync(dir, { recursive: true, force: true });
  }

  {
    const { repo, dir } = freshRepo();
    const url = "https://chatgpt.com/c/consent";
    register(repo, "w1", url);
    repo.updateWorkerState("w1", "READY", { instanceToken: "tok" });
    repo.setReadinessReason("w1", "CONSENT_REQUIRED", "CONSENT_REQUIRED: test");
    repo.releaseWorkerInstance("w1", "tok");
    register(repo, "w1", url, "tok9");
    assert(
      repo.getWorkerState("w1").readinessReason === "CONSENT_REQUIRED",
      "register/restart does not auto-clear CONSENT_REQUIRED"
    );
    closeDatabase();
    rmSync(dir, { recursive: true, force: true });
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
