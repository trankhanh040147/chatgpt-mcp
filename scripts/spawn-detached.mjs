#!/usr/bin/env node
import { openSync } from "node:fs";
import { spawn } from "node:child_process";

const [logfile, command, ...args] = process.argv.slice(2);
if (!logfile || !command) {
  console.error("Usage: node scripts/spawn-detached.mjs <logfile> <command> [args...]");
  process.exit(2);
}

const fd = openSync(logfile, "a");
const child = spawn(command, args, {
  cwd: process.cwd(),
  env: process.env,
  detached: true,
  stdio: ["ignore", fd, fd],
});
child.unref();
if (!child.pid) {
  console.error(`Failed to spawn ${command}`);
  process.exit(1);
}
process.stdout.write(String(child.pid));
