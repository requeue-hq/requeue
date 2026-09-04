import { listPendingReplayEvents } from "./db";
import { replayEventUnscoped } from "./replay";

export async function processPendingReplays(
  db: D1Database,
  limit = 25,
): Promise<{ processed: number; succeeded: number; failed: number }> {
  const pending = await listPendingReplayEvents(db, limit);
  let succeeded = 0;
  let failed = 0;

  for (const event of pending) {
    const result = await replayEventUnscoped(db, event);
    if (result.attempt.success) succeeded += 1;
    else failed += 1;
  }

  return { processed: pending.length, succeeded, failed };
}
