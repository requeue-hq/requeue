export const DEFAULT_INGEST_LIMIT_PER_WINDOW = 60;
export const DEFAULT_WAITLIST_LIMIT_PER_WINDOW = 10;
export const INGEST_WINDOW_SECONDS = 60;

export function parseIngestRateLimit(value: string | undefined): number {
  return parsePositiveLimit(value, DEFAULT_INGEST_LIMIT_PER_WINDOW);
}

export function parseWaitlistRateLimit(value: string | undefined): number {
  return parsePositiveLimit(value, DEFAULT_WAITLIST_LIMIT_PER_WINDOW);
}

function parsePositiveLimit(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
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
  return consumeKeyedRateLimit(
    db,
    "ingest_rate_windows",
    "endpoint_id",
    endpointId,
    limit,
    nowMs,
    windowSeconds,
  );
}

export async function consumeWaitlistRateLimit(
  db: D1Database,
  clientKey: string,
  limit: number,
  nowMs = Date.now(),
  windowSeconds = INGEST_WINDOW_SECONDS,
): Promise<IngestRateLimitResult> {
  return consumeKeyedRateLimit(
    db,
    "waitlist_rate_windows",
    "client_key",
    clientKey,
    limit,
    nowMs,
    windowSeconds,
  );
}

async function consumeKeyedRateLimit(
  db: D1Database,
  table: "ingest_rate_windows" | "waitlist_rate_windows",
  keyColumn: "endpoint_id" | "client_key",
  key: string,
  limit: number,
  nowMs: number,
  windowSeconds: number,
): Promise<IngestRateLimitResult> {
  const windowStart = ingestWindowStart(nowMs, windowSeconds);
  const nowSec = Math.floor(nowMs / 1000);
  const retryAfterSeconds = Math.max(1, windowStart + windowSeconds - nowSec);

  const row = await db
    .prepare(
      `INSERT INTO ${table} (${keyColumn}, window_start, count)
       VALUES (?, ?, 1)
       ON CONFLICT(${keyColumn}, window_start) DO UPDATE SET count = count + 1
       RETURNING count`,
    )
    .bind(key, windowStart)
    .first<{ count: number }>();

  const count = row?.count ?? 1;

  await db
    .prepare(`DELETE FROM ${table} WHERE window_start < ?`)
    .bind(windowStart - windowSeconds)
    .run();

  return {
    allowed: count <= limit,
    count,
    limit,
    retryAfterSeconds,
  };
}
