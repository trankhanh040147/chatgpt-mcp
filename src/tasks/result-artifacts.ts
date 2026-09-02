import { createHash, randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { containsKnownSecrets } from "./sanitize.js";
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

const SECRET_NAME_RE =
  /(^|[\\/])(\.env(\..+)?|[^\\/]*\.pem|[^\\/]*\.key|[^\\/]*\.p12|[^\\/]*\.pfx|id_rsa|id_ed25519|credentials\.json)$/i;
const ENV_EXAMPLE_RE = /(^|[\\/])\.env\.example$/i;

function assertAllowedArtifactPath(relPosix: string): void {
  if (SECRET_NAME_RE.test(relPosix) && !ENV_EXAMPLE_RE.test(relPosix)) {
    throw new HandoffFileError("FILES_INVALID", "Secret-shaped filename rejected");
  }
  if (!isAllowedResourceExtension(relPosix)) {
    throw new HandoffFileError("FILES_INVALID", "Extension not allowed");
  }
}

function atomicWriteFile(
  targetPath: string,
  buf: Buffer,
  mode: ResultArtifactWriteMode
): void {
  mkdirSync(dirname(targetPath), { recursive: true });
  if (mode === "create" && existsSync(targetPath)) {
    throw new HandoffFileError("FILES_INVALID", "Artifact path already exists");
  }
  const tmp = join(dirname(targetPath), `.handoff-write-${randomBytes(8).toString("hex")}.tmp`);
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

/** Write ChatGPT-submitted artifacts into task workspace. Fail-closed on any error. */
export function writeResultArtifacts(
  artifacts: readonly ResultArtifactInput[],
  workspaceRoot: string
): WrittenResultArtifact[] {
  if (artifacts.length === 0) return [];
  if (artifacts.length > MAX_ARTIFACTS_PER_SUBMIT) {
    throw new HandoffFileError(
      "FILES_INVALID",
      `Too many artifacts (max ${MAX_ARTIFACTS_PER_SUBMIT})`
    );
  }

  const root = realpathSync(workspaceRoot);
  const results: WrittenResultArtifact[] = [];
  let totalBytes = 0;
  const seenRel = new Set<string>();

  for (const artifact of artifacts) {
    const relPosix = normalizeRelPosix(artifact.path);
    if (seenRel.has(relPosix)) {
      throw new HandoffFileError("FILES_INVALID", "Duplicate artifact path");
    }
    seenRel.add(relPosix);
    assertAllowedArtifactPath(relPosix);

    const buf = Buffer.from(artifact.content, "utf8");
    if (buf.length > MAX_BYTES_PER_FILE) {
      throw new HandoffFileError("FILE_TOO_LARGE", "Artifact exceeds per-file cap");
    }
    totalBytes += buf.length;
    if (totalBytes > MAX_BYTES_PER_TASK) {
      throw new HandoffFileError("FILE_TOO_LARGE", "Artifact byte budget exceeded");
    }
    if (buf.subarray(0, 8192).includes(0)) {
      throw new HandoffFileError("FILES_INVALID", "Binary/NUL content rejected");
    }
    const textSample = buf.toString("utf8", 0, Math.min(buf.length, 512 * 1024));
    if (containsKnownSecrets(textSample)) {
      throw new HandoffFileError(
        "FILES_SECRET_DETECTED",
        "Known secret pattern detected in artifact content"
      );
    }

    const candidate = join(root, relPosix.split("/").join(sep));
    mkdirSync(dirname(candidate), { recursive: true });
    const realParent = realpathSync(dirname(candidate));
    const relParent = relative(root, realParent);
    if (relParent.startsWith("..") || isAbsolute(relParent)) {
      throw new HandoffFileError("FILES_INVALID", "Artifact escapes workspace root");
    }

    const mode: ResultArtifactWriteMode =
      artifact.mode === "overwrite" ? "overwrite" : "create";
    atomicWriteFile(candidate, buf, mode);

    const sha256 = createHash("sha256").update(buf).digest("hex");
    results.push({
      relativePath: relPosix,
      displayName: relPosix.split("/").pop() ?? relPosix,
      sizeBytes: buf.length,
      sha256,
    });
  }

  return results;
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
