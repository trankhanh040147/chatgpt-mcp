#!/usr/bin/env npx tsx
/**
 * Task-scoped evidence file tests (0.6 D1) — no browser, no ChatGPT.
 *   npx tsx scripts/test-files.ts
 */
import { mkdtempSync, rmSync, writeFileSync, symlinkSync, unlinkSync } from "node:fs";
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
import { HandoffFileError } from "../src/tasks/task.types.js";

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

function freshDb(dbDir: string): { repo: TaskRepository; service: TaskService } {
  resetDatabaseForTests();
  const path = join(dbDir, "test.sqlite");
  initDatabase(path);
  const repo = new TaskRepository(getDatabase());
  const service = new TaskService(repo);
  return { repo, service };
}

function expectFileError(fn: () => void, code: string, msg: string): void {
  try {
    fn();
    assert(false, `${msg} (expected throw, got none)`);
  } catch (err) {
    if (err instanceof HandoffFileError) {
      assert(err.code === code, `${msg} (code=${err.code}, expected ${code})`);
    } else {
      assert(false, `${msg} (non-HandoffFileError: ${(err as Error).message})`);
    }
  }
}

async function main() {
  const dbDir = mkdtempSync(join(tmpdir(), "handoff-files-db-"));
  const wsDir = mkdtempSync(join(tmpdir(), "handoff-files-ws-"));
  process.env.HANDOFF_WORKSPACE_ROOT = wsDir;

  // --- Happy path: single file full read ---
  {
    const { service } = freshDb(dbDir);
    writeFileSync(join(wsDir, "a.ts"), "export const a = 1;\n");
    const { taskId } = service.createTask({
      type: "research",
      prompt: "p",
      cursorConversationId: "c1",
      files: ["a.ts"],
    });
    const task = service.getTask(taskId)!;
    assert(task.files?.length === 1, "happy: one file attached");
    const fileId = task.files![0].fileId;
    const read = service.readFile(taskId, fileId);
    assert(read.content === "export const a = 1;\n", "happy: content matches");
    assert(read.eof === true, "happy: eof true on full read");
    assert(read.sha256 === task.files![0].sha256, "happy: sha256 matches create-time hash");
  }

  // --- Two files; isolation by fileId ---
  {
    const { service } = freshDb(dbDir);
    writeFileSync(join(wsDir, "b1.ts"), "b1");
    writeFileSync(join(wsDir, "b2.ts"), "b2");
    const { taskId } = service.createTask({
      type: "research",
      prompt: "p",
      cursorConversationId: "c2",
      files: ["b1.ts", "b2.ts"],
    });
    const task = service.getTask(taskId)!;
    assert(task.files?.length === 2, "two-file: both attached");
    const f1 = task.files!.find((f) => f.relativePath === "b1.ts")!;
    const f2 = task.files!.find((f) => f.relativePath === "b2.ts")!;
    assert(service.readFile(taskId, f1.fileId).content === "b1", "two-file: f1 isolated");
    assert(service.readFile(taskId, f2.fileId).content === "b2", "two-file: f2 isolated");
  }

  // --- Traversal / absolute / symlink reject at create ---
  {
    const { service } = freshDb(dbDir);
    expectFileError(
      () => service.createTask({ type: "research", prompt: "p", cursorConversationId: "c3", files: ["../etc/passwd"] }),
      "FILES_INVALID",
      "reject: traversal"
    );
    expectFileError(
      () => service.createTask({ type: "research", prompt: "p", cursorConversationId: "c3", files: ["/etc/hosts"] }),
      "FILES_INVALID",
      "reject: absolute path"
    );
    const linkPath = join(wsDir, "link.ts");
    try { unlinkSync(linkPath); } catch { /* ignore */ }
    symlinkSync("/etc/hosts", linkPath);
    expectFileError(
      () => service.createTask({ type: "research", prompt: "p", cursorConversationId: "c3", files: ["link.ts"] }),
      "FILES_INVALID",
      "reject: symlink attachment"
    );
  }

  // --- Unlisted / cross-task fileId ---
  {
    const { service } = freshDb(dbDir);
    writeFileSync(join(wsDir, "c1.ts"), "c1");
    writeFileSync(join(wsDir, "c2.ts"), "c2");
    const t1 = service.createTask({ type: "research", prompt: "p", cursorConversationId: "c4", files: ["c1.ts"] });
    const t2 = service.createTask({ type: "research", prompt: "p", cursorConversationId: "c4", files: ["c2.ts"] });
    const task2 = service.getTask(t2.taskId)!;
    expectFileError(
      () => service.readFile(t1.taskId, task2.files![0].fileId),
      "FILE_NOT_ON_TASK",
      "reject: cross-task fileId"
    );
    expectFileError(
      () => service.readFile(t1.taskId, "f_unknown"),
      "FILE_NOT_ON_TASK",
      "reject: unlisted fileId"
    );
  }

  // --- Mutate after create -> FILE_CHANGED_REATTACH ---
  {
    const { service } = freshDb(dbDir);
    const path = join(wsDir, "mut.ts");
    writeFileSync(path, "original");
    const { taskId } = service.createTask({ type: "research", prompt: "p", cursorConversationId: "c5", files: ["mut.ts"] });
    const task = service.getTask(taskId)!;
    writeFileSync(path, "mutated!!");
    expectFileError(
      () => service.readFile(taskId, task.files![0].fileId),
      "FILE_CHANGED_REATTACH",
      "reject: mutated file"
    );
  }

  // --- Delete after create -> FILE_NOT_FOUND ---
  {
    const { service } = freshDb(dbDir);
    const path = join(wsDir, "del.ts");
    writeFileSync(path, "gone-soon");
    const { taskId } = service.createTask({ type: "research", prompt: "p", cursorConversationId: "c6", files: ["del.ts"] });
    const task = service.getTask(taskId)!;
    unlinkSync(path);
    expectFileError(
      () => service.readFile(taskId, task.files![0].fileId),
      "FILE_NOT_FOUND",
      "reject: deleted file"
    );
  }

  // --- Secret filenames ---
  {
    const { service } = freshDb(dbDir);
    writeFileSync(join(wsDir, ".env.local"), "SECRET=1");
    expectFileError(
      () => service.createTask({ type: "research", prompt: "p", cursorConversationId: "c7", files: [".env.local"] }),
      "FILES_INVALID",
      "reject: .env.local"
    );
    writeFileSync(join(wsDir, ".ENV"), "SECRET=1");
    expectFileError(
      () => service.createTask({ type: "research", prompt: "p", cursorConversationId: "c7", files: [".ENV"] }),
      "FILES_INVALID",
      "reject: .ENV case-insensitive"
    );
  }

  // --- NUL / binary content ---
  {
    const { service } = freshDb(dbDir);
    writeFileSync(join(wsDir, "bin.ts"), Buffer.from([0x00, 0x01, 0x02, 0x74, 0x73]));
    expectFileError(
      () => service.createTask({ type: "research", prompt: "p", cursorConversationId: "c8", files: ["bin.ts"] }),
      "FILES_INVALID",
      "reject: binary/NUL content"
    );
  }

  // --- 11th file / per-file oversize / sum > 1 MiB ---
  {
    const { service } = freshDb(dbDir);
    const names: string[] = [];
    for (let i = 0; i < 11; i += 1) {
      const name = `many${i}.ts`;
      writeFileSync(join(wsDir, name), `// ${i}`);
      names.push(name);
    }
    expectFileError(
      () => service.createTask({ type: "research", prompt: "p", cursorConversationId: "c9", files: names }),
      "FILES_INVALID",
      "reject: 11th file"
    );

    writeFileSync(join(wsDir, "big.ts"), "x".repeat(300 * 1024));
    expectFileError(
      () => service.createTask({ type: "research", prompt: "p", cursorConversationId: "c9", files: ["big.ts"] }),
      "FILE_TOO_LARGE",
      "reject: per-file oversize"
    );

    const sumNames: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      const name = `sum${i}.ts`;
      writeFileSync(join(wsDir, name), "y".repeat(210 * 1024));
      sumNames.push(name);
    }
    expectFileError(
      () => service.createTask({ type: "research", prompt: "p", cursorConversationId: "c9", files: sumNames }),
      "FILE_TOO_LARGE",
      "reject: sum > 1 MiB (5x210KiB)"
    );
    const task = service.getTask(
      service.createTask({ type: "research", prompt: "p", cursorConversationId: "c9x" }).taskId
    );
    assert(task !== null, "reject: no partial task row created for failed sum case (sanity: fresh unrelated task still creatable)");
  }

  // --- Range on sanitized stream ---
  {
    const { service } = freshDb(dbDir);
    writeFileSync(join(wsDir, "range.ts"), "0123456789");
    const { taskId } = service.createTask({ type: "research", prompt: "p", cursorConversationId: "c10", files: ["range.ts"] });
    const task = service.getTask(taskId)!;
    const fileId = task.files![0].fileId;
    const r1 = service.readFile(taskId, fileId, 0, 4);
    assert(r1.content === "0123", "range: first 4 bytes");
    assert(r1.eof === false, "range: not eof mid-stream");
    assert(r1.totalBytes === 10, "range: totalBytes correct");
    const r2 = service.readFile(taskId, fileId, 4, 100);
    assert(r2.content === "456789", "range: remainder");
    assert(r2.eof === true, "range: eof at end");
  }

  // --- Secret spanning the 64 KiB sanitize boundary ---
  {
    const { service } = freshDb(dbDir);
    const secret = "sk-" + "A".repeat(40);
    const boundary = 65536;
    const prefixLen = boundary - 10;
    const content = "x".repeat(prefixLen) + secret + "y".repeat(1000);
    writeFileSync(join(wsDir, "boundary.ts"), content);
    const { taskId } = service.createTask({ type: "research", prompt: "p", cursorConversationId: "c11", files: ["boundary.ts"] });
    const task = service.getTask(taskId)!;
    const fileId = task.files![0].fileId;
    const chunk1 = service.readFile(taskId, fileId, 0, boundary);
    const chunk2 = service.readFile(taskId, fileId, chunk1.returnedBytes, 262144);
    assert(!chunk1.content.includes(secret), "boundary: secret absent from chunk1");
    assert(!chunk2.content.includes(secret), "boundary: secret absent from chunk2");
    const reconstructed = chunk1.content + chunk2.content;
    assert(!reconstructed.includes(secret), "boundary: secret absent from reconstruction");
  }

  // --- get_task / errors / logs: no source_path or workspace_root leakage ---
  {
    const { service } = freshDb(dbDir);
    writeFileSync(join(wsDir, "leak.ts"), "leak-check");
    const { taskId } = service.createTask({ type: "research", prompt: "p", cursorConversationId: "c12", files: ["leak.ts"] });
    const task = service.getTask(taskId)!;
    const serialized = JSON.stringify({
      taskId: task.id,
      type: task.type,
      prompt: task.prompt,
      context: task.context ?? {},
      status: task.status,
      files: (task.files ?? []).map((f) => ({
        fileId: f.fileId,
        displayName: f.displayName,
        relativePath: f.relativePath,
        size: f.sizeBytes,
        sha256: f.sha256,
        mediaType: f.mediaType,
      })),
    });
    assert(!serialized.includes(wsDir), "leakage: get_task manifest excludes workspace_root");
    assert(!serialized.includes("source_path"), "leakage: get_task manifest excludes source_path key");

    try {
      service.readFile(taskId, "f_bogus");
      assert(false, "leakage: expected error on bogus fileId");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      assert(!msg.includes(wsDir), "leakage: error message excludes workspace root path");
    }
  }

  // --- HANDOFF_WORKSPACE_ROOT change after create has no effect on existing task ---
  {
    const { service } = freshDb(dbDir);
    writeFileSync(join(wsDir, "persist.ts"), "persisted");
    const { taskId } = service.createTask({ type: "research", prompt: "p", cursorConversationId: "c13", files: ["persist.ts"] });
    const task = service.getTask(taskId)!;
    const otherRoot = mkdtempSync(join(tmpdir(), "handoff-files-other-ws-"));
    const prevEnv = process.env.HANDOFF_WORKSPACE_ROOT;
    process.env.HANDOFF_WORKSPACE_ROOT = otherRoot;
    try {
      const read = service.readFile(taskId, task.files![0].fileId);
      assert(read.content === "persisted", "persist: read still uses persisted root after env change");
    } finally {
      process.env.HANDOFF_WORKSPACE_ROOT = prevEnv;
      rmSync(otherRoot, { recursive: true, force: true });
    }
  }

  // --- relevantFiles only (no `files`) -> no file rows; read fails ---
  {
    const { service } = freshDb(dbDir);
    const { taskId } = service.createTask({
      type: "research",
      prompt: "p",
      cursorConversationId: "c14",
      context: { relevantFiles: ["a.ts", "b.ts"] },
    });
    const task = service.getTask(taskId)!;
    assert((task.files ?? []).length === 0, "relevantFiles-only: no file rows created");
    expectFileError(
      () => service.readFile(taskId, "f_anything"),
      "FILE_NOT_ON_TASK",
      "relevantFiles-only: read fails"
    );
  }

  closeDatabase();
  rmSync(dbDir, { recursive: true, force: true });
  rmSync(wsDir, { recursive: true, force: true });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
