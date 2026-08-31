import {
  GLOBAL_OPTIONS,
  TOP_COMMANDS,
  WORKER_COMMANDS,
  type CommandMeta,
  type OptionMeta,
} from "./metadata.js";
import { ExitCode } from "./exit-codes.js";
import { setForceNoColor } from "./terminal.js";

export interface ParsedArgs {
  command: string | null;
  /** Full positional list including the top-level command when present. */
  positional: string[];
  flags: Set<string>;
  options: Map<string, string>;
  json: boolean;
  help: boolean;
  noColor: boolean;
}

export class UsageError extends Error {
  readonly exitCode = ExitCode.USAGE;
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

function mergeOptions(
  ...maps: Array<Record<string, OptionMeta> | undefined>
): Record<string, OptionMeta> {
  const out: Record<string, OptionMeta> = { ...GLOBAL_OPTIONS };
  for (const m of maps) {
    if (m) Object.assign(out, m);
  }
  return out;
}

function shortToLong(schema: Record<string, OptionMeta>): Map<string, string> {
  const map = new Map<string, string>();
  for (const [long, meta] of Object.entries(schema)) {
    if (meta.short) map.set(meta.short, long);
  }
  return map;
}

function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () =>
    Array(n + 1).fill(0)
  );
  for (let i = 0; i <= m; i++) dp[i]![0] = i;
  for (let j = 0; j <= n; j++) dp[0]![j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i]![j] = Math.min(
        dp[i - 1]![j]! + 1,
        dp[i]![j - 1]! + 1,
        dp[i - 1]![j - 1]! + cost
      );
    }
  }
  return dp[m]![n]!;
}

function suggestOption(unknown: string, known: string[]): string | undefined {
  const needle = unknown.replace(/^--?/, "");
  let best: string | undefined;
  let bestDist = Infinity;
  for (const k of known) {
    const d = levenshtein(needle, k);
    if (d < bestDist && d <= 2) {
      bestDist = d;
      best = k;
    }
  }
  return best;
}

function unknownOptionError(
  flag: string,
  known: string[],
  command: string | null
): UsageError {
  const suggestion = suggestOption(
    flag,
    known.filter((k) => !k.startsWith("\0"))
  );
  const lines = [`Unknown option: ${flag}`];
  if (suggestion) {
    lines.push("", "Did you mean:", `  --${suggestion}`);
  }
  lines.push("", `Run: gptmcp ${command ?? "help"} --help`);
  return new UsageError(lines.join("\n"));
}

function isValidSince(raw: string): boolean {
  return /^\d+(m|h|s)?$/i.test(raw.trim());
}

/** Peek first positional (command) without consuming options. */
function peekCommand(argv: string[]): string | null {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--") {
      return argv[i + 1] ?? null;
    }
    if (arg.startsWith("-")) {
      if (arg.startsWith("--")) {
        const name = arg.includes("=") ? arg.slice(2, arg.indexOf("=")) : arg.slice(2);
        // Unknown yet — skip a following value only for known string globals later.
        // Conservatively: if next doesn't look like an option and this isn't a
        // bare boolean we know globally, still skip nothing here; full parse handles it.
        void name;
      }
      continue;
    }
    return arg;
  }
  return null;
}

function resolveSchema(command: string | null, argv: string[]): {
  schema: Record<string, OptionMeta>;
  maxPos: number;
  meta?: CommandMeta;
} {
  if (!command) {
    return { schema: { ...GLOBAL_OPTIONS }, maxPos: 0 };
  }
  if (command === "help") {
    const meta = TOP_COMMANDS.find((c) => c.name === "help")!;
    return {
      schema: mergeOptions(meta.options),
      maxPos: meta.maxPositionals ?? 1,
      meta,
    };
  }
  const meta = TOP_COMMANDS.find((c) => c.name === command);
  if (!meta) {
    throw new UsageError(`Unknown command: ${command}\n\nRun: gptmcp help`);
  }

  // Peek worker subcommand from argv positionals.
  let subName: string | undefined;
  let seenCmd = false;
  for (const arg of argv) {
    if (arg === "--") break;
    if (arg.startsWith("-")) continue;
    if (!seenCmd) {
      seenCmd = true;
      continue;
    }
    subName = arg;
    break;
  }

  if (command === "worker" && subName) {
    const sub = WORKER_COMMANDS.find((c) => c.name === subName);
    if (!sub) {
      throw new UsageError(
        `Unknown worker command: ${subName}\n\nRun: gptmcp worker --help`
      );
    }
    return {
      schema: mergeOptions(meta.options, sub.options),
      maxPos: 1 + (sub.maxPositionals ?? 0),
      meta,
    };
  }

  return {
    schema: mergeOptions(meta.options),
    maxPos: meta.maxPositionals ?? 0,
    meta,
  };
}

/**
 * Strict argv parser driven by command metadata.
 * Unknown options / wrong arity → UsageError (exit 2).
 */
export function parseArgs(argv: string[]): ParsedArgs {
  const command = peekCommand(argv);
  const { schema, maxPos } = resolveSchema(command, argv);
  const shorts = shortToLong(schema);

  const positional: string[] = [];
  const flags = new Set<string>();
  const options = new Map<string, string>();

  let i = 0;
  while (i < argv.length) {
    const arg = argv[i]!;
    if (arg === "--") {
      positional.push(...argv.slice(i + 1));
      break;
    }

    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      const long = eq >= 0 ? arg.slice(2, eq) : arg.slice(2);
      const inline = eq >= 0 ? arg.slice(eq + 1) : undefined;
      const optMeta = schema[long];
      if (!optMeta) {
        throw unknownOptionError(`--${long}`, Object.keys(schema), command);
      }
      if (optMeta.type === "boolean") {
        if (inline !== undefined && inline !== "" && inline !== "true") {
          throw new UsageError(`Option --${long} does not take a value`);
        }
        flags.add(long);
        i++;
        continue;
      }
      const value =
        inline !== undefined
          ? inline
          : argv[i + 1] && !argv[i + 1]!.startsWith("-")
            ? argv[++i]
            : undefined;
      if (!value) {
        throw new UsageError(
          `Option --${long} requires a value\n\nRun: gptmcp ${command ?? "help"} --help`
        );
      }
      if (long === "since" && !isValidSince(value)) {
        throw new UsageError(
          `Invalid --since value: ${value}\n\nExpected duration like 10m, 1h, or 30s`
        );
      }
      options.set(long, value);
      i++;
      continue;
    }

    if (arg.startsWith("-") && arg.length > 1) {
      for (const ch of arg.slice(1)) {
        const long = shorts.get(ch);
        if (!long) {
          throw unknownOptionError(`-${ch}`, Object.keys(schema), command);
        }
        const optMeta = schema[long]!;
        if (optMeta.type === "boolean") {
          flags.add(long);
        } else {
          const value = argv[i + 1] && !argv[i + 1]!.startsWith("-") ? argv[++i] : undefined;
          if (!value) {
            throw new UsageError(`Option -${ch}/--${long} requires a value`);
          }
          options.set(long, value);
        }
      }
      i++;
      continue;
    }

    positional.push(arg);
    i++;
  }

  const rest = command ? positional.slice(1) : positional;
  if (rest.length > maxPos) {
    throw new UsageError(
      `Too many arguments for gptmcp ${command ?? ""}\n\nRun: gptmcp ${command ?? "help"} --help`
    );
  }

  if (command === "worker") {
    const sub = rest[0];
    if (
      sub === "inspect" ||
      sub === "rotate" ||
      sub === "enable" ||
      sub === "disable"
    ) {
      if (!rest[1]) {
        throw new UsageError(
          `Usage: gptmcp worker ${sub} <id>\n\nRun: gptmcp worker --help`
        );
      }
    }
  }

  const noColor = flags.has("no-color");
  if (noColor) setForceNoColor(true);

  return {
    command,
    positional,
    flags,
    options,
    json: flags.has("json"),
    help: flags.has("help") || command === "help",
    noColor,
  };
}

export function hasFlag(args: ParsedArgs, name: string): boolean {
  return args.flags.has(name);
}

export function option(args: ParsedArgs, name: string): string | undefined {
  return args.options.get(name);
}

export function wantsJson(args: ParsedArgs): boolean {
  return args.json;
}

export function wantsHelp(args: ParsedArgs): boolean {
  return args.help;
}
