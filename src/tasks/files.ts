import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import { ulid } from "ulid";
import { containsKnownSecrets } from "./sanitize.js";
import {
  HandoffFileError,
  type PreparedResource,
  type TaskResource,
} from "./task.types.js";

/** Per-file cap (materialize + native attach). */
export const MAX_BYTES_PER_FILE = 32 * 1024 * 1024;
/** Total bytes across all files in one task (held in RAM at dispatch). */
export const MAX_BYTES_PER_TASK = 128 * 1024 * 1024;
export const DEFAULT_READ_BYTES = 65536;
export const MAX_READ_BYTES = 262144;

const EXT_ALLOWLIST = [
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts", ".json",
  ".md", ".txt", ".sql", ".go", ".py", ".rs", ".yml", ".yaml", ".toml",
  ".css", ".html", ".htm", ".sh", ".bash", ".zsh",
];

const SECRET_NAME_RE =
  /(^|[\\/])(\.env(\..+)?|[^\\/]*\.pem|[^\\/]*\.key|[^\\/]*\.p12|[^\\/]*\.pfx|id_rsa|id_ed25519|credentials\.json)$/i;
const ENV_EXAMPLE_RE = /(^|[\\/])\.env\.example$/i;

/** Shared with composer chip detection (attachment-match fallback path). */
export const RESOURCE_FILE_EXTENSIONS = EXT_ALLOWLIST;

export function isAllowedResourceExtension(relPath: string): boolean {
  const lower = relPath.toLowerCase();
  if (ENV_EXAMPLE_RE.test(lower)) return true;
  return EXT_ALLOWLIST.some((ext) => lower.endsWith(ext));
}

/** Suffixes without dot for DOM chip text matching in browser.evaluate. */
export function resourceExtensionSuffixesForChipMatch(): string[] {
  return EXT_ALLOWLIST.map((ext) => ext.slice(1));
}

function isAllowedExtension(relPath: string): boolean {
  return isAllowedResourceExtension(relPath);
}

export function normalizeRelPosix(raw: string): string {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 1000) {
    throw new HandoffFileError("FILES_INVALID", "Invalid file path");
  }
  if (raw.includes("\0")) {
    throw new HandoffFileError("FILES_INVALID", "NUL byte in path");
  }
  if (isAbsolute(raw)) {
    throw new HandoffFileError("FILES_INVALID", "Absolute paths rejected");
  }
  const normalized = normalize(raw);
  const segments = normalized.split(sep);
  if (segments.includes("..") || normalized.startsWith("..")) {
    throw new HandoffFileError("FILES_INVALID", "Path traversal rejected");
  }
  return normalized.split(sep).join("/");
}

/** When HANDOFF_WORKSPACE_ROOT is unset, infer from HANDOFF_DB_PATH (…/data/handoff.sqlite → repo root). */
function inferWorkspaceRootFromDbPath(): string | undefined {
  const raw = process.env.HANDOFF_DB_PATH?.trim();
  if (!raw) return undefined;
  const dbDir = dirname(resolve(raw));
  if (basename(dbDir) === "data") {
    return dirname(dbDir);
  }
  return undefined;
}

export function resolveWorkspaceRoot(): string {
  const configured =
    process.env.HANDOFF_WORKSPACE_ROOT?.trim() ||
    inferWorkspaceRootFromDbPath() ||
    process.cwd();
  try {
    return realpathSync(configured);
  } catch {
    throw new HandoffFileError(
      "FILES_INVALID",
      "Workspace root missing or unreadable"
    );
  }
}

/** Cheap validation at create — path syntax and dedup only (no read/stat). */
export function registerTaskResourcePaths(
  paths: string[],
  now: string
): TaskResource[] {
  const results: TaskResource[] = [];
  const seenRel = new Set<string>();
  const seenBasename = new Set<string>();

  for (const raw of paths) {
    const relPosix = normalizeRelPosix(raw);

    if (SECRET_NAME_RE.test(relPosix) && !ENV_EXAMPLE_RE.test(relPosix)) {
      throw new HandoffFileError("FILES_INVALID", "Secret-shaped filename rejected");
    }

    if (seenRel.has(relPosix)) {
      throw new HandoffFileError("FILES_INVALID", "Duplicate file");
    }
    seenRel.add(relPosix);

    const displayBase = basename(relPosix).toLowerCase();
    if (seenBasename.has(displayBase)) {
      throw new HandoffFileError(
        "FILES_DUPLICATE_BASENAME",
        "Duplicate display basename rejected"
      );
    }
    seenBasename.add(displayBase);

    const fileId = `f_${ulid()}`;
    results.push({
      fileId,
      displayName: basename(relPosix),
      relativePath: relPosix,
      source: { kind: "workspace_file", relativePath: relPosix },
      createdAt: now,
    });
  }

  return results;
}

/** Authoritative validation + read at dispatch — ephemeral PreparedResource bytes. */
export function materializeWorkspaceResources(
  resources: readonly TaskResource[],
  workspaceRoot: string
): PreparedResource[] {
  const root = realpathSync(workspaceRoot);
  const results: PreparedResource[] = [];
  let totalBytes = 0;

  for (const resource of resources) {
    if (resource.source.kind === "mcp_resource") {
      throw new HandoffFileError(
        "RESOURCES_MCP_DEFERRED",
        "MCP resource ingress is not available in v0.7"
      );
    }

    const relPosix = resource.source.relativePath;
    const candidate = join(root, relPosix.split("/").join(sep));

    let lst;
    try {
      lst = lstatSync(candidate);
    } catch {
      throw new HandoffFileError("FILES_INVALID", "File not found");
    }
    if (lst.isSymbolicLink()) {
      throw new HandoffFileError("FILES_INVALID", "Symlink attachments rejected");
    }
    if (!lst.isFile()) {
      throw new HandoffFileError("FILES_INVALID", "Not a regular file");
    }

    const realCandidate = realpathSync(candidate);
    const rel = relative(root, realCandidate);
    if (rel.startsWith("..") || isAbsolute(rel)) {
      throw new HandoffFileError("FILES_INVALID", "File escapes workspace root");
    }
    const resolvedPosix = rel.split(sep).join("/");

    if (SECRET_NAME_RE.test(resolvedPosix) && !ENV_EXAMPLE_RE.test(resolvedPosix)) {
      throw new HandoffFileError("FILES_INVALID", "Secret-shaped filename rejected");
    }
    if (!isAllowedExtension(resolvedPosix)) {
      throw new HandoffFileError("FILES_INVALID", "Extension not allowed");
    }
    if (lst.size > MAX_BYTES_PER_FILE) {
      throw new HandoffFileError("FILE_TOO_LARGE", "File exceeds per-file cap");
    }

    const buf = readFileSync(realCandidate);
    if (buf.length > MAX_BYTES_PER_FILE) {
      throw new HandoffFileError("FILE_TOO_LARGE", "File exceeds per-file cap");
    }
    totalBytes += buf.length;
    if (totalBytes > MAX_BYTES_PER_TASK) {
      throw new HandoffFileError("FILE_TOO_LARGE", "Task byte budget exceeded");
    }

    if (buf.subarray(0, 8192).includes(0)) {
      throw new HandoffFileError("FILES_INVALID", "Binary/NUL content rejected");
    }

    const textSample = buf.toString("utf8", 0, Math.min(buf.length, 512 * 1024));
    if (containsKnownSecrets(textSample)) {
      throw new HandoffFileError(
        "FILES_SECRET_DETECTED",
        "Known secret pattern detected in file content"
      );
    }

    const sha256 = createHash("sha256").update(buf).digest("hex");
    results.push({
      resourceId: resource.fileId,
      displayName: resource.displayName,
      bytes: buf,
      sizeBytes: buf.length,
      sha256,
      mediaType: "text/plain",
    });
  }

  return results;
}
