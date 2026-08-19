#!/usr/bin/env bash
# Executable integration test for migration 013 (safe status projection) and the
# browser-role access matrix. Drives psql inside the local Supabase Postgres
# container (multi-statement scripts cannot go through `supabase db query`).
#
# Usage:  bash test/db-safe-status.integration.sh
# Run from the repo root (the script resolves relative paths itself).
#
# Covers, end to end:
#   * hour A has opportunities
#   * hour B succeeds with different opportunities
#   * hour C succeeds with ZERO opportunities
#   * public status reports hour C with zero candidates (no fallback to B)
#   * zero-opportunity hour C leaves the public view empty (no A/B fallback)
#   * replaying hour C is idempotent
#   * live data age (now() - source_hour) increases with time, no 2nd ingestion
#   * migration 013 replays cleanly (idempotent)
#   * anon + authenticated role matrix: allowed SELECTs succeed; every
#     forbidden statement must FAIL (the test fails if one unexpectedly
#     succeeds).
set -u
cd "$(dirname "$0")/.."

SUPABASE_PROJECT_ID="${SUPABASE_PROJECT_ID:-poe2-arbitrage-dashboard}"
DB_CONTAINER="supabase_db_${SUPABASE_PROJECT_ID}"
FAIL=0

echo "==> Locating Supabase DB container"
if ! docker ps --format '{{.Names}}' | grep -qx "$DB_CONTAINER"; then
  echo "FAIL: container $DB_CONTAINER not running" >&2
  exit 1
fi

PSQL() { docker exec -i "$DB_CONTAINER" psql -U postgres -d postgres "$@"; }

echo "==> Scenario half (hour A/B/C, zero-opportunity, replay idempotency)"
if PSQL -v ON_ERROR_STOP=1 -q < test/db-safe-status.integration.sql; then
  echo "PASS: scenario half"
else
  echo "FAIL: scenario half errored" >&2
  exit 1
fi

run_allowed() { # role, label, statement  -> must SUCCEED
  local role="$1" label="$2" stmt="$3"
  if echo "set role ${role}; ${stmt}" | PSQL -v ON_ERROR_STOP=1 -q >/dev/null 2>&1; then
    echo "ALLOWED [${role}] ${label}"
  else
    echo "FAIL: allowed statement errored [${role}] ${label}: ${stmt}" >&2
    FAIL=1
  fi
}

run_denied() { # role, label, statement  -> must FAIL
  local role="$1" label="$2" stmt="$3"
  # ON_ERROR_STOP=1 makes any error exit psql non-zero. Success here is a FAILURE.
  if echo "set role ${role}; ${stmt}" | PSQL -v ON_ERROR_STOP=1 -q >/dev/null 2>&1; then
    echo "FAIL: forbidden statement unexpectedly succeeded [${role}] ${label}" >&2
    FAIL=1
  else
    echo "DENIED  [${role}] ${label}"
  fi
}

for ROLE in anon authenticated; do
  echo "==> Role matrix: ${ROLE}"
  # Allowed
  run_allowed "$ROLE" "SELECT opportunity_public"       "select count(*) from public.opportunity_public;"
  run_allowed "$ROLE" "SELECT safe run-status projection" "select league, candidate_count from public.opportunity_run_status;"
  # Denied: private run/market/opportunity tables
  run_denied  "$ROLE" "SELECT private opportunity_runs" "select * from public.opportunity_runs;"
  run_denied  "$ROLE" "SELECT private opportunities"    "select * from public.opportunities;"
  run_denied  "$ROLE" "SELECT private market_hours"     "select * from public.market_hours;"
  # Denied: writes on the public projection tables
  run_denied  "$ROLE" "INSERT public projection rows"   "insert into public.opportunity_run_status(league, latest_successful_source_hour, candidate_count, algorithm_version, run_status) values ('HACK','2026-01-01T00:00:00Z',1,'v','running');"
  run_denied  "$ROLE" "UPDATE public projection rows"   "update public.opportunity_run_status set candidate_count=999 where league='Runes of Aldur';"
  run_denied  "$ROLE" "DELETE public projection rows"   "delete from public.opportunity_run_status where league='Runes of Aldur';"
  # Denied: execute the administrative projection function
  run_denied  "$ROLE" "execute project_poe2_opportunities()" "select public.project_poe2_opportunities('aaaaaaaa-0000-0000-0000-00000000000c');"
  # Denied: administrative ingestion / retention functions
  run_denied  "$ROLE" "execute begin_poe2_ingestion()"  "select public.begin_poe2_ingestion('{}'::jsonb);"
  run_denied  "$ROLE" "execute complete_poe2_ingestion()" "select public.complete_poe2_ingestion('00000000-0000-0000-0000-000000000000','{}'::jsonb);"
  run_denied  "$ROLE" "execute fail_poe2_ingestion()"   "select public.fail_poe2_ingestion('00000000-0000-0000-0000-000000000000','x');"
  run_denied  "$ROLE" "execute retain_poe2_market_data()" "select public.retain_poe2_market_data();"
done

echo "==> Live data age increases with time (no second ingestion)"
AGE() {
  echo "set role anon; select extract(epoch from (now() - latest_successful_source_hour)) from public.opportunity_run_status where league='Runes of Aldur';" \
    | PSQL -tA -q -v ON_ERROR_STOP=1 | grep -oE '[0-9]+(\.[0-9]+)?' | head -1
}
age1="$(AGE)"
sleep 2
age2="$(AGE)"
echo "age1=${age1}s  age2=${age2}s"
if awk -v a="$age1" -v b="$age2" 'BEGIN { exit !(b > a) }'; then
  echo "PASS: data age increased from ${age1}s to ${age2}s"
else
  echo "FAIL: data age did not increase (${age1}s -> ${age2}s)" >&2
  FAIL=1
fi

echo "==> Migration 013 file replay (idempotent)"
if PSQL -v ON_ERROR_STOP=1 -q < supabase/migrations/013_latest_hour_view.sql; then
  echo "PASS: migration 013 replays cleanly"
else
  echo "FAIL: migration 013 replay failed" >&2
  FAIL=1
fi

if [ "$FAIL" -eq 0 ]; then
  echo ""
  echo "==> ALL SAFE-STATUS INTEGRATION CHECKS PASSED =="
  exit 0
else
  echo ""
  echo "==> INTEGRATION TEST FAILED ==" >&2
  exit 1
fi
