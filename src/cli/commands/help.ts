import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ParsedArgs } from "../args.js";
import { hasFlag } from "../args.js";
import { ExitCode } from "../exit-codes.js";
import { TOP_COMMANDS, WORKER_COMMANDS } from "../metadata.js";
import { openExternal } from "../open-external.js";
import { blank, heading, style, VERSION } from "../terminal.js";

function renderGuideHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>GPTMCP CLI Guide</title>
  <style>
    body { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; background: #0d1117; color: #e6edf3; margin: 2rem; max-width: 900px; }
    h1 { font-size: 1.4rem; }
    h2 { font-size: 0.85rem; color: #8b949e; text-transform: uppercase; margin-top: 2rem; }
    .flow { border: 1px solid #30363d; border-radius: 8px; padding: 1rem 1.25rem; background: #161b22; margin: 0.75rem 0; }
    .flow code { color: #58a6ff; }
    .flow p { margin: 0.35rem 0 0; color: #c9d1d9; font-size: 0.9rem; }
    .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 0.75rem; margin-top: 1rem; }
    .card { border: 1px solid #30363d; border-radius: 8px; padding: 0.85rem; background: #161b22; }
    .card h3 { margin: 0 0 0.4rem; font-size: 0.7rem; color: #8b949e; text-transform: uppercase; }
    .card code { display: block; font-size: 0.95rem; color: #58a6ff; margin-bottom: 0.35rem; }
    .card p { margin: 0; color: #c9d1d9; font-size: 0.85rem; }
    footer { margin-top: 2rem; color: #8b949e; font-size: 0.85rem; }
  </style>
</head>
<body>
  <h1>ChatGPT MCP Command Guide</h1>
  <p>Generated from CLI metadata — v${VERSION}</p>

  <h2>Quick start</h2>
  <div class="flow"><code>gptmcp start</code><p>Start the full stack</p></div>
  <div class="flow"><code>gptmcp open</code><p>Open the ops dashboard</p></div>

  <h2>Something broke?</h2>
  <div class="flow"><code>gptmcp status</code><p>What is happening?</p></div>
  <div class="flow"><code>gptmcp doctor</code><p>Why is it happening?</p></div>
  <div class="flow"><code>gptmcp recover</code><p>Fix it</p></div>

  <h2>Workers</h2>
  <div class="grid">
    ${WORKER_COMMANDS.map(
      (c) =>
        `<section class="card"><h3>Workers</h3><code>${c.examples?.[0] ?? `gptmcp worker ${c.name}`}</code><p>${c.summary}</p></section>`
    ).join("\n")}
  </div>

  <h2>All commands</h2>
  <div class="grid">
    ${TOP_COMMANDS.filter((c) => c.name !== "help")
      .map(
        (c) =>
          `<section class="card"><h3>${c.category}</h3><code>${c.examples?.[0] ?? `gptmcp ${c.name}`}</code><p>${c.summary}</p></section>`
      )
      .join("\n")}
  </div>

  <footer>Observe → Diagnose → Repair · schema-driven help</footer>
</body>
</html>`;
}

export function runHelp(args: ParsedArgs): number {
  const cmd = args.positional[0] === "help" ? args.positional[1] : args.positional[0];

  if (hasFlag(args, "web")) {
    const dir = mkdtempSync(join(tmpdir(), "gptmcp-guide-"));
    const file = join(dir, "commands.html");
    writeFileSync(file, renderGuideHtml(), "utf-8");
    if (!openExternal(file)) {
      console.error(`Could not open browser. File: ${file}`);
      console.log(file);
      return ExitCode.FAIL;
    }
    console.log(file);
    return ExitCode.OK;
  }

  if (cmd && cmd !== "help") {
    const meta = TOP_COMMANDS.find((c) => c.name === cmd);
    if (!meta) {
      console.error(`Unknown command: ${cmd}`);
      return ExitCode.USAGE;
    }
    heading(`gptmcp ${meta.name}`);
    blank();
    console.log(meta.summary);
    if (meta.options && Object.keys(meta.options).length) {
      blank();
      console.log("Options:");
      for (const [name, opt] of Object.entries(meta.options)) {
        const short = opt.short ? `-${opt.short}, ` : "";
        console.log(
          `  ${short}--${name.padEnd(14)} ${opt.description ?? opt.type}`
        );
      }
    }
    if (meta.examples?.length) {
      blank();
      console.log("Examples:");
      for (const ex of meta.examples) console.log(`  ${ex}`);
    }
    return ExitCode.OK;
  }

  heading(`GPTMCP CLI v${VERSION}`);
  blank();
  console.log("Usage:");
  console.log("  gptmcp <command>");
  blank();
  console.log("Commands:");
  for (const c of TOP_COMMANDS) {
    console.log(`  ${style(c.name.padEnd(10), "cyan")} ${c.summary}`);
  }
  blank();
  console.log("Workflow:");
  console.log("  gptmcp status   →  what is happening?");
  console.log("  gptmcp doctor   →  why?");
  console.log("  gptmcp recover  →  fix it");
  blank();
  console.log("Examples:");
  console.log("  gptmcp start");
  console.log("  gptmcp status --json");
  console.log("  gptmcp logs --follow");
  console.log("  gptmcp open");
  blank();
  console.log(style("More: gptmcp help --web", "dim"));
  return ExitCode.OK;
}
