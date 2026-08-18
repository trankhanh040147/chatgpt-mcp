import type { TaskRepository } from "../tasks/task.repository.js";
import type { WorkerRegistryEntry } from "../config/workers-topology.js";
import { upsertWorkerRegistryEntry } from "../config/write-workers-topology.js";
import type { WorkerReadinessReason } from "../workers/chat-budget.js";

export interface RotateWorkerCommitInput {
  repo: TaskRepository;
  workersFile: string;
  workerId: string;
  existing: WorkerRegistryEntry;
  newWorkerUrl: string;
  readinessReason?: WorkerReadinessReason;
  error?: string | null;
}

export interface RotateWorkerCommitResult {
  previousWorkerUrl: string;
  newWorkerUrl: string;
  readinessReason: WorkerReadinessReason;
  filePath: string;
}

/**
 * Crash-safe rotation commit: topology file first, then DB counter reset.
 * If DB fails, topology already has the new URL — restart register fail-closes
 * (URL identity change → CONSENT_REQUIRED).
 */
export function commitRotatedWorker(
  input: RotateWorkerCommitInput
): RotateWorkerCommitResult {
  input.repo.assertWorkerIdle(input.workerId);
  const state = input.repo.getWorkerState(input.workerId);
  if (state.readinessReason !== "ROTATION_PENDING") {
    throw new Error(
      `rotate-worker: ${input.workerId} is not ROTATION_PENDING (got ${state.readinessReason ?? "none"})`
    );
  }

  const previousWorkerUrl = input.existing.workerUrl;
  if (previousWorkerUrl === input.newWorkerUrl) {
    throw new Error(
      `rotate-worker: new URL matches current chat for ${input.workerId}`
    );
  }

  const readinessReason: WorkerReadinessReason =
    input.readinessReason ?? "CONSENT_REQUIRED";

  const written = upsertWorkerRegistryEntry({
    filePath: input.workersFile,
    entry: {
      id: input.existing.id,
      workerUrl: input.newWorkerUrl,
      cdpEndpoint: input.existing.cdpEndpoint,
      httpPort: input.existing.httpPort,
    },
    replace: true,
  });

  input.repo.commitChatRotation({
    workerId: input.workerId,
    newWorkerUrl: input.newWorkerUrl,
    previousWorkerUrl,
    readinessReason,
    error: input.error ?? `${readinessReason}: rotate-worker ${input.workerId}`,
  });

  return {
    previousWorkerUrl,
    newWorkerUrl: input.newWorkerUrl,
    readinessReason,
    filePath: written.filePath,
  };
}
