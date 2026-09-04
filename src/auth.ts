import { createMiddleware } from "hono/factory";
import type { AppEnv } from "./types";
import { sha256Hex } from "./crypto";
import { jsonError } from "./errors";
import { findApiKeyByHash } from "./db";

export const requireApiKey = createMiddleware<AppEnv>(async (c, next) => {
  const header = c.req.header("Authorization");
  if (!header || !header.startsWith("Bearer ")) {
    return jsonError(c, 401, "unauthorized", "Missing Authorization: Bearer <api_key>");
  }

  const token = header.slice("Bearer ".length).trim();
  if (!token) {
    return jsonError(c, 401, "unauthorized", "Missing API key");
  }

  const key = await findApiKeyByHash(c.env.DB, await sha256Hex(token));
  if (!key) {
    return jsonError(c, 401, "unauthorized", "Invalid API key");
  }

  c.set("projectId", key.project_id);
  c.set("apiKeyId", key.id);
  await next();
});
