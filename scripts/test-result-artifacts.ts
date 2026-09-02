#!/usr/bin/env npx tsx
/**
 * Result artifact writeback tests (v0.8).
 *   npm run test:result-artifacts
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_BYTES_PER_FILE } from "../src/tasks/files.js";
import {
  readWorkspaceArtifact,
  writeResultArtifacts,
} from "../src/tasks/result-artifacts.js";
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

function expectFileError(fn: () => void, code: string, msg: string): void {
  try {
    fn();
    assert(false, `${msg} (expected throw)`);
  } catch (err) {
    if (err instanceof HandoffFileError) {
      assert(err.code === code, `${msg} (code=${err.code})`);
    } else {
      assert(false, `${msg} (${(err as Error).message})`);
    }
  }
}

function main(): void {
  const ws = mkdtempSync(join(tmpdir(), "handoff-writeback-"));

  try {
    const written = writeResultArtifacts(
      [{ path: "out/hello.txt", content: "hello writeback\n" }],
      ws
    );
    assert(written.length === 1, "write: one artifact");
    assert(written[0].relativePath === "out/hello.txt", "write: path");
    const bytes = readWorkspaceArtifact(ws, "out/hello.txt");
    assert(bytes.toString("utf8") === "hello writeback\n", "write: bytes on disk");

    expectFileError(
      () =>
        writeResultArtifacts(
          [{ path: "out/hello.txt", content: "duplicate\n" }],
          ws
        ),
      "FILES_INVALID",
      "create: reject existing path"
    );

    writeResultArtifacts(
      [
        {
          path: "out/hello.txt",
          content: "overwritten\n",
          mode: "overwrite",
        },
      ],
      ws
    );
    assert(
      readWorkspaceArtifact(ws, "out/hello.txt").toString("utf8") ===
        "overwritten\n",
      "overwrite: replaces file"
    );

    expectFileError(
      () =>
        writeResultArtifacts(
          [{ path: "out/missing.txt", content: "x\n", mode: "overwrite" }],
          ws
        ),
      "FILES_INVALID",
      "overwrite: reject missing target"
    );

    expectFileError(
      () =>
        writeResultArtifacts([{ path: "../escape.txt", content: "x" }], ws),
      "FILES_INVALID",
      "reject: path traversal"
    );

    expectFileError(
      () =>
        writeResultArtifacts(
          [{ path: ".env", content: "SECRET=x\n" }],
          ws
        ),
      "FILES_INVALID",
      "reject: secret filename"
    );

    expectFileError(
      () =>
        writeResultArtifacts(
          [
            {
              path: "big-artifact.txt",
              content: "x".repeat(MAX_BYTES_PER_FILE + 1),
            },
          ],
          ws
        ),
      "FILE_TOO_LARGE",
      "reject: oversize artifact"
    );

    writeFileSync(join(ws, "out/pristine.txt"), "original\n");
    expectFileError(
      () =>
        writeResultArtifacts(
          [
            { path: "out/pristine.txt", content: "mutated\n", mode: "overwrite" },
            { path: ".env", content: "SECRET=x\n" },
          ],
          ws
        ),
      "FILES_INVALID",
      "batch: validation fail leaves prior file unchanged"
    );
    assert(
      readWorkspaceArtifact(ws, "out/pristine.txt").toString("utf8") === "original\n",
      "batch: pristine file unchanged after validation failure"
    );

    writeFileSync(join(ws, "out/orig-a.txt"), "alpha-original\n");
    mkdirSync(join(ws, "out/blocker"), { recursive: true });
    try {
      writeResultArtifacts(
        [
          { path: "out/orig-a.txt", content: "alpha-new\n", mode: "overwrite" },
          { path: "out/blocker", content: "x\n", mode: "overwrite" },
        ],
        ws
      );
      assert(false, "batch: expected commit failure on directory target");
    } catch (err) {
      assert(err instanceof HandoffFileError, "batch: commit failure is HandoffFileError");
    }
    assert(
      readWorkspaceArtifact(ws, "out/orig-a.txt").toString("utf8") ===
        "alpha-original\n",
      "batch: rollback restores file after commit failure"
    );

    const pad = "x".repeat(520 * 1024);
    expectFileError(
      () =>
        writeResultArtifacts(
          [{ path: "out/late-secret.txt", content: `${pad}\nsk-abcdefghijklmnopqrstuvwxyz\n` }],
          ws
        ),
      "FILES_SECRET_DETECTED",
      "reject: secret beyond 512 KiB (full-body scan)"
    );
    assert(
      !(() => {
        try {
          readWorkspaceArtifact(ws, "out/late-secret.txt");
          return true;
        } catch {
          return false;
        }
      })(),
      "secret reject: no file written"
    );
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main();
