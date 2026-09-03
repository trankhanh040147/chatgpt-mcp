#!/usr/bin/env npx tsx
/**
 * Task-scoped evidence file tests (v0.7) — dispatch-time materialization, no snapshot.
 *   npx tsx scripts/test-files.ts
 */
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync, symlinkSync, unlinkSync, mkdirSync, realpathSync } from "node:fs";
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
import {
  MAX_BYTES_PER_FILE,
  MAX_BYTES_PER_TASK,
  materializeWorkspaceResources,
  registerTaskResourcePaths,
  resolveWorkspaceRoot,
} from "../src/tasks/files.js";
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
  const now = new Date().toISOString();

  // --- Create: cheap path validation registers refs ---
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
    assert(task.files?.length === 1, "create: one file ref attached");
    assert(task.files![0].relativePath === "a.ts", "create: relativePath preserved");
    assert(task.workspaceRoot === resolveWorkspaceRoot(), "create: workspace root stored");
  }

  // --- read_file disabled for file tasks (Option C) ---
  {
    const { service } = freshDb(dbDir);
    writeFileSync(join(wsDir, "read.ts"), "content");
    const { taskId } = service.createTask({
      type: "research",
      prompt: "p",
      cursorConversationId: "c1b",
      files: ["read.ts"],
    });
    const task = service.getTask(taskId)!;
    expectFileError(
      () => service.readFile(taskId, task.files![0].fileId),
      "FILE_READ_DISABLED",
      "read_file: disabled for attached files"
    );
  }

  // --- Materialize: happy path ---
  {
    writeFileSync(join(wsDir, "mat.ts"), "export const x = 42;\n");
    const refs = registerTaskResourcePaths(["mat.ts"], now);
    const { resources: prepared } = materializeWorkspaceResources(refs, wsDir);
    assert(prepared.length === 1, "materialize: one prepared resource");
    assert(prepared[0].bytes.toString("utf8") === "export const x = 42;\n", "materialize: bytes match");
    const hash = createHash("sha256").update(prepared[0].bytes).digest("hex");
    assert(prepared[0].sha256 === hash, "materialize: sha256 of bytes");
  }

  // --- Two files materialize independently ---
  {
    writeFileSync(join(wsDir, "b1.ts"), "b1");
    writeFileSync(join(wsDir, "b2.ts"), "b2");
    const refs = registerTaskResourcePaths(["b1.ts", "b2.ts"], now);
    const { resources: prepared } = materializeWorkspaceResources(refs, wsDir);
    assert(prepared.length === 2, "two-file: both materialized");
    const byName = Object.fromEntries(prepared.map((p) => [p.displayName, p.bytes.toString("utf8")]));
    assert(byName["b1.ts"] === "b1", "two-file: b1 content");
    assert(byName["b2.ts"] === "b2", "two-file: b2 content");
  }

  // --- Traversal / absolute reject at create ---
  {
    const { service } = freshDb(dbDir);
    expectFileError(
      () => service.createTask({ type: "research", prompt: "p", cursorConversationId: "c3", files: ["../etc/passwd"] }),
      "FILES_INVALID",
      "reject: traversal at create"
    );
    expectFileError(
      () => service.createTask({ type: "research", prompt: "p", cursorConversationId: "c3", files: ["/etc/hosts"] }),
      "FILES_INVALID",
      "reject: absolute path at create"
    );
  }

  // --- Symlink reject at create (fail fast) ---
  {
    const { service } = freshDb(dbDir);
    const linkPath = join(wsDir, "link.ts");
    try { unlinkSync(linkPath); } catch { /* ignore */ }
    symlinkSync("/etc/hosts", linkPath);
    expectFileError(
      () =>
        service.createTask({
          type: "research",
          prompt: "p",
          cursorConversationId: "c3b",
          files: ["link.ts"],
        }),
      "FILES_INVALID",
      "reject: symlink at create"
    );
  }

  // --- Cross-task fileId on read_file ---
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

  // --- Workspace mutation before dispatch → materialize reads current bytes ---
  {
    const path = join(wsDir, "mut.ts");
    writeFileSync(path, "original");
    const refs = registerTaskResourcePaths(["mut.ts"], now);
    writeFileSync(path, "mutated!!");
    const prepared = materializeWorkspaceResources(refs, wsDir);
    assert(prepared.resources[0].bytes.toString("utf8") === "mutated!!", "dispatch-time: reads current workspace bytes");
  }

  // --- Delete workspace file before dispatch → materialize fails ---
  {
    const path = join(wsDir, "del.ts");
    writeFileSync(path, "gone-soon");
    const refs = registerTaskResourcePaths(["del.ts"], now);
    unlinkSync(path);
    expectFileError(
      () => materializeWorkspaceResources(refs, wsDir),
      "FILES_INVALID",
      "reject: missing file at materialize"
    );
  }

  // --- Secret filenames at create ---
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

  // --- Duplicate basename at create ---
  {
    const { service } = freshDb(dbDir);
    mkdirSync(join(wsDir, "src"), { recursive: true });
    mkdirSync(join(wsDir, "tests"), { recursive: true });
    writeFileSync(join(wsDir, "src", "foo.ts"), "src foo");
    writeFileSync(join(wsDir, "tests", "foo.ts"), "tests foo");
    expectFileError(
      () =>
        service.createTask({
          type: "research",
          prompt: "p",
          cursorConversationId: "c7b",
          files: ["src/foo.ts", "tests/foo.ts"],
        }),
      "FILES_DUPLICATE_BASENAME",
      "reject: duplicate display basename"
    );
  }

  // --- Secret content at materialize: redact + disclose (ADR-005 amend) ---
  {
    writeFileSync(join(wsDir, "secret.ts"), "const k = 'sk-123456789012345678901234';\n");
    const refs = registerTaskResourcePaths(["secret.ts"], now);
    const { resources, redaction } = materializeWorkspaceResources(refs, wsDir);
    assert(resources.length === 1, "secret: materialize succeeds");
    assert(
      resources[0].bytes.toString("utf8").includes("[REDACTED]"),
      "secret: sk- redacted in attached bytes"
    );
    assert(!resources[0].bytes.toString("utf8").includes("sk-123456789012345678901234"), "secret: raw key absent");
    assert(redaction?.filesRedacted === true, "secret: disclosure filesRedacted");
    assert((redaction?.redactionCount ?? 0) >= 1, "secret: disclosure count");
    assert(redaction?.detectorIds.includes("sk"), "secret: detector id sk");
  }

  // --- FP: Bearer field prose must not redact ---
  {
    writeFileSync(
      join(wsDir, "arch.md"),
      "Code comment notes no static Bearer field in UI — tunnel may need adjustment.\n"
    );
    const refs = registerTaskResourcePaths(["arch.md"], now);
    const { resources, redaction } = materializeWorkspaceResources(refs, wsDir);
    assert(
      resources[0].bytes.toString("utf8").includes("Bearer field"),
      "fp: Bearer field preserved"
    );
    assert(!redaction, "fp: no redaction disclosure for docs prose");
  }

  // --- NUL / binary at materialize ---
  {
    writeFileSync(join(wsDir, "bin.ts"), Buffer.from([0x00, 0x01, 0x02, 0x74, 0x73]));
    const refs = registerTaskResourcePaths(["bin.ts"], now);
    expectFileError(
      () => materializeWorkspaceResources(refs, wsDir),
      "FILES_INVALID",
      "reject: binary/NUL at materialize"
    );
  }

  // --- many files at create (no count cap) / oversize at materialize ---
  {
    const { service } = freshDb(dbDir);
    const names: string[] = [];
    for (let i = 0; i < 15; i += 1) {
      const name = `many${i}.ts`;
      writeFileSync(join(wsDir, name), `// ${i}`);
      names.push(name);
    }
    const { taskId } = service.createTask({
      type: "research",
      prompt: "p",
      cursorConversationId: "c9-many",
      files: names,
    });
    assert(taskId.length > 0, "accept: many files at create");

    writeFileSync(join(wsDir, "big.ts"), "x".repeat(MAX_BYTES_PER_FILE + 1));
    const bigRefs = registerTaskResourcePaths(["big.ts"], now);
    expectFileError(
      () => materializeWorkspaceResources(bigRefs, wsDir),
      "FILE_TOO_LARGE",
      "reject: per-file oversize at materialize"
    );

    const sumNames: string[] = [];
    const sumChunk = 1024 * 1024;
    const fileCount = Math.ceil(MAX_BYTES_PER_TASK / sumChunk) + 1;
    for (let i = 0; i < fileCount; i += 1) {
      const name = `sum${i}.ts`;
      writeFileSync(join(wsDir, name), "y".repeat(sumChunk));
      sumNames.push(name);
    }
    const sumRefs = registerTaskResourcePaths(sumNames, now);
    expectFileError(
      () => materializeWorkspaceResources(sumRefs, wsDir),
      "FILE_TOO_LARGE",
      "reject: sum exceeds task byte cap at materialize"
    );
  }

  // --- Secret at 64 KiB boundary at materialize: still redacted ---
  {
    const secret = "sk-" + "A".repeat(40);
    const prefixLen = 65536 - 10;
    const content = "x".repeat(prefixLen) + secret + "y".repeat(100);
    writeFileSync(join(wsDir, "boundary.ts"), content);
    const refs = registerTaskResourcePaths(["boundary.ts"], now);
    const { resources, redaction } = materializeWorkspaceResources(refs, wsDir);
    assert(resources[0].bytes.toString("utf8").includes("[REDACTED]"), "boundary: secret redacted");
    assert(!resources[0].bytes.toString("utf8").includes(secret), "boundary: raw secret absent");
    assert(redaction?.detectorIds.includes("sk"), "boundary: detector sk");
  }

  // --- Second materialize after change → different sha256 ---
  {
    const path = join(wsDir, "rehash.ts");
    writeFileSync(path, "v1");
    const refs = registerTaskResourcePaths(["rehash.ts"], now);
    const first = materializeWorkspaceResources(refs, wsDir);
    writeFileSync(path, "v2-longer");
    const second = materializeWorkspaceResources(refs, wsDir);
    assert(first.resources[0].sha256 !== second.resources[0].sha256, "rehash: dispatch-time hash reflects current bytes");
  }

  // --- get_task manifest: no path leakage ---
  {
    const { service } = freshDb(dbDir);
    writeFileSync(join(wsDir, "leak.ts"), "leak-check");
    const { taskId } = service.createTask({ type: "research", prompt: "p", cursorConversationId: "c12", files: ["leak.ts"] });
    const task = service.getTask(taskId)!;
    const serialized = JSON.stringify({
      taskId: task.id,
      files: (task.files ?? []).map((f) => ({
        fileId: f.fileId,
        displayName: f.displayName,
        relativePath: f.relativePath,
      })),
    });
    assert(!serialized.includes(wsDir), "leakage: manifest excludes workspace_root");
    assert(!serialized.includes("snapshot_path"), "leakage: no snapshot_path key");
    assert(!serialized.includes("source_path"), "leakage: no source_path key");

    try {
      service.readFile(taskId, "f_bogus");
      assert(false, "leakage: expected error on bogus fileId");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      assert(!msg.includes(wsDir), "leakage: error message excludes workspace root path");
    }
  }

  // --- relevantFiles only (no files) → no file rows ---
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

  // --- workspaceRoot override beats env ---
  {
    const { service } = freshDb(dbDir);
    writeFileSync(join(wsDir, "override.ts"), "export {};\n");
    const prev = process.env.HANDOFF_WORKSPACE_ROOT;
    process.env.HANDOFF_WORKSPACE_ROOT = join(wsDir, "wrong-root");
    mkdirSync(join(wsDir, "wrong-root"), { recursive: true });
    const { taskId } = service.createTask({
      type: "research",
      prompt: "p",
      cursorConversationId: "c-override",
      files: ["override.ts"],
      workspaceRoot: wsDir,
    });
    process.env.HANDOFF_WORKSPACE_ROOT = prev;
    const task = service.getTask(taskId)!;
    assert(task.workspaceRoot === realpathSync(wsDir), "create: workspaceRoot override stored");
  }

  // --- missing file at create (fail fast) ---
  {
    const { service } = freshDb(dbDir);
    let code = "";
    try {
      service.createTask({
        type: "research",
        prompt: "p",
        cursorConversationId: "c-missing",
        files: ["no-such-file.ts"],
        workspaceRoot: wsDir,
      });
    } catch (err) {
      code = err instanceof HandoffFileError ? err.code : "";
    }
    assert(code === "FILES_INVALID", "create: missing file rejected at create");
  }

  // --- infer workspace root from HANDOFF_DB_PATH when env unset ---
  {
    const prev = process.env.HANDOFF_WORKSPACE_ROOT;
    delete process.env.HANDOFF_WORKSPACE_ROOT;
    process.env.HANDOFF_DB_PATH = join(wsDir, "data", "handoff.sqlite");
    mkdirSync(join(wsDir, "data"), { recursive: true });
    assert(
      resolveWorkspaceRoot() === realpathSync(wsDir),
      "infer: workspace root from HANDOFF_DB_PATH/data parent"
    );
    process.env.HANDOFF_WORKSPACE_ROOT = prev;
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
