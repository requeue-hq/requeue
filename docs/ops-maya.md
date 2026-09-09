# Ops: mint Maya’s production key

The string `rq_demo_local_dev_only_do_not_use_in_prod` is **LOCAL ONLY**. It must not work on `https://api.getrequeue.com`.

## 1. Set the bootstrap secret

```bash
npx wrangler secret put BOOTSTRAP_SECRET
```

Paste a long random value. Store it in the team password manager. Do not commit it.

## 2. Deploy this Worker

```bash
npm run deploy
```

## 3. Mint your key (before or after revoke)

```bash
curl -sS https://api.getrequeue.com/v1/api-keys \
  -H "Content-Type: application/json" \
  -H "X-Requeue-Bootstrap-Secret: $BOOTSTRAP_SECRET" \
  -d '{"name":"Maya production","project_name":"Production"}'
```

Save `api_key.token` (shown once). Use it as `Authorization: Bearer` on the dashboard and in the SDK.

To mint another key later:

```bash
curl -sS https://api.getrequeue.com/v1/api-keys \
  -H "Authorization: Bearer $REQUEUE_KEY" \
  -H "Content-Type: application/json" \
  -d '{"name":"Maya laptop"}'
```

## 4. Invalidate the public demo key in D1

Apply the revoke migration (preferred):

```bash
npm run db:migrate:remote
```

`0002_revoke_public_demo_key.sql` deletes `key_demo` and/or hash `ea489957fc62094c0071d21898c261e18b9c04daedb39bc2f8392137fd6a6ccb`.

If you need to revoke immediately without waiting on migrate:

```bash
npx wrangler d1 execute requeue --remote --command \
  "DELETE FROM api_keys WHERE id = 'key_demo' OR key_hash = 'ea489957fc62094c0071d21898c261e18b9c04daedb39bc2f8392137fd6a6ccb';"
```

If the demo key still works and this Worker is already deployed, you can also delete it with the demo Bearer:

```bash
curl -sS -X DELETE https://api.getrequeue.com/v1/api-keys/key_demo \
  -H "Authorization: Bearer rq_demo_local_dev_only_do_not_use_in_prod"
```

## 5. Confirm the demo key is dead

```bash
curl -sS https://api.getrequeue.com/v1/events \
  -H "Authorization: Bearer rq_demo_local_dev_only_do_not_use_in_prod"
```

Expect `401` / `Invalid API key`. Then confirm your minted key still works:

```bash
curl -sS https://api.getrequeue.com/v1/billing \
  -H "Authorization: Bearer $REQUEUE_KEY"
```

Do not apply `scripts/seed-local.sql` to remote D1.

## Waitlist signups

`POST /v1/waitlist` writes to the D1 `waitlist` table (no auth). After `0004_waitlist.sql` is applied remotely:

```bash
npx wrangler d1 execute requeue --remote --command \
  "SELECT email, product, source, created_at FROM waitlist ORDER BY created_at DESC LIMIT 50;"
```

See [waitlist.md](waitlist.md).
