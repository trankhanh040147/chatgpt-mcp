#!/usr/bin/env npx tsx
import { printSetupReport, runSetup } from "../src/setup/run-setup.js";

const report = runSetup({
  home: process.env.CHATGPT_MCP_HOME,
  projectEnv: true,
});
printSetupReport(report);
