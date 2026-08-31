/** Loopback broker control HTTP — default away from :8787 status-api / common :8788 dashboards. */
export const DEFAULT_BROKER_OPS_PORT = 18788;

export function resolveBrokerOpsPort(): number {
  const raw = process.env.HANDOFF_BROKER_OPS_PORT?.trim();
  if (raw) {
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return DEFAULT_BROKER_OPS_PORT;
}
