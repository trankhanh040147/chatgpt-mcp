import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

/** Immutable task resource copies live beside the handoff DB. */
export function resolveSnapshotRoot(): string {
  const dbPath =
    process.env.HANDOFF_DB_PATH?.trim() ||
    join(homedir(), ".chatgpt-mcp", "data", "handoff.sqlite");
  return join(dirname(dbPath), "resource-snapshots");
}

export function snapshotFilePath(
  taskId: string,
  fileId: string
): string {
  return join(resolveSnapshotRoot(), taskId, fileId);
}

/** Write bytes once at task create; returns absolute snapshot path. */
export function writeResourceSnapshot(
  taskId: string,
  fileId: string,
  content: Buffer
): string {
  const dest = snapshotFilePath(taskId, fileId);
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, content);
  return dest;
}
