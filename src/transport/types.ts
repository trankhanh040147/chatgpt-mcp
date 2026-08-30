import type { HandoffTaskFile } from "../tasks/task.types.js";

export type PrepareFailureReason =
  | "INPUT_NOT_FOUND"
  | "UPLOAD_TIMEOUT"
  | "CHIP_MISMATCH"
  | "UPLOAD_REJECTED";

export type PrepareSuccess = {
  ok: true;
  expected: string[];
  added: string[];
};

export type PrepareFailure = {
  ok: false;
  expected: string[];
  observed: string[];
  added?: string[];
  reason: PrepareFailureReason;
  retryable: boolean;
};

export type PrepareResult = PrepareSuccess | PrepareFailure;

export interface ResourceDeliveryTarget {
  prepare(
    files: readonly HandoffTaskFile[],
    taskId: string
  ): Promise<PrepareResult>;
  cleanup(): Promise<void>;
  isClean(): Promise<boolean>;
}

export function classifyPrepareFailure(
  reason: PrepareFailureReason
): Pick<PrepareFailure, "reason" | "retryable"> {
  switch (reason) {
    case "UPLOAD_REJECTED":
      return { reason, retryable: false };
    default:
      return { reason, retryable: true };
  }
}
