/**
 * Unit tests for gptmcp CLI arg schema (no browser).
 *   npx tsx scripts/test-gptmcp-args.ts
 */
import { parseArgs, UsageError } from "../src/cli/args.js";
import { ExitCode } from "../src/cli/exit-codes.js";

let failed = 0;

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    failed += 1;
  } else {
    console.log(`PASS: ${msg}`);
  }
}

function expectUsage(argv: string[], contains: string): void {
  try {
    parseArgs(argv);
    assert(false, `expected UsageError for: ${argv.join(" ")}`);
  } catch (err) {
    assert(err instanceof UsageError, `UsageError for: ${argv.join(" ")}`);
    assert(
      err instanceof UsageError && err.message.includes(contains),
      `message contains "${contains}" for: ${argv.join(" ")}`
    );
    assert(
      err instanceof UsageError && err.exitCode === ExitCode.USAGE,
      `exit 2 for: ${argv.join(" ")}`
    );
  }
}

const status = parseArgs(["status", "--json"]);
assert(status.command === "status", "status command");
assert(status.json === true, "status --json");
assert(status.positional.length === 1, "status arity");

const logs = parseArgs(["logs", "--follow", "--since", "10m", "--errors"]);
assert(logs.flags.has("follow"), "logs --follow");
assert(logs.options.get("since") === "10m", "logs --since");
assert(logs.flags.has("errors"), "logs --errors");

const noColor = parseArgs(["status", "--no-color"]);
assert(noColor.noColor === true, "--no-color");

expectUsage(["status", "--jsno"], "Did you mean");
expectUsage(["logs", "--since", "banana"], "Invalid --since");
expectUsage(["worker", "rotate"], "Usage: gptmcp worker rotate");
expectUsage(["nope"], "Unknown command");

const worker = parseArgs(["worker", "inspect", "w1", "--json"]);
assert(worker.positional[1] === "inspect", "worker inspect");
assert(worker.positional[2] === "w1", "worker id");
assert(worker.json === true, "worker --json");

if (failed) {
  console.error(`\n${failed} failure(s)`);
  process.exit(1);
}
console.log("\nAll gptmcp arg tests passed.");
