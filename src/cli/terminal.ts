import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const pkg = require("../../package.json") as { version?: string };

export const VERSION = pkg.version ?? "0.0.0";

let forceNoColor = false;

export function setForceNoColor(value: boolean): void {
  forceNoColor = value;
}

/** True when stdout is a TTY (does not consider color env). */
export function isTTY(): boolean {
  return Boolean(process.stdout.isTTY);
}

/**
 * Whether ANSI color should be used.
 * Off when: non-TTY, NO_COLOR, GPTMCP_NO_COLOR, TERM=dumb, --no-color.
 */
export function useColor(): boolean {
  if (forceNoColor) return false;
  if (!isTTY()) return false;
  if (process.env.NO_COLOR !== undefined && process.env.NO_COLOR !== "") {
    return false;
  }
  if (process.env.GPTMCP_NO_COLOR === "1") return false;
  if ((process.env.TERM ?? "").toLowerCase() === "dumb") return false;
  return true;
}

type Style = "dim" | "bold" | "cyan" | "green" | "yellow" | "red";

const ANSI: Record<Style, string> = {
  dim: "\x1b[2m",
  bold: "\x1b[1m",
  cyan: "\x1b[36m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
};

export function style(text: string, ...styles: Style[]): string {
  if (!useColor()) return text;
  const open = styles.map((s) => ANSI[s]).join("");
  return `${open}${text}\x1b[0m`;
}

export function statusDot(ok: boolean | "warn"): string {
  if (!useColor()) {
    return ok === true ? "OK" : ok === "warn" ? "WARN" : "DOWN";
  }
  if (ok === true) return style("●", "green");
  if (ok === "warn") return style("●", "yellow");
  return style("○", "dim");
}

export function okMark(): string {
  return useColor() ? style("✓", "green") : "OK";
}

export function warnMark(): string {
  return useColor() ? style("!", "yellow") : "!";
}

export function errMark(): string {
  return useColor() ? style("✗", "red") : "ERR";
}

export function heading(title: string): void {
  console.log(style(title, "bold"));
}

export function blank(): void {
  console.log("");
}

export function kv(label: string, value: string, width = 22): void {
  console.log(`  ${label.padEnd(width)} ${value}`);
}

/** Machine API: stdout is JSON only. Never mix human progress on stdout. */
export function writeJson(data: unknown): void {
  process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
}

export function formatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toTimeString().slice(0, 8);
}
