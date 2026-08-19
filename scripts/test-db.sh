#!/usr/bin/env bash
# Executable database integration suite (npm run test:db).
#
# Requires the LOCAL Supabase stack (Docker Desktop + `supabase start`).
# This is intentionally NOT part of `npm test` (unit suite) because CI may not
# provide Docker. Documented usage:
#
#   supabase start
#   npm run test:db
#   supabase stop
#
# Steps:
#   1. `supabase db reset`  -> clean migration state (001-013 applied fresh;
#      this is also the strongest proof every migration replays cleanly).
#   2. Safe-status scenario + anon/authenticated role matrix + live data-age
#      advance + migration-013 file replay   (test/db-safe-status.integration.sh)
#   3. ATOMIC completion failure injection    (test/db-atomicity.integration.sql)
#   4. Migration 013 deploy-time BACKFILL     (test/db-backfill.integration.sql)
set -u
cd "$(dirname "$0")/.."

SUPABASE_PROJECT_ID="${SUPABASE_PROJECT_ID:-poe2-arbitrage-dashboard}"
DB_CONTAINER="supabase_db_${SUPABASE_PROJECT_ID}"
FAIL=0

echo "==> [1/4] Locating local Supabase stack"
if ! docker ps --format '{{.Names}}' | grep -qx "$DB_CONTAINER"; then
  echo "ERROR: $DB_CONTAINER is not running. Run 'supabase start' first (Docker Desktop must be up)." >&2
  exit 1
fi

echo "==> [1/4] Clean local migration reset"
if ! npx --yes supabase@2.115.0 db reset >/tmp/test-db-reset.log 2>&1; then
  echo "ERROR: supabase db reset failed (see /tmp/test-db-reset.log)" >&2
  exit 1
fi
echo "OK: migrations 001-013 applied from scratch"

echo "==> [2/4] Safe-status scenario + role matrix + live age + replay"
if ! bash test/db-safe-status.integration.sh; then
  echo "ERROR: safe-status integration failed" >&2
  FAIL=1
fi

echo "==> [3/4] Atomic completion failure injection"
if docker exec -i "$DB_CONTAINER" psql -U postgres -d postgres -v ON_ERROR_STOP=1 -q < test/db-atomicity.integration.sql; then
  echo "OK: atomicity failure-injection passed"
else
  echo "ERROR: atomicity failure-injection failed" >&2
  FAIL=1
fi

echo "==> [4/4] Migration 013 deploy-time backfill"
if docker exec -i "$DB_CONTAINER" psql -U postgres -d postgres -v ON_ERROR_STOP=1 -q < test/db-backfill.integration.sql; then
  echo "OK: backfill test passed"
else
  echo "ERROR: backfill test failed" >&2
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
