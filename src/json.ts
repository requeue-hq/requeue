export function parseJson(value: string | null): unknown {
  if (value == null) return null;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function truncate(value: string, max = 8_192): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max)}…`;
}
