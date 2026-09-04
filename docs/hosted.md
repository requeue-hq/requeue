# Hosted stack

Requeue is **open-core MIT + hosted**. This repo is the Worker. The live product surfaces are:

| Surface | URL |
| --- | --- |
| Marketing | https://getrequeue.com |
| Hosted API | https://api.getrequeue.com |
| Dashboard | https://getrequeue.com/app.html |
| JS SDK | https://github.com/requeue-hq/requeue-sdk-js |
| Org | https://github.com/requeue-hq |

`GET https://api.getrequeue.com/health` returns:

```json
{"ok":true,"service":"requeue","version":"0.1.0"}
```

The dashboard is the `app.html` inbox in [requeue-web](https://github.com/requeue-hq/requeue-web). It is client-only: paste an API base URL and Bearer key (stored in `localStorage`). It does not mint keys or proxy the Worker.

## Hosted vs local

| | Local | Hosted |
| --- | --- | --- |
| Base URL | `http://127.0.0.1:8787` (`npm run dev`) | `https://api.getrequeue.com` |
| Schema | `npm run db:migrate` | already applied on the hosted D1 |
| Management key | seed from `0001_init.sql` | **same seed** — see [api-keys.md](api-keys.md) |
| Inbox UI | serve requeue-web locally (`app.html`) | https://getrequeue.com/app.html |

There is no separate hosted-only API. Same Hono routes, same auth.

## Hosted curl

```bash
export REQUEUE_API=https://api.getrequeue.com
export REQUEUE_KEY=rq_demo_local_dev_only_do_not_use_in_prod

curl -sS "$REQUEUE_API/health"

curl -sS "$REQUEUE_API/v1/endpoints" \
  -H "Authorization: Bearer $REQUEUE_KEY" \
  -H "Content-Type: application/json" \
  -d '{"name":"Orders worker","target_url":"https://httpbin.org/post"}'
```

Use `endpoint.endpoint_key` from the response for `POST /v1/ingest/:endpointKey`. List and replay with the same Bearer key.

The hosted demo tenant is shared and public. Do not ingest private payloads there.

## SDK against hosted

```ts
import { Requeue } from "@requeue-hq/sdk";

const requeue = new Requeue({
  apiKey: process.env.REQUEUE_API_KEY ?? "rq_demo_local_dev_only_do_not_use_in_prod",
  baseUrl: "https://api.getrequeue.com",
});
```

Package: [@requeue-hq/sdk](https://github.com/requeue-hq/requeue-sdk-js).
