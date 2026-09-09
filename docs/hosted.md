# Hosted stack

Requeue is **open-core MIT + hosted**. This repo is the Worker. The live product surfaces are:

| Surface | URL |
| --- | --- |
| Marketing | https://getrequeue.com |
| Hosted API | https://api.getrequeue.com |
| Dashboard | https://getrequeue.com/app |
| JS SDK | https://github.com/requeue-hq/requeue-sdk-js |

`GET https://api.getrequeue.com/health` returns:

```json
{"ok":true,"service":"requeue","version":"0.1.0"}
```

The dashboard at [getrequeue.com/app](https://getrequeue.com/app) is client-only: paste an API base URL and Bearer key (stored in `localStorage`). It does not mint keys or proxy the Worker. Point it at the hosted API or at a local `wrangler dev` Worker.

Hosted production has no public demo tenant. Join the [waitlist](https://getrequeue.com) (`POST /v1/waitlist` — [waitlist.md](waitlist.md)) or email [maya@getrequeue.com](mailto:maya@getrequeue.com) for a key. Five-minute path: [quickstart.md](quickstart.md). Operators who deploy their own Worker mint keys with `BOOTSTRAP_SECRET` — see [api-keys.md](api-keys.md).

## Hosted vs local

| | Local | Hosted |
| --- | --- | --- |
| Base URL | `http://127.0.0.1:8787` (`npm run dev`) | `https://api.getrequeue.com` |
| Schema | `npm run db:migrate` (migrations + **local-only** seed) | `npm run db:migrate:remote` (schema + demo-key revoke; **no** public seed) |
| Management key | local seed only — see [api-keys.md](api-keys.md) | key from Maya, or mint via `POST /v1/api-keys` + `BOOTSTRAP_SECRET` on your own Worker |
| Inbox UI | [getrequeue.com/app](https://getrequeue.com/app) pointed at localhost | [getrequeue.com/app](https://getrequeue.com/app) |

Same Hono routes and auth. The local demo key is **not** a hosted credential.

## Hosted curl

Use a key Maya minted, or one you minted on your own Worker ([api-keys.md](api-keys.md), [ops-maya.md](ops-maya.md)):

```bash
export REQUEUE_API=https://api.getrequeue.com
export REQUEUE_KEY=rq_your_private_key

curl -sS "$REQUEUE_API/health"

curl -sS "$REQUEUE_API/v1/endpoints" \
  -H "Authorization: Bearer $REQUEUE_KEY" \
  -H "Content-Type: application/json" \
  -d '{"name":"Orders worker","target_url":"https://httpbin.org/post"}'
```

Use `endpoint.endpoint_key` from the response for `POST /v1/ingest/:endpointKey`. List endpoints (`GET /v1/endpoints`), list events, and replay with the same Bearer key. List responses include `has_secret` and never the raw HMAC secret.

Do not send the local demo key to hosted. Do not ingest private payloads with a key you do not control.

## SDK against hosted

```ts
import { Requeue } from "@requeue-hq/sdk";

const requeue = new Requeue({
  apiKey: process.env.REQUEUE_API_KEY!,
  baseUrl: "https://api.getrequeue.com",
});
```

Package: [@requeue-hq/sdk](https://github.com/requeue-hq/requeue-sdk-js).
