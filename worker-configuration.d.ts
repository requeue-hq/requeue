interface CloudflareBindings {
  DB: D1Database;
  BOOTSTRAP_SECRET?: string;
  /** Optional override for POST /v1/ingest/:endpointKey (default 60 / minute / endpoint). */
  INGEST_RATE_LIMIT?: string;
  /** Optional override for POST /v1/waitlist (default 10 / minute / client IP). */
  WAITLIST_RATE_LIMIT?: string;
  TEST_MIGRATIONS?: D1Migration[];
}

interface D1Migration {
  name: string;
  queries: string[];
}

declare namespace Cloudflare {
  interface Env extends CloudflareBindings {}
}
