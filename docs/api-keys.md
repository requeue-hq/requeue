# API keys

Management routes (`POST /v1/endpoints`, `GET /v1/events`, replay, billing) require:

```
Authorization: Bearer <api_key>
```

[`src/auth.ts`](../src/auth.ts) rejects missing/empty Bearer tokens, then loads `api_keys` by `sha256(token)` hex ([`src/db.ts`](../src/db.ts) `findApiKeyByHash`). A match sets `projectId` / `apiKeyId` on the request. Ingest is **not** Bearer-auth: it uses the endpoint key in `POST /v1/ingest/:endpointKey`.

## There is no create-key HTTP endpoint

This Worker does **not** expose `POST /v1/keys`, `POST /v1/api-keys`, signup, or any other route that inserts into `api_keys`. `POST /v1/endpoints` creates a replay destination + public ingest key (`epk_…`), which is a different credential.

Keys exist only as rows in D1.

## Path 1: migration seed (local and current hosted)

[`migrations/0001_init.sql`](../migrations/0001_init.sql) inserts:

- project `prj_demo` / “Demo project”
- api key `key_demo` whose `key_hash` is SHA-256 of:

```
rq_demo_local_dev_only_do_not_use_in_prod
```

Hash stored in D1: `ea489957fc62094c0071d21898c261e18b9c04daedb39bc2f8392137fd6a6ccb`  
Prefix stored: `rq_demo_`

That seed runs for:

- local Wrangler: `npm run db:migrate`
- remote / hosted: `npm run db:migrate:remote`

The production D1 behind `https://api.getrequeue.com` has this migration applied. The demo key **works on hosted today** as a shared public demo tenant. It is not a private secret.

The dashboard does not create keys either; it only sends whatever Bearer token you paste.

## Path 2: manual D1 insert (private tenant)

To add a key without an HTTP API, insert a project (or reuse one) and a hashed key:

```bash
# plaintext never goes in D1 — store only the hex digest
printf '%s' 'rq_your_private_key' | openssl dgst -sha256 -hex
```

Then, against the target D1 (local or remote):

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

Rotate the demo row (`key_demo`) before treating a Worker as private. Hosted `api.getrequeue.com` still uses the seed for the public demo.

## What a 401 means

| Message | Cause |
| --- | --- |
| `Missing Authorization: Bearer <api_key>` | No `Authorization` header or it does not start with `Bearer ` |
| `Missing API key` | `Bearer` with an empty token |
| `Invalid API key` | Hash not present in `api_keys` (wrong key, or seed never applied) |
