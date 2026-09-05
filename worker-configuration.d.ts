interface CloudflareBindings {
  DB: D1Database;
  BOOTSTRAP_SECRET?: string;
  TEST_MIGRATIONS?: D1Migration[];
  TEST_LOCAL_SEED?: string;
}

interface D1Migration {
  name: string;
  queries: string[];
}

declare namespace Cloudflare {
  interface Env extends CloudflareBindings {}
}
