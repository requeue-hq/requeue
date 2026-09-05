-- LOCAL ONLY. Applied by `npm run db:migrate` / `npm run db:seed:local`.
-- Never apply this file to remote/hosted D1.
-- Plaintext (local wrangler/dev only): rq_demo_local_dev_only_do_not_use_in_prod

INSERT OR IGNORE INTO projects (id, name) VALUES ('prj_demo', 'Demo project');

INSERT OR REPLACE INTO api_keys (id, project_id, name, key_hash, key_prefix)
VALUES (
  'key_demo',
  'prj_demo',
  'Local development key (not valid on hosted)',
  'ea489957fc62094c0071d21898c261e18b9c04daedb39bc2f8392137fd6a6ccb',
  'rq_demo_'
);
