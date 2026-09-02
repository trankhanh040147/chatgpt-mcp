import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { bufferContainsKnownSecrets } from "./sanitize.js";
import {
  isAllowedResourceExtension,
  MAX_BYTES_PER_FILE,
  MAX_BYTES_PER_TASK,
  normalizeRelPosix,
} from "./files.js";
import { HandoffFileError } from "./task.types.js";

/** Max artifacts per submit_result (aligned with CHATGPT_DOM_CHIP_CAP). */
export const MAX_ARTIFACTS_PER_SUBMIT = 20;

export type ResultArtifactWriteMode = "create" | "overwrite";

export interface ResultArtifactInput {
  path: string;
  content: string;
  mode?: ResultArtifactWriteMode;
}

export interface WrittenResultArtifact {
  relativePath: string;
  displayName: string;
  sizeBytes: number;
  sha256: string;
}

interface PreparedArtifact {
  relPosix: string;
  displayName: string;
  buf: Buffer;
  mode: ResultArtifactWriteMode;
  targetPath: string;
  sha256: string;
  sizeBytes: number;
}

interface CommittedArtifact {
  targetPath: string;
  mode: ResultArtifactWriteMode;
  backup: Buffer | null;
}

const SECRET_NAME_RE =
  /(^|[\\/])(\.env(\..+)?|[^\\/]*\.pem|[^\\/]*\.key|[^\\/]*\.p12|[^\\/]*\.pfx|id_rsa|id_ed25519|credentials\.json)$/i;
const ENV_EXAMPLE_RE = /(^|[\\/])\.env\.example$/i;

function artifactError(
  code: HandoffFileError["code"],
  message: string,
  relPosix?: string
): HandoffFileError {
  const suffix = relPosix ? ` (${relPosix})` : "";
  return new HandoffFileError(code, `${message}${suffix}`);
}

function assertAllowedArtifactPath(relPosix: string): void {
  if (SECRET_NAME_RE.test(relPosix) && !ENV_EXAMPLE_RE.test(relPosix)) {
    throw artifactError("FILES_INVALID", "Secret-shaped filename rejected", relPosix);
  }
  if (!isAllowedResourceExtension(relPosix)) {
    throw artifactError("FILES_INVALID", "Extension not allowed", relPosix);
  }
}

function resolveTargetPath(root: string, relPosix: string): string {
  const candidate = join(root, relPosix.split("/").join(sep));
  mkdirSync(dirname(candidate), { recursive: true });
  const realParent = realpathSync(dirname(candidate));
  const relParent = relative(root, realParent);
  if (relParent.startsWith("..") || isAbsolute(relParent)) {
    throw artifactError("FILES_INVALID", "Artifact escapes workspace root", relPosix);
  }
  return candidate;
}

function validateAndPrepareArtifacts(
  artifacts: readonly ResultArtifactInput[],
  root: string
): PreparedArtifact[] {
  if (artifacts.length === 0) return [];
  if (artifacts.length > MAX_ARTIFACTS_PER_SUBMIT) {
    throw artifactError(
      "FILES_INVALID",
      `Too many artifacts (max ${MAX_ARTIFACTS_PER_SUBMIT})`
    );
  }

  const prepared: PreparedArtifact[] = [];
  let totalBytes = 0;
  const seenRel = new Set<string>();

  for (const artifact of artifacts) {
    const relPosix = normalizeRelPosix(artifact.path);
    if (seenRel.has(relPosix)) {
      throw artifactError("FILES_INVALID", "Duplicate artifact path", relPosix);
    }
    seenRel.add(relPosix);
    assertAllowedArtifactPath(relPosix);

    const buf = Buffer.from(artifact.content, "utf8");
    if (buf.length > MAX_BYTES_PER_FILE) {
      throw artifactError("FILE_TOO_LARGE", "Artifact exceeds per-file cap", relPosix);
    }
    totalBytes += buf.length;
    if (totalBytes > MAX_BYTES_PER_TASK) {
      throw artifactError("FILE_TOO_LARGE", "Artifact byte budget exceeded", relPosix);
    }
    if (buf.subarray(0, 8192).includes(0)) {
      throw artifactError("FILES_INVALID", "Binary/NUL content rejected", relPosix);
    }
    if (bufferContainsKnownSecrets(buf)) {
      throw artifactError(
        "FILES_SECRET_DETECTED",
        "Known secret pattern detected in artifact content",
        relPosix
      );
    }

    const mode: ResultArtifactWriteMode =
      artifact.mode === "overwrite" ? "overwrite" : "create";
    const targetPath = resolveTargetPath(root, relPosix);

    if (mode === "create" && existsSync(targetPath)) {
      throw artifactError("FILES_INVALID", "Create target already exists", relPosix);
    }

    prepared.push({
      relPosix,
      displayName: relPosix.split("/").pop() ?? relPosix,
      buf,
      mode,
      targetPath,
      sha256: createHash("sha256").update(buf).digest("hex"),
      sizeBytes: buf.length,
    });
  }

  return prepared;
}

function commitCreate(targetPath: string, buf: Buffer): void {
  mkdirSync(dirname(targetPath), { recursive: true });
  let fd: number | undefined;
  try {
    fd = openSync(targetPath, "wx");
    writeSync(fd, buf, 0, buf.length);
    closeSync(fd);
    fd = undefined;
  } catch (err) {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        /* ignore */
      }
    }
    try {
      unlinkSync(targetPath);
    } catch {
      /* ignore */
    }
    if (
      err instanceof Error &&
      "code" in err &&
      (err as NodeJS.ErrnoException).code === "EEXIST"
    ) {
      throw artifactError("FILES_INVALID", "Create target already exists", targetPath);
    }
    throw err;
  }
}

function commitOverwrite(targetPath: string, buf: Buffer): void {
  mkdirSync(dirname(targetPath), { recursive: true });
  const tmp = join(
    dirname(targetPath),
    `.handoff-write-${randomBytes(8).toString("hex")}.tmp`
  );
  try {
    writeFileSync(tmp, buf);
    renameSync(tmp, targetPath);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      /* ignore */
    }
    throw err;
  }
}

function rollbackCommitted(committed: readonly CommittedArtifact[]): void {
  for (let i = committed.length - 1; i >= 0; i -= 1) {
    const entry = committed[i];
    try {
      if (entry.mode === "create") {
        if (existsSync(entry.targetPath)) {
          unlinkSync(entry.targetPath);
        }
      } else if (entry.backup !== null) {
        writeFileSync(entry.targetPath, entry.backup);
      }
    } catch {
      /* best-effort rollback per ADR-010 */
    }
  }
}

function commitBatch(prepared: readonly PreparedArtifact[]): WrittenResultArtifact[] {
  const committed: CommittedArtifact[] = [];
  const results: WrittenResultArtifact[] = [];

  try {
    for (const item of prepared) {
      if (item.mode === "create") {
        commitCreate(item.targetPath, item.buf);
        committed.push({ targetPath: item.targetPath, mode: "create", backup: null });
      } else {
        const backup = existsSync(item.targetPath)
          ? readFileSync(item.targetPath)
          : Buffer.alloc(0);
        commitOverwrite(item.targetPath, item.buf);
        committed.push({
          targetPath: item.targetPath,
          mode: "overwrite",
          backup,
        });
      }
      results.push({
        relativePath: item.relPosix,
        displayName: item.displayName,
        sizeBytes: item.sizeBytes,
        sha256: item.sha256,
      });
    }
    return results;
  } catch (err) {
    rollbackCommitted(committed);
    if (err instanceof HandoffFileError) {
      throw err;
    }
    throw new HandoffFileError("FILES_INVALID", "Artifact write failed");
  }
}

/** Write ChatGPT-submitted artifacts into task workspace. Fail-closed on any error. */
export function writeResultArtifacts(
  artifacts: readonly ResultArtifactInput[],
  workspaceRoot: string
): WrittenResultArtifact[] {
  if (artifacts.length === 0) return [];

  const root = realpathSync(workspaceRoot);
  const prepared = validateAndPrepareArtifacts(artifacts, root);
  return commitBatch(prepared);
}

/** Read back artifact bytes for tests / verification. */
export function readWorkspaceArtifact(
  workspaceRoot: string,
  relPosix: string
): Buffer {
  const root = realpathSync(workspaceRoot);
  const normalized = normalizeRelPosix(relPosix);
  const candidate = join(root, normalized.split("/").join(sep));
  const realCandidate = realpathSync(candidate);
  const rel = relative(root, realCandidate);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new HandoffFileError("FILES_INVALID", "Artifact escapes workspace root");
  }
  return readFileSync(realCandidate);
}
