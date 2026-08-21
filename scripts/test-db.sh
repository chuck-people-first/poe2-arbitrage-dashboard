#!/usr/bin/env bash
# Executable database integration suite (npm run test:db).
set -u
cd "$(dirname "$0")/.."

SUPABASE_PROJECT_ID="${SUPABASE_PROJECT_ID:-poe2-arbitrage-dashboard}"
DB_CONTAINER="supabase_db_${SUPABASE_PROJECT_ID}"
FAIL=0

echo "==> [1/5] Locating local Supabase stack"
if ! docker ps --format '{{.Names}}' | grep -qx "$DB_CONTAINER"; then
  echo "ERROR: $DB_CONTAINER is not running. Run 'supabase start' first (Docker Desktop must be up)." >&2
  exit 1
fi

echo "==> [1/5] Clean local migration reset"
if ! npx --yes supabase@2.115.0 db reset >/tmp/test-db-reset.log 2>&1; then
  echo "ERROR: supabase db reset failed (see /tmp/test-db-reset.log)" >&2
  exit 1
fi
echo "OK: migrations 001-015 applied from scratch"

echo "==> [2/5] Safe-status scenario + role matrix + live age + replay"
if ! bash test/db-safe-status.integration.sh; then
  echo "ERROR: safe-status integration failed" >&2
  FAIL=1
fi

echo "==> [3/5] Atomic completion failure injection"
if docker exec -i "$DB_CONTAINER" psql -U postgres -d postgres -v ON_ERROR_STOP=1 -q < test/db-atomicity.integration.sql; then
  echo "OK: atomicity failure-injection passed"
else
  echo "ERROR: atomicity failure-injection failed" >&2
  FAIL=1
fi

echo "==> [4/5] Migration 013 deploy-time backfill"
if docker exec -i "$DB_CONTAINER" psql -U postgres -d postgres -v ON_ERROR_STOP=1 -q < test/db-backfill.integration.sql; then
  echo "OK: backfill test passed"
else
  echo "ERROR: backfill test failed" >&2
  FAIL=1
fi

echo "==> [5/5] Compact currency rates + append-only signal history"
if docker exec -i "$DB_CONTAINER" psql -U postgres -d postgres -v ON_ERROR_STOP=1 -q < test/db-history.integration.sql; then
  echo "OK: compact history test passed"
else
  echo "ERROR: compact history test failed" >&2
  FAIL=1
fi

if [ "$FAIL" -eq 0 ]; then
  echo ""
  echo "==> ALL DATABASE INTEGRATION TESTS PASSED (npm run test:db) =="
  exit 0
else
  echo ""
  echo "==> DATABASE INTEGRATION TESTS FAILED ==" >&2
  exit 1
fi
