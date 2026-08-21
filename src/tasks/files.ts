import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { basename, isAbsolute, join, normalize, relative, sep } from "node:path";
import { ulid } from "ulid";
import { HandoffFileError, type HandoffTaskFile } from "./task.types.js";

export const MAX_FILES_PER_TASK = 10;
export const MAX_BYTES_PER_FILE = 256 * 1024;
export const MAX_BYTES_PER_TASK = 1024 * 1024;
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

function isAllowedExtension(relPath: string): boolean {
  const lower = relPath.toLowerCase();
  if (ENV_EXAMPLE_RE.test(lower)) return true;
  return EXT_ALLOWLIST.some((ext) => lower.endsWith(ext));
}

export function resolveWorkspaceRoot(): string {
  const configured = process.env.HANDOFF_WORKSPACE_ROOT || process.cwd();
  try {
    return realpathSync(configured);
  } catch {
    throw new HandoffFileError(
      "FILES_INVALID",
      "Workspace root missing or unreadable"
    );
  }
}

/** Validate + load all requested files against the persisted workspace root. Throws on any failure — no partial insert. */
export function validateAndLoadFiles(
  paths: string[],
  workspaceRoot: string,
  now: string
): HandoffTaskFile[] {
  if (paths.length > MAX_FILES_PER_TASK) {
    throw new HandoffFileError("FILES_INVALID", "Too many files attached");
  }

  const results: HandoffTaskFile[] = [];
  const seenRel = new Set<string>();
  let totalBytes = 0;

  for (const raw of paths) {
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

    const candidate = join(workspaceRoot, normalized);
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
    const rel = relative(workspaceRoot, realCandidate);
    if (rel.startsWith("..") || isAbsolute(rel)) {
      throw new HandoffFileError("FILES_INVALID", "File escapes workspace root");
    }
    const relPosix = rel.split(sep).join("/");

    if (SECRET_NAME_RE.test(relPosix) && !ENV_EXAMPLE_RE.test(relPosix)) {
      throw new HandoffFileError("FILES_INVALID", "Secret-shaped filename rejected");
    }
    if (!isAllowedExtension(relPosix)) {
      throw new HandoffFileError("FILES_INVALID", "Extension not allowed");
    }
    if (lst.size > MAX_BYTES_PER_FILE) {
      throw new HandoffFileError("FILE_TOO_LARGE", "File exceeds per-file cap");
    }
    totalBytes += lst.size;
    if (totalBytes > MAX_BYTES_PER_TASK) {
      throw new HandoffFileError("FILE_TOO_LARGE", "Task byte budget exceeded");
    }
    if (seenRel.has(relPosix)) {
      throw new HandoffFileError("FILES_INVALID", "Duplicate file");
    }
    seenRel.add(relPosix);

    const buf = readFileSync(realCandidate);
    if (buf.subarray(0, 8192).includes(0)) {
      throw new HandoffFileError("FILES_INVALID", "Binary/NUL content rejected");
    }

    const sha256 = createHash("sha256").update(buf).digest("hex");
    results.push({
      fileId: `f_${ulid()}`,
      displayName: basename(relPosix),
      relativePath: relPosix,
      sourcePath: realCandidate,
      sizeBytes: lst.size,
      sha256,
      mediaType: "text/plain",
      createdAt: now,
    });
  }

  return results;
}
