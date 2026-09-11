export type EventStatus = "failed" | "pending_replay" | "replayed" | "replay_failed";

export type AppVariables = {
  projectId: string;
  apiKeyId: string;
};

export type AppEnv = {
  Bindings: CloudflareBindings;
  Variables: AppVariables;
};

export type ProjectRow = {
  id: string;
  name: string;
  created_at: string;
};

export type EndpointRow = {
  id: string;
  project_id: string;
  name: string;
  endpoint_key: string;
  target_url: string;
  secret: string | null;
  created_at: string;
  deleted_at: string | null;
};

export type EventRow = {
  id: string;
  endpoint_id: string;
  status: EventStatus;
  payload: string;
  content_type: string;
  headers: string | null;
  reason: string | null;
  source: string | null;
  created_at: string;
  updated_at: string;
  retry_count: number;
  next_retry_at: string | null;
};

export type ReplayAttemptRow = {
  id: string;
  event_id: string;
  attempted_at: string;
  success: number;
  status_code: number | null;
  response_body: string | null;
  error: string | null;
};

export type ApiKeyRow = {
  id: string;
  project_id: string;
  name: string;
  key_hash: string;
  key_prefix: string;
  created_at: string;
};

export type WaitlistRow = {
  id: string;
  email: string;
  product: string | null;
  source: string | null;
  created_at: string;
};
