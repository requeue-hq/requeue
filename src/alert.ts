import type { EventStatus } from "./types";

/** One POST. Long enough for a small webhook, short enough to not pin the Worker. */
export const INGEST_ALERT_TIMEOUT_MS = 3_000;

export type IngestAlertEvent = {
  id: string;
  endpoint_id: string;
  status: EventStatus;
  reason: string | null;
  source: string | null;
  created_at: string;
};

/**
 * Best-effort notification after the event row is stored.
 * Network errors, timeouts, and non-2xx responses are ignored.
 * One attempt; no retry.
 */
export async function postIngestAlert(alertUrl: string, event: IngestAlertEvent): Promise<void> {
  try {
    const response = await fetch(alertUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        type: "event.ingested",
        event: {
          id: event.id,
          endpoint_id: event.endpoint_id,
          status: event.status,
          reason: event.reason,
          source: event.source,
          created_at: event.created_at,
        },
      }),
      redirect: "manual",
      signal: AbortSignal.timeout(INGEST_ALERT_TIMEOUT_MS),
    });
    await response.body?.cancel();
  } catch {
    // Alerting is not part of the ingest result.
  }
}

export function scheduleIngestAlert(
  executionCtx: { waitUntil(promise: Promise<unknown>): void } | undefined,
  alertUrl: string | null,
  event: IngestAlertEvent,
): void {
  if (!alertUrl) return;
  const task = postIngestAlert(alertUrl, event);
  try {
    executionCtx?.waitUntil(task);
  } catch {
    // A missing or broken ExecutionContext must not fail ingest.
  }
}
