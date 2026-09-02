#!/usr/bin/env npx tsx
/**
 * MCP writeback contract tests (v0.8 Phase 3).
 *   npm run test:writeback-contract
 */
import {
  SUBMIT_RESULT_TOOL_DESCRIPTION,
  WRITEBACK_POLICY,
} from "../src/mcp/worker-policy.js";
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

function main(): void {
  const policyText = JSON.stringify(WRITEBACK_POLICY);
  assert(
    WRITEBACK_POLICY.whenToWrite.some((line) =>
      line.includes("complete final file content")
    ),
    "policy: complete final content rule"
  );
  assert(
    WRITEBACK_POLICY.onRejection.some((line) =>
      line.toLowerCase().includes("do not automatically switch to overwrite")
    ),
    "policy: create collision must not auto overwrite"
  );
  assert(
    !policyText.includes("10 files") && !policyText.includes("max 10"),
    "policy: no stale 10-file limit"
  );

  assert(
    SUBMIT_RESULT_TOOL_DESCRIPTION.includes("20 artifacts"),
    "tool description: 20 artifacts"
  );
  assert(
    SUBMIT_RESULT_TOOL_DESCRIPTION.includes("32 MiB"),
    "tool description: 32 MiB per file"
  );
  assert(
    SUBMIT_RESULT_TOOL_DESCRIPTION.includes("128 MiB"),
    "tool description: 128 MiB total"
  );
  assert(
    !SUBMIT_RESULT_TOOL_DESCRIPTION.includes("10 files"),
    "tool description: no stale 10-file limit"
  );
  assert(
    SUBMIT_RESULT_TOOL_DESCRIPTION.includes("complete final content") ||
      SUBMIT_RESULT_TOOL_DESCRIPTION.includes("complete file contents"),
    "tool description: complete content requirement"
  );

  const err = new HandoffFileError(
    "FILES_INVALID",
    "Create target already exists (src/foo.ts)"
  );
  assert(err.code === "FILES_INVALID", "HandoffFileError: code preserved");
  assert(
    err.message.includes("src/foo.ts"),
    "HandoffFileError: safe path in message"
  );
  assert(
    !err.message.includes("sk-"),
    "HandoffFileError: no secret leakage in message shape test"
  );

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main();
