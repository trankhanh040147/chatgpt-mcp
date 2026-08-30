#!/usr/bin/env npx tsx
/**
 * Attachment multiset matcher tests (v0.6 Phase B).
 *   npm run test:attachment-match
 */
import {
  multisetDifference,
  multisetEqual,
  multisetFromNames,
  normalizeChipName,
  verifyAddedChipsMatchExpected,
} from "../src/browser/attachment-match.js";

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

  // --- truncation case: chip shows truncated name ---
  {
    const long = "very-long-module-name-for-truncation.ts";
    const truncated = "very-long-module…";
    const r = verifyAddedChipsMatchExpected([], [truncated], [long]);
    assert(r.ok === false, "verify: truncated chip != full displayName");
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main();
