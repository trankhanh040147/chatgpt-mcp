import type { ParsedArgs } from "../args.js";
import { ExitCode } from "../exit-codes.js";
import { dashboardUrl, loadCliConfig } from "../context.js";
import { openExternal } from "../open-external.js";

export function runOpen(_args: ParsedArgs): number {
  const config = loadCliConfig();
  const url = dashboardUrl(config);
  if (!openExternal(url)) {
    console.error(`Could not open browser. URL: ${url}`);
    console.log(url);
    return ExitCode.FAIL;
  }
  console.log(url);
  return ExitCode.OK;
}
