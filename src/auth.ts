import { createMiddleware } from "hono/factory";
import type { Context } from "hono";
import type { ApiKeyRow, AppEnv } from "./types";
import { sha256Hex } from "./crypto";
import { jsonError } from "./errors";
import { findApiKeyByHash } from "./db";

export function bearerToken(header: string | undefined): string | null {
  if (!header || !header.startsWith("Bearer ")) return null;
  const token = header.slice("Bearer ".length).trim();
  return token || null;
}

export async function resolveApiKey(
  db: D1Database,
  authorizationHeader: string | undefined,
): Promise<ApiKeyRow | null> {
  const token = bearerToken(authorizationHeader);
  if (!token) return null;
  return findApiKeyByHash(db, await sha256Hex(token));
}

export const requireApiKey = createMiddleware<AppEnv>(async (c, next) => {
  const header = c.req.header("Authorization");
  if (!header || !header.startsWith("Bearer ")) {
    return jsonError(c, 401, "unauthorized", "Missing Authorization: Bearer <api_key>");
  }

  const token = bearerToken(header);
  if (!token) {
    return jsonError(c, 401, "unauthorized", "Missing API key");
  }

  const key = await resolveApiKey(c.env.DB, header);
  if (!key) {
    return jsonError(c, 401, "unauthorized", "Invalid API key");
  }

  bindApiKey(c, key);
  await next();
});

export function bindApiKey(c: Context<AppEnv>, key: ApiKeyRow): void {
  c.set("projectId", key.project_id);
  c.set("apiKeyId", key.id);
}
