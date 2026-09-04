import { createHash } from "node:crypto";
import type { PreparedResource, TaskResource } from "../tasks/task.types.js";
import { TASK_ID_CHIP_RE } from "./constants.js";
import { ArchiveError } from "./errors.js";
import { packTarPax } from "./tar-pax.js";
import { compressTarZstd } from "./zstd.js";

/** Pack materialized task resources into one handoff-{taskId}.tar.zst chip. */
export function packTaskResourcesAsTarZst(
  taskFiles: readonly TaskResource[],
  prepared: readonly PreparedResource[],
  taskId: string
): PreparedResource {
  if (!TASK_ID_CHIP_RE.test(taskId)) {
    throw new ArchiveError("PACK_TASK_ID_INVALID", "Invalid taskId for chip name");
  }
  if (prepared.length === 0) {
    throw new ArchiveError("PACK_TOO_MANY_MEMBERS", "No resources to pack");
  }

  const byId = new Map(prepared.map((p) => [p.resourceId, p]));
  const members = taskFiles.map((f) => {
    const p = byId.get(f.fileId);
    if (!p) {
      throw new ArchiveError(
        "PACK_TOO_MANY_MEMBERS",
        `Missing prepared bytes for ${f.relativePath}`
      );
    }
    const rel =
      f.source.kind === "workspace_file"
        ? f.source.relativePath
        : f.relativePath;
    return { relativePath: rel, bytes: p.bytes };
  });

  const tar = packTarPax(members);
  const compressed = compressTarZstd(tar);
  const displayName = `handoff-${taskId}.tar.zst`;
  return {
    resourceId: `archive_${taskId}`,
    displayName,
    bytes: compressed,
    sizeBytes: compressed.length,
    sha256: createHash("sha256").update(compressed).digest("hex"),
    mediaType: "application/zstd",
  };
}
