export const DEFAULT_INGEST_LIMIT_PER_WINDOW = 60;
export const INGEST_WINDOW_SECONDS = 60;

export function parseIngestRateLimit(value: string | undefined): number {
  const parsed = Number.parseInt(value ?? "", 10);
  if (!Number.isFinite(parsed) || parsed < 1) return DEFAULT_INGEST_LIMIT_PER_WINDOW;
  return Math.min(parsed, 10_000);
}

export function ingestWindowStart(nowMs: number, windowSeconds = INGEST_WINDOW_SECONDS): number {
  const nowSec = Math.floor(nowMs / 1000);
  return Math.floor(nowSec / windowSeconds) * windowSeconds;
}

export type IngestRateLimitResult = {
  allowed: boolean;
  count: number;
  limit: number;
  retryAfterSeconds: number;
};

export async function consumeIngestRateLimit(
  db: D1Database,
  endpointId: string,
  limit: number,
  nowMs = Date.now(),
  windowSeconds = INGEST_WINDOW_SECONDS,
): Promise<IngestRateLimitResult> {
  const windowStart = ingestWindowStart(nowMs, windowSeconds);
  const nowSec = Math.floor(nowMs / 1000);
  const retryAfterSeconds = Math.max(1, windowStart + windowSeconds - nowSec);

  const row = await db
    .prepare(
      `INSERT INTO ingest_rate_windows (endpoint_id, window_start, count)
       VALUES (?, ?, 1)
       ON CONFLICT(endpoint_id, window_start) DO UPDATE SET count = count + 1
       RETURNING count`,
    )
    .bind(endpointId, windowStart)
    .first<{ count: number }>();

  const count = row?.count ?? 1;

  await db
    .prepare("DELETE FROM ingest_rate_windows WHERE window_start < ?")
    .bind(windowStart - windowSeconds)
    .run();

  return {
    allowed: count <= limit,
    count,
    limit,
    retryAfterSeconds,
  };
}
