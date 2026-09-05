-- Security: revoke the historical public demo management key if 0001 seeded it.
-- Plaintext rq_demo_local_dev_only_do_not_use_in_prod must not work on hosted D1.
DELETE FROM api_keys
WHERE id = 'key_demo'
   OR key_hash = 'ea489957fc62094c0071d21898c261e18b9c04daedb39bc2f8392137fd6a6ccb';
