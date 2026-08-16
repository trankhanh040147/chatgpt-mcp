import type { TaskRepository } from "../tasks/task.repository.js";
import type { WorkerStatus } from "../tasks/task.types.js";

export class WorkerStateManager {
  constructor(
    private readonly repo: TaskRepository,
    private readonly workerId: string,
    private readonly instanceToken: string
  ) {}

  get workerIdValue(): string {
    return this.workerId;
  }

  get instanceTokenValue(): string {
    return this.instanceToken;
  }

  getStatus(): WorkerStatus {
    return this.repo.getWorkerState(this.workerId).status;
  }

  setStatus(
    status: WorkerStatus,
    extra?: { currentTaskId?: string | null; error?: string | null }
  ): void {
    this.repo.updateWorkerState(this.workerId, status, {
      ...extra,
      instanceToken: this.instanceToken,
    });
  }

  touchHeartbeat(): boolean {
    return this.repo.touchWorkerHeartbeat(this.workerId, this.instanceToken);
  }

  isReady(): boolean {
    return this.getStatus() === "READY";
  }
}
