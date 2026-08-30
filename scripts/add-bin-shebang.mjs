#!/usr/bin/env node
import { readFileSync, writeFileSync, chmodSync } from "node:fs";

for (const target of ["dist/index.js", "dist/gptmcp.js"]) {
  let source = readFileSync(target, "utf8");
  if (!source.startsWith("#!")) {
    writeFileSync(target, `#!/usr/bin/env node\n${source}`);
  }
  chmodSync(target, 0o755);
}
