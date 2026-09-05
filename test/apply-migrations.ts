import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";

if (!env.TEST_MIGRATIONS) {
  throw new Error("TEST_MIGRATIONS binding is missing; check vitest.config.ts");
}

await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);

if (!env.TEST_LOCAL_SEED) {
  throw new Error("TEST_LOCAL_SEED binding is missing; check vitest.config.ts");
}

// Re-apply the local-only demo key after 0002 revokes it from shared migrations.
await env.DB.exec(env.TEST_LOCAL_SEED);
