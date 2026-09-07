#!/usr/bin/env bash
# Apply pending remote D1 migrations for CI.
#
# Wrangler only applies files not listed in d1_migrations. If hosted D1 was
# migrated manually, that table can be empty while projects/etc. already
# exist — apply then re-runs 0001 and fails with SQLITE_ERROR "already exists".
#
# This wrapper keeps applying pending files, but treats known "already
# applied" schema conflicts as success so wrangler deploy can still run.
# It does not DROP tables or invent other schema SQL.
#
# Override the apply command with D1_MIGRATE_CMD (tests / local dry-runs).

set -eu

if [ -n "${D1_MIGRATE_CMD:-}" ]; then
  set +e
  output="$(bash -lc "$D1_MIGRATE_CMD" 2>&1)"
  status=$?
  set -e
else
  set +e
  output="$(npx wrangler d1 migrations apply requeue --remote 2>&1)"
  status=$?
  set -e
fi

printf '%s\n' "$output"

if [ "$status" -eq 0 ]; then
  echo "Remote D1 migrations applied (or none pending)."
  exit 0
fi

# Match schema-already-present only. Do not treat generic D1 7500 (API /
# internal) errors as success.
if printf '%s\n' "$output" | grep -qiE 'already exists|duplicate column'; then
  echo "::warning::Remote D1 schema already exists; wrangler d1_migrations is likely empty or out of sync."
  echo "Deploy will continue. Sync d1_migrations once so future pending files apply — see CI.md."
  exit 0
fi

echo "::error::Remote D1 migration failed."
exit "$status"
