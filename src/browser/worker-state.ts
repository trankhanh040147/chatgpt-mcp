import type { TaskRepository } from "../tasks/task.repository.js";
import type { WorkerStatus } from "../tasks/task.types.js";
import { DEFAULT_WORKER_ID } from "../tasks/task.types.js";

export class WorkerStateManager {
  constructor(private readonly repo: TaskRepository) {}

  getStatus(): WorkerStatus {
    return this.repo.getWorkerState(DEFAULT_WORKER_ID).status;
  }

  setStatus(
    status: WorkerStatus,
    extra?: { currentTaskId?: string | null; error?: string | null }
  ): void {
    this.repo.updateWorkerState(DEFAULT_WORKER_ID, status, extra ?? {});
  }

  isReady(): boolean {
    const status = this.getStatus();
    return status === "READY";
  }
}
