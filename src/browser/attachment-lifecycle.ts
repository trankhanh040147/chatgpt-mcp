import type { ResourceDeliveryTarget } from "../transport/types.js";

/** Active native-attach session before TASK_ID send (pre-fence abort must cleanup). */
export type PreparedAttachSession = {
  transport: ResourceDeliveryTarget;
  prepared: boolean;
};

/** Remove staged chips; returns false when composer still has orphan attachments. */
export async function cleanupPreparedAttachSession(
  session: PreparedAttachSession | null,
  runCleanup: () => Promise<void>
): Promise<boolean> {
  if (!session?.prepared) return true;
  await runCleanup();
  return await session.transport.isClean();
}
