/** Formal exit codes for gptmcp (machine/CI contract). */
export const ExitCode = {
  /** Success / healthy */
  OK: 0,
  /** Operation failed */
  FAIL: 1,
  /** Invalid CLI usage (unknown option, arity, etc.) */
  USAGE: 2,
  /** System unhealthy or degraded (status/doctor) */
  UNHEALTHY: 3,
  /** Interactive confirmation declined */
  DECLINED: 4,
} as const;

export type ExitCodeValue = (typeof ExitCode)[keyof typeof ExitCode];
