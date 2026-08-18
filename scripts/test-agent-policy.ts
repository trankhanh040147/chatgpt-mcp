#!/usr/bin/env npx tsx
/**
 * Static consistency checks for 0.5 agent handoff policy (rule + skill + scenarios).
 *   npm run test:agent-policy
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const root = process.cwd();

const SCENARIOS_REL =
  ".planning/2026-08-18-roadmap-0.5-agent-ux-rotation/scenarios-agent-ux.md";

const files = {
  rule: resolve(root, ".cursor/rules/chatgpt-mcp.mdc"),
  skill: resolve(root, ".cursor/skills/chatgpt-mcp/SKILL.md"),
  scenarios: resolve(root, SCENARIOS_REL),
};

let passed = 0;
let failed = 0;

function assert(cond: unknown, msg: string): void {
  if (!cond) {
    failed += 1;
    console.error(`FAIL: ${msg}`);
  } else {
    passed += 1;
    console.log(`ok — ${msg}`);
  }
}

function mustContain(hay: string, needles: string[], label: string): void {
  for (const n of needles) {
    assert(hay.includes(n), `${label} contains ${JSON.stringify(n)}`);
  }
}

function mustNotMatch(hay: string, re: RegExp, label: string, msg: string): void {
  assert(!re.test(hay), `${label} ${msg}`);
}

function main(): void {
  for (const [name, path] of Object.entries(files)) {
    assert(existsSync(path), `${name} exists: ${path}`);
  }

  const rule = readFileSync(files.rule, "utf8");
  const skill = readFileSync(files.skill, "utf8");
  const scenarios = readFileSync(files.scenarios, "utf8");

  mustContain(rule, ["Light", "Standard", "Deep"], "rule");
  mustContain(skill, ["Light", "Standard", "Deep"], "skill");

  const sharedInvariants = [
    "at most **one**",
    "same decision",
    "continue locally or ask the user",
    "Do not** immediately create another handoff",
    "one bundled",
    "substantially same unresolved issue",
    "Light must not call MCP",
    "handoff_create_task",
    "at most 1",
    "Deep changes reasoning depth, not handoff count",
    SCENARIOS_REL,
  ];
  mustContain(rule, sharedInvariants, "rule");
  mustContain(skill, sharedInvariants, "skill");

  assert(
    rule.includes("bounded user/engineering choice"),
    "rule defines decision"
  );
  assert(
    skill.includes("bounded user/engineering choice"),
    "skill defines decision"
  );

  mustNotMatch(
    rule,
    /\balways hand off\b/i,
    "rule",
    "must not say always hand off"
  );
  mustNotMatch(
    skill,
    /\balways hand off\b/i,
    "skill",
    "must not say always hand off"
  );
  mustNotMatch(
    rule,
    /\bmust hand off\b/i,
    "rule",
    "must not say must hand off"
  );
  mustNotMatch(
    skill,
    /\bmust hand off\b/i,
    "skill",
    "must not say must hand off"
  );

  for (const n of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]) {
    assert(scenarios.includes(`| ${n} |`), `scenarios has case ${n}`);
  }
  assert(
    scenarios.includes("**1 total**") && scenarios.includes("no immediate re-handoff"),
    "scenarios case 11: insufficient first handoff still 1 total"
  );
  assert(
    scenarios.includes("bundled handoff"),
    "scenarios case 12: bundled subquestions still 1 total"
  );

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main();
