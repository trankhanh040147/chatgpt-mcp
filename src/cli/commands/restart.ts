import type { ParsedArgs } from "../args.js";
import { loadCliConfig } from "../context.js";
import { restartStack } from "../ops/lifecycle.js";

export async function runRestart(_args: ParsedArgs): Promise<number> {
  const config = loadCliConfig();
  return restartStack(config);
}
