import type { ParsedArgs } from "../args.js";
import { loadCliConfig } from "../context.js";
import { startStack } from "../ops/lifecycle.js";

export async function runStart(_args: ParsedArgs): Promise<number> {
  const config = loadCliConfig();
  return startStack(config);
}
