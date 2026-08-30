import type { ParsedArgs } from "../args.js";
import { loadCliConfig } from "../context.js";
import { stopStack } from "../ops/lifecycle.js";

export async function runStop(_args: ParsedArgs): Promise<number> {
  const config = loadCliConfig();
  return stopStack(config);
}
