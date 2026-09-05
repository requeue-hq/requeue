import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";

if (!env.TEST_MIGRATIONS) {
  throw new Error("TEST_MIGRATIONS binding is missing; check vitest.config.ts");
}

await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);

// Re-apply the local-only demo key after 0002 revokes it from shared migrations.
// Keep this in sync with scripts/seed-local.sql (D1 exec() is unreliable for this file).
await env.DB.prepare("INSERT OR IGNORE INTO projects (id, name) VALUES (?, ?)").bind("prj_demo", "Demo project").run();
await env.DB
  .prepare(
    `INSERT OR REPLACE INTO api_keys (id, project_id, name, key_hash, key_prefix)
     VALUES (?, ?, ?, ?, ?)`,
  )
  .bind(
    "key_demo",
    "prj_demo",
    "Local development key (not valid on hosted)",
    "ea489957fc62094c0071d21898c261e18b9c04daedb39bc2f8392137fd6a6ccb",
    "rq_demo_",
  )
  .run();
