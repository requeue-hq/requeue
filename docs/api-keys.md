# API keys

Management routes (`POST /v1/endpoints`, `GET /v1/endpoints`, `GET /v1/events`, replay, billing, API key admin) require:

```
Authorization: Bearer <api_key>
```

[`src/auth.ts`](../src/auth.ts) rejects missing/empty Bearer tokens, then loads `api_keys` by `sha256(token)` hex ([`src/db.ts`](../src/db.ts) `findApiKeyByHash`). A match sets `projectId` / `apiKeyId` on the request. Ingest is **not** Bearer-auth: it uses the endpoint key in `POST /v1/ingest/:endpointKey`.

`POST /v1/endpoints` creates a replay destination + public ingest key (`epk_…`). That is a different credential from a management API key.

## Local only: Wrangler seed key

[`scripts/seed-local.sql`](../scripts/seed-local.sql) inserts project `prj_demo` and the hash of:

```
rq_demo_local_dev_only_do_not_use_in_prod
```

This seed is **LOCAL ONLY**. It is applied by `npm run db:migrate` (local Wrangler D1) and by the test setup. It is **not** part of the remote/hosted D1 seed.

- Do **not** run `scripts/seed-local.sql` against remote D1.
- This key is **not** valid on `https://api.getrequeue.com`.
- Shared migrations `0001_init.sql` (schema only) and `0002_revoke_public_demo_key.sql` (deletes the historical public hash if present) are what hosted applies.

Hash stored in local D1: `ea489957fc62094c0071d21898c261e18b9c04daedb39bc2f8392137fd6a6ccb`  
Prefix stored: `rq_demo_`

## Hosted: get a key, or mint one with `BOOTSTRAP_SECRET`

Hosted production has no public demo tenant. If you want a key on `https://api.getrequeue.com`, join the [waitlist](https://getrequeue.com) or email [maya@getrequeue.com](mailto:maya@getrequeue.com). Then paste that key at [getrequeue.com/app](https://getrequeue.com/app).

If you deploy your own Worker, create the first management key with `POST /v1/api-keys` and the Worker secret `BOOTSTRAP_SECRET`.

1. Set the secret (once, not in git):

```bash
npx wrangler secret put BOOTSTRAP_SECRET
```

2. Deploy the Worker, then mint:

```bash
curl -sS https://api.getrequeue.com/v1/api-keys \
  -H "Content-Type: application/json" \
  -H "X-Requeue-Bootstrap-Secret: $BOOTSTRAP_SECRET" \
  -d '{"name":"Production key","project_name":"Production"}'
```

The response includes `api_key.token` **once**. Store it; D1 keeps only the SHA-256 hash.

3. Use that token as `Authorization: Bearer …` for management routes. To mint more keys for the same project, call `POST /v1/api-keys` with the existing Bearer token (no bootstrap header).

4. Apply remote migrations so the historical public demo row is gone:

```bash
npm run db:migrate:remote
```

`0002_revoke_public_demo_key.sql` deletes `key_demo` / the public demo hash if a previous `0001` seed inserted it.

Ops runbook for production: [ops-maya.md](ops-maya.md).

### Routes

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| `POST` | `/v1/api-keys` | `X-Requeue-Bootstrap-Secret` **or** Bearer | Mint a key (bootstrap also creates a project) |
| `GET` | `/v1/api-keys` | Bearer | List keys for the current project (id, name, prefix — never the token or hash) |
| `DELETE` | `/v1/api-keys/:id` | Bearer | Revoke a key for the current project |

If `BOOTSTRAP_SECRET` is unset, the bootstrap path returns 401. Do not put the secret in `wrangler.toml` `[vars]`.

## Manual D1 insert (break-glass)

If you cannot use the HTTP API, insert a project (or reuse one) and a hashed key:

```bash
# plaintext never goes in D1 — store only the hex digest
printf '%s' 'rq_your_private_key' | openssl dgst -sha256 -hex
```

Then, against the target D1:

```sql
INSERT INTO projects (id, name) VALUES ('prj_your_tenant', 'Your project');

INSERT INTO api_keys (id, project_id, name, key_hash, key_prefix)
VALUES (
  'key_your_tenant',
  'prj_your_tenant',
  'Management key',
  '<sha256 hex from openssl>',
  'rq_your_'
);
```

## What a 401 means

| Message | Cause |
| --- | --- |
| `Missing Authorization: Bearer <api_key>` | No `Authorization` header or it does not start with `Bearer ` |
| `Missing API key` | `Bearer` with an empty token |
| `Invalid API key` | Hash not present in `api_keys` (wrong key, or revoked) |
| `Valid API key or bootstrap secret required` | `POST /v1/api-keys` without a valid Bearer token or matching `BOOTSTRAP_SECRET` |
