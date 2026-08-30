export type WorkerOperationKind =
  | "ASSIGN_URL"
  | "CREATE_CHAT"
  | "KILL_RECREATE";

export type WorkerOperationState =
  | "PENDING"
  | "RUNNING"
  | "VERIFYING"
  | "SUCCEEDED"
  | "FAILED";

export interface WorkerOperationPayload {
  desiredWorkerUrl?: string;
  previousWorkerUrl?: string;
  probeTaskId?: string;
  probeToken?: string;
  createMode?: "create" | "assign";
  bootstrapMessage?: string;
  /** Reconcile step markers for crash recovery */
  registryEnsured?: boolean;
  dbEnsured?: boolean;
  brokerEnsured?: boolean;
  unbound?: boolean;
  /** readiness_reason before worker-ops reservation (for abort on fail/cancel) */
  reservationPreviousReason?: string | null;
  /** CREATE_CHAT automation already failed once — do not open another tab */
  createChatAttempted?: boolean;
}

export interface WorkerOperation {
  id: string;
  workerId: string;
  kind: WorkerOperationKind;
  state: WorkerOperationState;
  payload: WorkerOperationPayload;
  attempt: number;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}
