import { basename } from "node:path";
import {
  writeUpsertArtifacts,
  type WriteResultArtifactsResult,
} from "../tasks/result-artifacts.js";
import { MAX_COMPRESSED_BYTES } from "./constants.js";
import { decodeCanonicalBase64 } from "./base64.js";
import { ArchiveError } from "./errors.js";
import { parseTarPax } from "./tar-pax.js";
import { decompressTarZstd } from "./zstd.js";

export interface ArchiveSubmitInput {
  format: "tar.zst";
  encoding: "base64";
  data: string;
}

/**
 * Decode → validate entire archive → upsert commit.
 * No workspace mutation until all members validated.
 */
export function ingestArchiveWriteback(
  archive: ArchiveSubmitInput,
  workspaceRoot: string
): WriteResultArtifactsResult {
  if (archive.format !== "tar.zst") {
    throw new ArchiveError(
      "ARCHIVE_FORMAT_UNSUPPORTED",
      `Unsupported archive format: ${archive.format}`
    );
  }
  if (archive.encoding !== "base64") {
    throw new ArchiveError("ARCHIVE_FORMAT_UNSUPPORTED", "encoding must be base64");
  }

  const compressed = decodeCanonicalBase64(archive.data, MAX_COMPRESSED_BYTES);
  const tar = decompressTarZstd(compressed);
  const members = parseTarPax(tar);

  const artifacts = members.map((m) => ({
    path: m.relativePath,
    content: m.bytes.toString("utf8"),
    mode: "upsert" as const,
  }));

  try {
    return writeUpsertArtifacts(artifacts, workspaceRoot);
  } catch (err) {
    if (err instanceof ArchiveError) throw err;
    const msg = err instanceof Error ? err.message : String(err);
    throw new ArchiveError("ARCHIVE_COMMIT_FAILED", msg);
  }
}

export function archiveChipDisplayName(taskId: string): string {
  return `handoff-${taskId}.tar.zst`;
}

export function archiveMemberDisplayName(relPosix: string): string {
  return basename(relPosix);
}
