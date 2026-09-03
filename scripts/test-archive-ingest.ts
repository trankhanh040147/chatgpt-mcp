/**
 * Archive ingest + XOR submit tests (no live CDP).
 * Run: npm run test:archive-ingest
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initDatabase, getDatabase } from "../src/db/sqlite.js";
import { TaskRepository } from "../src/tasks/task.repository.js";
import { TaskService } from "../src/tasks/task.service.js";
import {
  ArchiveError,
  compressTarZstd,
  encodeCanonicalBase64,
  ingestArchiveWriteback,
  packTarPax,
} from "../src/archive/index.js";

let passed = 0;
function ok(name: string) {
  passed += 1;
  console.log(`ok - ${name}`);
}

const root = mkdtempSync(join(tmpdir(), "archive-ingest-"));
const dbPath = join(root, "handoff.sqlite");
const ws = join(root, "ws");
mkdirSync(ws, { recursive: true });
process.env.HANDOFF_DB_PATH = dbPath;
process.env.HANDOFF_WORKSPACE_ROOT = ws;

initDatabase(dbPath);
const service = new TaskService(new TaskRepository(getDatabase()));

{
  const tar = packTarPax([
    { relativePath: "out/a.ts", bytes: Buffer.from("export const a=1;\n") },
    { relativePath: "out/b.ts", bytes: Buffer.from("export const b=2;\n") },
  ]);
  const data = encodeCanonicalBase64(compressTarZstd(tar));
  const written = ingestArchiveWriteback(
    { format: "tar.zst", encoding: "base64", data },
    ws
  );
  assert.equal(written.artifacts.length, 2);
  assert.equal(readFileSync(join(ws, "out/a.ts"), "utf8"), "export const a=1;\n");
  ok("ingest writes members");
}

{
  writeFileSync(join(ws, "out/a.ts"), "OLD");
  const tar = packTarPax([
    { relativePath: "out/a.ts", bytes: Buffer.from("NEW\n") },
  ]);
  const data = encodeCanonicalBase64(compressTarZstd(tar));
  ingestArchiveWriteback({ format: "tar.zst", encoding: "base64", data }, ws);
  assert.equal(readFileSync(join(ws, "out/a.ts"), "utf8"), "NEW\n");
  ok("ingest upsert overwrite");
}

{
  const { taskId } = service.createTask({
    type: "research",
    prompt: "p",
    cursorConversationId: "sess",
  });
  const db = getDatabase();
  db.prepare(
    `UPDATE handoff_tasks SET status='PROCESSING', dispatch_started_at=?, lease_owner=?, lease_token=? WHERE id=?`
  ).run(new Date().toISOString(), "w-archive-xor", "tok-xor", taskId);

  const tar = packTarPax([
    { relativePath: "via-submit.ts", bytes: Buffer.from("ok\n") },
  ]);
  const data = encodeCanonicalBase64(compressTarZstd(tar));
  try {
    service.submitResult({
      taskId,
      result: "done",
      artifacts: [{ path: "x.ts", content: "x", mode: "create" }],
      archive: { format: "tar.zst", encoding: "base64", data },
    });
    assert.fail("expected XOR error");
  } catch (err) {
    assert.ok(err instanceof ArchiveError);
    assert.equal(err.code, "ARCHIVE_WITH_ARTIFACTS");
    ok("submitResult XOR archive+artifacts");
  }
}

{
  const { taskId } = service.createTask({
    type: "research",
    prompt: "p2",
    cursorConversationId: "sess2",
  });
  const db = getDatabase();
  db.prepare(
    `UPDATE handoff_tasks SET status='PROCESSING', dispatch_started_at=?, lease_owner=?, lease_token=? WHERE id=?`
  ).run(new Date().toISOString(), "w-archive-ok", "tok-ok", taskId);

  const tar = packTarPax([
    { relativePath: "from-archive.ts", bytes: Buffer.from("archived\n") },
  ]);
  const data = encodeCanonicalBase64(compressTarZstd(tar));
  const out = service.submitResult({
    taskId,
    result: "archive ok",
    archive: { format: "tar.zst", encoding: "base64", data },
  });
  assert.equal(out.status, "COMPLETED");
  assert.equal(readFileSync(join(ws, "from-archive.ts"), "utf8"), "archived\n");
  ok("submitResult archive happy path");
}

rmSync(root, { recursive: true, force: true });
console.log(`\n${passed} tests passed`);
