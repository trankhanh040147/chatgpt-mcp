import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import { ulid } from "ulid";
import {
  MAX_ARCHIVE_MEMBERS,
  MAX_MEMBER_BYTES,
  MAX_UNCOMPRESSED_BYTES,
} from "../archive/constants.js";
import {
  fileRedactionSummary,
  mergeSecretRedactionDisclosures,
  redactSecretsInBuffer,
  type SecretRedactionDisclosure,
} from "./sanitize.js";
import {
  HandoffFileError,
  type PreparedResource,
  type TaskResource,
} from "./task.types.js";

/** Materialize output: ephemeral bytes plus optional ADR-005 disclosure. */
export interface MaterializeWorkspaceResult {
  resources: PreparedResource[];
  redaction?: SecretRedactionDisclosure;
}

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

/** Resolve host workspace for file attach/writeback. Per-task override wins over env. */
export function resolveWorkspaceRoot(override?: string): string {
  const configured =
    override?.trim() ||
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

/** Fail fast at create when attached paths are missing under the resolved workspace. */
export function assertWorkspaceFilesExist(
  paths: readonly string[],
  workspaceRoot: string
): void {
  if (paths.length === 0) return;
  const root = realpathSync(workspaceRoot);
  for (const raw of paths) {
    const relPosix = normalizeRelPosix(raw);
    const candidate = join(root, relPosix.split("/").join(sep));
    try {
      const lst = lstatSync(candidate);
      if (lst.isSymbolicLink()) {
        throw new HandoffFileError("FILES_INVALID", "Symlink attachments rejected");
      }
      if (!lst.isFile()) {
        throw new HandoffFileError("FILES_INVALID", `Not a regular file (${relPosix})`);
      }
    } catch (err) {
      if (err instanceof HandoffFileError) throw err;
      throw new HandoffFileError(
        "FILES_INVALID",
        `File not found under workspace (${relPosix}). ` +
          "If handoff is from another repo, set HANDOFF_WORKSPACE_ROOT=${workspaceFolder} in MCP config or pass workspaceRoot on handoff_create_task."
      );
    }
  }
}

/** Cheap validation at create — path syntax and dedup only (no read/stat). */
export function registerTaskResourcePaths(
  paths: string[],
  now: string
): TaskResource[] {
  if (paths.length > MAX_ARCHIVE_MEMBERS) {
    throw new HandoffFileError(
      "FILES_INVALID",
      `Too many files (max ${MAX_ARCHIVE_MEMBERS})`
    );
  }
  const results: TaskResource[] = [];
  const seenRel = new Set<string>();

  for (const raw of paths) {
    const relPosix = normalizeRelPosix(raw);

    if (SECRET_NAME_RE.test(relPosix) && !ENV_EXAMPLE_RE.test(relPosix)) {
      throw new HandoffFileError("FILES_INVALID", "Secret-shaped filename rejected");
    }

    if (seenRel.has(relPosix)) {
      throw new HandoffFileError("FILES_INVALID", "Duplicate file");
    }
    seenRel.add(relPosix);

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
  workspaceRoot: string,
  caps?: { maxBytesPerFile?: number; maxBytesTotal?: number }
): MaterializeWorkspaceResult {
  const maxFile = caps?.maxBytesPerFile ?? MAX_BYTES_PER_FILE;
  const maxTotal = caps?.maxBytesTotal ?? MAX_BYTES_PER_TASK;
  const root = realpathSync(workspaceRoot);
  const results: PreparedResource[] = [];
  const redactionParts: SecretRedactionDisclosure[] = [];
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
    if (lst.size > maxFile) {
      throw new HandoffFileError("FILE_TOO_LARGE", "File exceeds per-file cap");
    }

    const raw = readFileSync(realCandidate);
    if (raw.length > maxFile) {
      throw new HandoffFileError("FILE_TOO_LARGE", "File exceeds per-file cap");
    }
    totalBytes += raw.length;
    if (totalBytes > maxTotal) {
      throw new HandoffFileError("FILE_TOO_LARGE", "Task byte budget exceeded");
    }

    if (raw.subarray(0, 8192).includes(0)) {
      throw new HandoffFileError("FILES_INVALID", "Binary/NUL content rejected");
    }

    const { buf, disclosure, unsafeSecretHit } = redactSecretsInBuffer(raw);
    if (unsafeSecretHit) {
      throw new HandoffFileError(
        "FILES_SECRET_DETECTED",
        "Known secret pattern detected but content is not safely redactable"
      );
    }
    if (disclosure.redactionCount > 0) {
      const fileSummary = fileRedactionSummary(resource.displayName, disclosure);
      redactionParts.push({
        ...disclosure,
        files: fileSummary ? [fileSummary] : undefined,
      });
      // Redaction can shrink bytes; keep totalBytes as upper bound (raw sizes).
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

  return {
    resources: results,
    redaction: mergeSecretRedactionDisclosures(redactionParts),
  };
}

/** Materialize with v0.9 pack caps (64 MiB / 64 MiB) for always-one-chip dispatch. */
export function materializeResourcesForArchivePack(
  resources: readonly TaskResource[],
  workspaceRoot: string
): MaterializeWorkspaceResult {
  return materializeWorkspaceResources(resources, workspaceRoot, {
    maxBytesPerFile: MAX_MEMBER_BYTES,
    maxBytesTotal: MAX_UNCOMPRESSED_BYTES,
  });
}
