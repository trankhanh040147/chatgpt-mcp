#!/usr/bin/env npx tsx
/**
 * Attachment multiset matcher tests (v0.6 Phase B).
 *   npm run test:attachment-match
 */
import {
  CHATGPT_DOM_CHIP_CAP,
  composerChipLabelToDisplayName,
  multisetDifference,
  multisetEqual,
  multisetFromNames,
  normalizeChipName,
  stripChatGptCollisionSuffix,
  verifyAddedChipsMatchExpected,
} from "../src/browser/attachment-match.js";
import {
  computeUploadWaitMs,
  UPLOAD_WAIT_BASE_MS,
  UPLOAD_WAIT_MAX_MS,
  UPLOAD_WAIT_PER_FILE_MS,
} from "../src/browser/composer-attach.js";

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

function main() {
  // --- normalize ---
  assert(normalizeChipName(" Foo.TS ") === "foo.ts", "normalize: trim + lower");

  // --- multiset equal ---
  const a = multisetFromNames(["a.ts", "b.ts", "a.ts"]);
  const b = multisetFromNames(["A.ts", "b.ts", "a.ts"]);
  assert(multisetEqual(a, b), "multiset: case-insensitive equal");

  const c = multisetFromNames(["a.ts", "b.ts"]);
  assert(!multisetEqual(a, c), "multiset: different counts");

  // --- added-chip verify: happy ---
  {
    const r = verifyAddedChipsMatchExpected(
      ["old.ts"],
      ["old.ts", "a.ts", "b.ts"],
      ["a.ts", "b.ts"]
    );
    assert(r.ok === true, "verify: added matches expected");
  }

  // --- stale chip must not satisfy new expected (review P0) ---
  {
    const r = verifyAddedChipsMatchExpected(
      ["auth.ts"],
      ["auth.ts", "token.ts"],
      ["auth.ts", "token.ts"]
    );
    assert(r.ok === false, "verify: stale auth.ts does not count as added");
    if (!r.ok) {
      assert(r.added.includes("token.ts"), "verify: only token.ts was added");
    }
  }

  // --- duplicate basename in chips ---
  {
    const r = verifyAddedChipsMatchExpected(
      [],
      ["foo.ts", "foo.ts"],
      ["foo.ts"]
    );
    assert(r.ok === false, "verify: duplicate chips != single expected");
  }

  // --- multiset difference ---
  {
    const added = multisetDifference(
      ["x.ts", "y.ts"],
      ["x.ts", "y.ts", "z.ts", "z.ts"]
    );
    assert(added.filter((n) => n === "z.ts").length === 2, "diff: two z.ts added");
  }

  // --- ChatGPT numbered buffer-upload chips ---
  {
    const r = verifyAddedChipsMatchExpected(
      [],
      ["file 1: a.ts", "file 2: b.ts"],
      ["a.ts", "b.ts"]
    );
    assert(r.ok === true, "verify: numbered file chips match displayName");
  }

  assert(
    composerChipLabelToDisplayName("file 1: a.ts") === "a.ts",
    "normalize: strip numbered prefix"
  );

  assert(
    stripChatGptCollisionSuffix("restart(1).ts") === "restart.ts",
    "normalize: strip ChatGPT collision suffix"
  );
  assert(
    normalizeChipName("composer-attach(5).ts") === "composer-attach.ts",
    "normalize: collision suffix + lower"
  );
  {
    const r = verifyAddedChipsMatchExpected(
      [],
      ["restart(1).ts", "args.ts"],
      ["restart.ts", "args.ts"]
    );
    assert(r.ok === true, "verify: collision-renamed chips match expected");
  }

  // --- large batch: DOM cap ~20 chips ---
  {
    const expected = Array.from({ length: 72 }, (_, i) => `file-${i}.ts`);
    const visible = expected.slice(0, CHATGPT_DOM_CHIP_CAP);
    const r = verifyAddedChipsMatchExpected([], visible, expected);
    assert(r.ok === true && r.mode === "large_batch_subset", "verify: large batch subset ok");
  }
  {
    const expected = Array.from({ length: 72 }, (_, i) => `file-${i}.ts`);
    const visible = expected.slice(0, CHATGPT_DOM_CHIP_CAP - 1);
    const r = verifyAddedChipsMatchExpected([], visible, expected);
    assert(r.ok === false, "verify: large batch fails below DOM cap");
  }
  {
    const expected = Array.from({ length: 72 }, (_, i) => `file-${i}.ts`);
    const visible = [...expected.slice(0, CHATGPT_DOM_CHIP_CAP - 1), "orphan.ts"];
    const r = verifyAddedChipsMatchExpected([], visible, expected);
    assert(r.ok === false, "verify: large batch fails on unknown chip");
  }

  {
    const long = "very-long-module-name-for-truncation.ts";
    const truncated = "very-long-module…";
    const r = verifyAddedChipsMatchExpected([], [truncated], [long]);
    assert(r.ok === false, "verify: truncated chip != full displayName");
  }

  // --- scaled upload wait ---
  assert(computeUploadWaitMs(0) === 0, "upload wait: zero files");
  assert(
    computeUploadWaitMs(10) === UPLOAD_WAIT_BASE_MS + 10 * UPLOAD_WAIT_PER_FILE_MS,
    "upload wait: scales per file"
  );
  assert(
    computeUploadWaitMs(72) === UPLOAD_WAIT_BASE_MS + 72 * UPLOAD_WAIT_PER_FILE_MS,
    "upload wait: 72-file batch"
  );
  assert(computeUploadWaitMs(500) === UPLOAD_WAIT_MAX_MS, "upload wait: capped at max");

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main();
