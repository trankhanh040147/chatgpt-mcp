import type { ParsedArgs } from "../args.js";
import { option, hasFlag } from "../args.js";
import { ExitCode } from "../exit-codes.js";
import { printSetupReport, runSetup } from "../../setup/run-setup.js";

export function runSetupCommand(args: ParsedArgs): number {
  const report = runSetup({
    home: option(args, "home"),
    projectEnv: false,
  });
  if (hasFlag(args, "json")) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    printSetupReport(report);
    console.log("");
    console.log("Project .env was not modified by gptmcp setup.");
  }
  return ExitCode.OK;
}
