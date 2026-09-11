import { listPendingReplayEvents, updateEventReplaySchedule } from "./db";
import { ApiError } from "./errors";
import { nowIso } from "./json";
import { replayEventUnscoped } from "./replay";

/** First outbox try plus this many automatic retries (6 deliveries total). */
export const MAX_OUTBOX_ATTEMPTS = 6;

/** Delay after the 1st…5th failed outbox attempt (seconds). */
export const REPLAY_BACKOFF_SECONDS = [60, 120, 240, 480, 960] as const;

export function nextReplayRetryAt(failedAttemptCount: number, fromIso: string): string | null {
  if (failedAttemptCount >= MAX_OUTBOX_ATTEMPTS) return null;
  const delaySec =
    REPLAY_BACKOFF_SECONDS[failedAttemptCount - 1] ??
    REPLAY_BACKOFF_SECONDS[REPLAY_BACKOFF_SECONDS.length - 1];
  return new Date(Date.parse(fromIso) + delaySec * 1000).toISOString();
}

export async function processPendingReplays(
  db: D1Database,
  limit = 25,
  now = nowIso(),
): Promise<{ processed: number; succeeded: number; failed: number }> {
  const pending = await listPendingReplayEvents(db, limit, now);
  let succeeded = 0;
  let failed = 0;

  for (const event of pending) {
    try {
      const result = await replayEventUnscoped(db, event);
      if (result.attempt.success) {
        succeeded += 1;
        continue;
      }

      failed += 1;
      const retryCount = (event.retry_count ?? 0) + 1;
      const nextRetryAt = nextReplayRetryAt(retryCount, result.attempt.attempted_at);
      await updateEventReplaySchedule(db, event.id, {
        status: nextRetryAt ? "pending_replay" : "replay_failed",
        updatedAt: result.attempt.attempted_at,
        retryCount,
        nextRetryAt,
      });
    } catch (err) {
      if (!(err instanceof ApiError) || err.code !== "endpoint_gone") {
        throw err;
      }
      failed += 1;
      await updateEventReplaySchedule(db, event.id, {
        status: "replay_failed",
        updatedAt: now,
        retryCount: event.retry_count ?? 0,
        nextRetryAt: null,
      });
    }
  }

  return { processed: pending.length, succeeded, failed };
}
