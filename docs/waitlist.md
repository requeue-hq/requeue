# Waitlist capture

`POST /v1/waitlist` is unauthenticated. The marketing site can submit an email without opening a mail client.

Hosted URL: `https://api.getrequeue.com/v1/waitlist`

## Request

```http
POST /v1/waitlist
Content-Type: application/json
Origin: https://getrequeue.com
```

```json
{
  "email": "founder@example.com",
  "product": "requeue",
  "source": "getrequeue.com"
}
```

| Field | Required | Notes |
| --- | --- | --- |
| `email` | yes | Trimmed and stored lowercase |
| `product` | no | Short string (max 128 chars) |
| `source` | no | Short string (max 128 chars), e.g. `getrequeue.com` |

Re-submitting the same email returns success and updates optional fields. No Bearer key.

## Response

```json
{"ok":true}
```

| Status | `error.code` | When |
| --- | --- | --- |
| `400` | `invalid_email` | Missing or malformed `email` |
| `400` | `invalid_body` | Body is not a JSON object, or `product`/`source` are invalid |
| `429` | `rate_limited` | More than 10 POSTs / minute / client IP (`Retry-After` set) |

CORS allows `https://getrequeue.com` and `https://www.getrequeue.com` (other origins stay permitted so the dashboard and self-hosted UIs keep working).

Rows land in the D1 `waitlist` table (migration `0004_waitlist.sql`). The Worker also logs each signup. Override the light rate limit with Worker binding `WAITLIST_RATE_LIMIT`.

The static site at [getrequeue.com](https://getrequeue.com) is not wired in this repo — a follow-up on `requeue-web` should `fetch` this endpoint.
