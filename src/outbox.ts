import { findEventStatus, listPendingReplayEvents, updateEventReplaySchedule } from "./db";
import { ApiError } from "./errors";
import { nowIso } from "./json";
import { replayEventUnscoped, replayOverrideFromEvent } from "./replay";

/** Outbox delivery budget when an endpoint leaves the columns at their defaults. */
export const DEFAULT_RETRY_MAX_ATTEMPTS = 6;

/** Seconds after the first failed outbox delivery when the endpoint uses the default. */
export const DEFAULT_RETRY_BASE_DELAY_SECONDS = 60;

export const MIN_RETRY_MAX_ATTEMPTS = 1;
export const MAX_RETRY_MAX_ATTEMPTS = 20;
export const MIN_RETRY_BASE_DELAY_SECONDS = 1;
export const MAX_RETRY_BASE_DELAY_SECONDS = 86_400;

/** One backoff step never schedules further out than a day. */
export const MAX_RETRY_DELAY_SECONDS = 86_400;

/** First outbox try plus automatic retries under the default policy (6 deliveries total). */
export const MAX_OUTBOX_ATTEMPTS = DEFAULT_RETRY_MAX_ATTEMPTS;

export type RetryPolicy = {
  maxAttempts: number;
  baseDelaySeconds: number;
};

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: DEFAULT_RETRY_MAX_ATTEMPTS,
  baseDelaySeconds: DEFAULT_RETRY_BASE_DELAY_SECONDS,
};

/** Clamp a stored policy into the range the API accepts. Non-integers use the default. */
export function normalizeRetryPolicy(policy?: Partial<RetryPolicy> | null): RetryPolicy {
  return {
    maxAttempts: clampPolicyInt(
      policy?.maxAttempts,
      DEFAULT_RETRY_MAX_ATTEMPTS,
      MIN_RETRY_MAX_ATTEMPTS,
      MAX_RETRY_MAX_ATTEMPTS,
    ),
    baseDelaySeconds: clampPolicyInt(
      policy?.baseDelaySeconds,
      DEFAULT_RETRY_BASE_DELAY_SECONDS,
      MIN_RETRY_BASE_DELAY_SECONDS,
      MAX_RETRY_BASE_DELAY_SECONDS,
    ),
  };
}

function clampPolicyInt(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isInteger(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

/** Delay after failed outbox attempt `failedAttemptCount` (1 = first failure). */
export function backoffDelaySeconds(failedAttemptCount: number, baseDelaySeconds: number): number {
  let delay = baseDelaySeconds;
  for (let step = 1; step < failedAttemptCount; step++) {
    if (delay >= MAX_RETRY_DELAY_SECONDS) return MAX_RETRY_DELAY_SECONDS;
    delay *= 2;
  }
  return Math.min(delay, MAX_RETRY_DELAY_SECONDS);
}

/** Delay after the 1st…5th failed outbox attempt under the default policy (seconds). */
export const REPLAY_BACKOFF_SECONDS = [1, 2, 3, 4, 5].map((attempt) =>
  backoffDelaySeconds(attempt, DEFAULT_RETRY_BASE_DELAY_SECONDS),
);

export function nextReplayRetryAt(
  failedAttemptCount: number,
  fromIso: string,
  policy?: Partial<RetryPolicy> | null,
): string | null {
  const normalized = normalizeRetryPolicy(policy);
  if (failedAttemptCount >= normalized.maxAttempts) return null;
  const delaySec = backoffDelaySeconds(failedAttemptCount, normalized.baseDelaySeconds);
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
  let skipped = 0;

  for (const event of pending) {
    // Resolve can land between the outbox SELECT and this delivery. Do not POST
    // a row that is no longer pending_replay.
    const status = await findEventStatus(db, event.id);
    if (status !== "pending_replay") {
      skipped += 1;
      continue;
    }

    const policy = normalizeRetryPolicy({
      maxAttempts: event.retry_max_attempts ?? undefined,
      baseDelaySeconds: event.retry_base_delay_seconds ?? undefined,
    });

    try {
      const result = await replayEventUnscoped(db, event, replayOverrideFromEvent(event));
      if (result.attempt.success) {
        succeeded += 1;
        continue;
      }

      failed += 1;
      const retryCount = (event.retry_count ?? 0) + 1;
      const nextRetryAt = nextReplayRetryAt(retryCount, result.attempt.attempted_at, policy);
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

  return { processed: pending.length - skipped, succeeded, failed };
}
