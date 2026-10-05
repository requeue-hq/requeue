/** Upstream wait. Under Stripe's ~20s webhook timeout so a capture can still return 200. */
export const RELAY_UPSTREAM_TIMEOUT_MS = 10_000;

/** Ack bodies are tiny. Cap what we copy back to the provider. */
export const RELAY_RESPONSE_BODY_MAX_BYTES = 64 * 1024;

export const RELAY_LOOP_REASON = "relay: loop";

const REQUEUE_API_HOSTS = new Set(["api.getrequeue.com"]);

/** This Worker's own ingest and relay paths. A target on those paths would call us again. */
const REQUEUE_INGEST_PATH = /^\/v1\/(?:relay|ingest)(?:\/|$)/i;

const HOP_BY_HOP = new Set([
  "host",
  "content-length",
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "forwarded",
  "via",
  "expect",
]);

/**
 * Headers copied onto the upstream POST and stored for replay.
 * Values are kept as received. Fetch stores names lowercase; HTTP treats them as case-insensitive.
 * Provider signatures (`Stripe-Signature`, `svix-id`, `svix-timestamp`, `svix-signature`) pass.
 */
export function isRelayForwardHeader(name: string): boolean {
  const lower = name.toLowerCase();
  if (HOP_BY_HOP.has(lower)) return false;
  if (lower.startsWith("x-requeue-")) return false;
  if (lower.startsWith("cf-")) return false;
  if (lower.startsWith("x-forwarded-")) return false;
  if (lower === "x-real-ip" || lower === "true-client-ip" || lower === "cdn-loop") return false;
  return true;
}

export function collectRelayHeaders(headers: Headers): Record<string, string> {
  const forwarded: Record<string, string> = {};
  headers.forEach((value, key) => {
    if (isRelayForwardHeader(key)) forwarded[key] = value;
  });
  return forwarded;
}

export function isRequeueLoopTarget(targetUrl: string, requestUrl: string): boolean {
  let target: URL;
  try {
    target = new URL(targetUrl);
  } catch {
    return false;
  }
  if (!REQUEUE_INGEST_PATH.test(target.pathname)) return false;

  const targetHost = target.hostname.toLowerCase();
  if (REQUEUE_API_HOSTS.has(targetHost)) return true;

  try {
    return targetHost === new URL(requestUrl).hostname.toLowerCase();
  } catch {
    return false;
  }
}

export function relayReasonForStatus(status: number): string {
  return `relay: upstream ${status}`;
}

export function relayReasonForFetchError(err: unknown): string {
  if (isTimeoutError(err)) return "relay: timeout";
  return "relay: network error";
}

function isTimeoutError(err: unknown): boolean {
  if (!err || typeof err !== "object" || !("name" in err)) return false;
  const name = String(err.name);
  return name === "TimeoutError" || name === "AbortError";
}

export type RelayForwardResult =
  | { ok: true; response: Response }
  | { ok: false; reason: string };

export async function forwardRelay(
  targetUrl: string,
  body: string,
  headers: Record<string, string>,
  timeoutMs = RELAY_UPSTREAM_TIMEOUT_MS,
): Promise<RelayForwardResult> {
  const outbound = new Headers();
  for (const [key, value] of Object.entries(headers)) {
    outbound.set(key, value);
  }

  try {
    const response = await fetch(targetUrl, {
      method: "POST",
      headers: outbound,
      body,
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (response.ok) {
      return { ok: true, response: await relayPassthroughResponse(response) };
    }
    const reason = relayReasonForStatus(response.status);
    await response.body?.cancel().catch(() => undefined);
    return { ok: false, reason };
  } catch (err) {
    return { ok: false, reason: relayReasonForFetchError(err) };
  }
}

/** Status, content-type, and a capped body. Other upstream headers (for example set-cookie) stay here. */
export async function relayPassthroughResponse(response: Response): Promise<Response> {
  const headers = new Headers();
  const contentType = response.headers.get("content-type");
  if (contentType) headers.set("content-type", contentType);

  if (response.status === 204 || response.status === 205 || response.status === 304) {
    await response.body?.cancel().catch(() => undefined);
    return new Response(null, { status: response.status, headers });
  }

  const body = await readCappedText(response, RELAY_RESPONSE_BODY_MAX_BYTES);
  return new Response(body, { status: response.status, headers });
}

export async function readCappedText(response: Response, maxBytes: number): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";

  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (total < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;
      const room = maxBytes - total;
      if (value.byteLength > room) {
        chunks.push(value.subarray(0, room));
        total += room;
        break;
      }
      chunks.push(value);
      total += value.byteLength;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }

  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
}
