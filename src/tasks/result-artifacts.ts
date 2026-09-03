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
import {
  fileRedactionSummary,
  mergeSecretRedactionDisclosures,
  redactSecretsInBuffer,
  type SecretRedactionDisclosure,
} from "./sanitize.js";
import {
  isAllowedResourceExtension,
  MAX_BYTES_PER_FILE,
  MAX_BYTES_PER_TASK,
  normalizeRelPosix,
} from "./files.js";
import { HandoffFileError } from "./task.types.js";

/** Max artifacts per submit_result (aligned with CHATGPT_DOM_CHIP_CAP). */
export const MAX_ARTIFACTS_PER_SUBMIT = 20;

export type ResultArtifactWriteMode = "create" | "overwrite" | "upsert";

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
  modifiedForSecretRemoval?: boolean;
  redactionCount?: number;
  detectorIds?: string[];
}

export interface WriteResultArtifactsResult {
  artifacts: WrittenResultArtifact[];
  redaction?: SecretRedactionDisclosure;
}

interface PreparedArtifact {
  relPosix: string;
  displayName: string;
  buf: Buffer;
  mode: "create" | "overwrite";
  targetPath: string;
  sha256: string;
  sizeBytes: number;
  modifiedForSecretRemoval?: boolean;
  redactionCount?: number;
  detectorIds?: string[];
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
  root: string,
  opts?: {
    maxItems?: number;
    maxBytesPerFile?: number;
    maxBytesTotal?: number;
    /** When true, create-if-missing / overwrite-if-present (archive ingest). */
    upsert?: boolean;
  }
): { prepared: PreparedArtifact[]; redaction?: SecretRedactionDisclosure } {
  if (artifacts.length === 0) return { prepared: [] };
  const maxItems = opts?.maxItems ?? MAX_ARTIFACTS_PER_SUBMIT;
  const maxFile = opts?.maxBytesPerFile ?? MAX_BYTES_PER_FILE;
  const maxTotal = opts?.maxBytesTotal ?? MAX_BYTES_PER_TASK;
  if (artifacts.length > maxItems) {
    throw artifactError(
      "FILES_INVALID",
      `Too many artifacts (max ${maxItems})`
    );
  }

  const prepared: PreparedArtifact[] = [];
  const redactionParts: SecretRedactionDisclosure[] = [];
  let totalBytes = 0;
  const seenRel = new Set<string>();

  for (const artifact of artifacts) {
    const relPosix = normalizeRelPosix(artifact.path);
    if (seenRel.has(relPosix)) {
      throw artifactError("FILES_INVALID", "Duplicate artifact path", relPosix);
    }
    seenRel.add(relPosix);
    assertAllowedArtifactPath(relPosix);

    const raw = Buffer.from(artifact.content, "utf8");
    if (raw.length > maxFile) {
      throw artifactError("FILE_TOO_LARGE", "Artifact exceeds per-file cap", relPosix);
    }
    if (raw.subarray(0, 8192).includes(0)) {
      throw artifactError("FILES_INVALID", "Binary/NUL content rejected", relPosix);
    }

    const { buf, disclosure, unsafeSecretHit } = redactSecretsInBuffer(raw);
    if (unsafeSecretHit) {
      throw artifactError(
        "FILES_SECRET_DETECTED",
        "Known secret pattern detected but artifact is not safely redactable",
        relPosix
      );
    }

    totalBytes += buf.length;
    if (totalBytes > maxTotal) {
      throw artifactError("FILE_TOO_LARGE", "Artifact byte budget exceeded", relPosix);
    }

    const targetPath = resolveTargetPath(root, relPosix);
    let mode: "create" | "overwrite";
    if (opts?.upsert) {
      mode = existsSync(targetPath) ? "overwrite" : "create";
    } else {
      mode = artifact.mode === "overwrite" ? "overwrite" : "create";
      if (mode === "create" && existsSync(targetPath)) {
        throw artifactError("FILES_INVALID", "Create target already exists", relPosix);
      }
      if (mode === "overwrite" && !existsSync(targetPath)) {
        throw artifactError("FILES_INVALID", "Overwrite target does not exist", relPosix);
      }
    }

    const displayName = relPosix.split("/").pop() ?? relPosix;
    if (disclosure.redactionCount > 0) {
      const fileSummary = fileRedactionSummary(displayName, disclosure);
      redactionParts.push({
        ...disclosure,
        files: fileSummary ? [fileSummary] : undefined,
        modifiedForSecretRemoval: true,
      });
    }

    prepared.push({
      relPosix,
      displayName,
      buf,
      mode,
      targetPath,
      sha256: createHash("sha256").update(buf).digest("hex"),
      sizeBytes: buf.length,
      modifiedForSecretRemoval:
        disclosure.redactionCount > 0 ? true : undefined,
      redactionCount:
        disclosure.redactionCount > 0 ? disclosure.redactionCount : undefined,
      detectorIds:
        disclosure.redactionCount > 0 ? disclosure.detectorIds : undefined,
    });
  }

  const redaction =
    redactionParts.length > 0
      ? mergeSecretRedactionDisclosures(redactionParts)
      : undefined;
  return { prepared, redaction };
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
      } else if (existsSync(entry.targetPath)) {
        unlinkSync(entry.targetPath);
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
        if (!existsSync(item.targetPath)) {
          throw artifactError(
            "FILES_INVALID",
            "Overwrite target does not exist",
            item.relPosix
          );
        }
        const backup = readFileSync(item.targetPath);
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
        modifiedForSecretRemoval: item.modifiedForSecretRemoval,
        redactionCount: item.redactionCount,
        detectorIds: item.detectorIds,
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
): WriteResultArtifactsResult {
  if (artifacts.length === 0) return { artifacts: [] };

  const root = realpathSync(workspaceRoot);
  const { prepared, redaction } = validateAndPrepareArtifacts(artifacts, root);
  return {
    artifacts: commitBatch(prepared),
    redaction: redaction
      ? { ...redaction, modifiedForSecretRemoval: true }
      : undefined,
  };
}

/**
 * Archive-member writeback: each path upserts (create if absent, overwrite if present).
 * Validates all before any mutation (same transactional commit as writeResultArtifacts).
 */
export function writeUpsertArtifacts(
  artifacts: readonly ResultArtifactInput[],
  workspaceRoot: string
): WriteResultArtifactsResult {
  if (artifacts.length === 0) return { artifacts: [] };
  const root = realpathSync(workspaceRoot);
  const { prepared, redaction } = validateAndPrepareArtifacts(artifacts, root, {
    maxItems: 100,
    maxBytesPerFile: 64 * 1024 * 1024,
    maxBytesTotal: 64 * 1024 * 1024,
    upsert: true,
  });
  return {
    artifacts: commitBatch(prepared),
    redaction: redaction
      ? { ...redaction, modifiedForSecretRemoval: true }
      : undefined,
  };
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
