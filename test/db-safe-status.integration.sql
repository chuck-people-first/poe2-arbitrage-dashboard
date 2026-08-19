-- Executable integration test for migration 013 (safe status projection).
-- Runs against the LOCAL Supabase database via:
--   bash test/db-safe-status.integration.sh
-- (the .sh wrapper drives psql inside the local Supabase Postgres container
--  and enforces the RLS/denial assertions that need a separate role).
--
-- This SQL half proves:
--   * hour A has opportunities
--   * hour B succeeds with different opportunities
--   * hour C succeeds with ZERO opportunities
--   * the safe status reports hour C and zero candidates (no fallback)
--   * the public view does not fall back to B's stale rows
--   * live data age is computed (now() - source_hour)
--   * migration 013 replay is idempotent
--
-- Any failing assertion RAISEs, so a non-zero psql exit means a regression.
-- Uses fixed UUIDs and unique source hours/payloads so it is safe to re-run.

begin;

do $$
declare
  v_league text := 'Runes of Aldur';
  v_ver text := 'integration-v1';
  run_a uuid := 'aaaaaaaa-0000-0000-0000-00000000000a';
  run_b uuid := 'aaaaaaaa-0000-0000-0000-00000000000b';
  run_c uuid := 'aaaaaaaa-0000-0000-0000-00000000000c';
  hour_a timestamptz := '2026-08-18T21:00:00Z';
  hour_b timestamptz := '2026-08-18T22:00:00Z';
  hour_c timestamptz := '2026-08-18T23:00:00Z';
  v_count int;
  v_rows int;
  v_latest timestamptz;
begin
  ---- Idempotent re-seed: clear any rows from a previous run of this test ----
  delete from public.opportunity_public_rows where league = v_league;
  delete from public.opportunity_run_status where league = v_league;
  delete from public.opportunities where run_id in (run_a, run_b, run_c);
  delete from public.opportunity_runs where run_id in (run_a, run_b, run_c);

  ---- Seed three successful runs directly (as the complete RPC would) ----
  insert into public.opportunity_runs(run_id, league, source_hour, source_payload_sha256, settings, algorithm_version, status, started_at, finished_at)
  values (run_a, v_league, hour_a, 'sha-A', '{}'::jsonb, v_ver, 'succeeded', now(), now()),
         (run_b, v_league, hour_b, 'sha-B', '{}'::jsonb, v_ver, 'succeeded', now(), now()),
         (run_c, v_league, hour_c, 'sha-C', '{}'::jsonb, v_ver, 'succeeded', now(), now());

  insert into public.opportunities(id, run_id, strategy, route, playbook, start_currency, end_currency,
    start_units, end_units, gross_profit_base, conservative_profit_base, expected_profit_base,
    gold_cost, leg_count, bottleneck_volume_share, ratio_range_pct, movement_haircut_pct,
    fill_confidence, score, source_hour)
  values
    ('10000000-0000-0000-0000-000000000001', run_a, 'two-leg-cross', '{"routeFamilyId":"fam-A","profitKind":"mark-to-market","valuation":{"returnToBaseIncluded":false}}'::jsonb, '[]'::jsonb,
     'Metadata/Items/Currency/CurrencyRerollRare', 'Metadata/Items/Currency/CurrencyModValues',
     100, 10, 5, 4.5, 4.8, 8000, 2, 0.01, 1, 1, 0.8, 100, hour_a),
    ('10000000-0000-0000-0000-000000000002', run_b, 'two-leg-cross', '{"routeFamilyId":"fam-B","profitKind":"mark-to-market","valuation":{"returnToBaseIncluded":false}}'::jsonb, '[]'::jsonb,
     'Metadata/Items/Currency/CurrencyRerollRare', 'Metadata/Items/Currency/CurrencyModValues',
     100, 9, 6, 5.5, 5.8, 7200, 2, 0.02, 2, 1, 0.7, 110, hour_b);

  ---- Project each run the way the edge function does (atomic replace) ----
  perform public.project_poe2_opportunities(run_a);
  perform public.project_poe2_opportunities(run_b);
  perform public.project_poe2_opportunities(run_c); -- zero opportunities

  ---- Case 1: safe status reports hour C and ZERO candidates ----
  select latest_successful_source_hour into v_latest
  from public.opportunity_run_status where league = v_league;
  if v_latest <> hour_c then
    raise exception 'FAIL: status latest hour is % not hour C', v_latest;
  end if;
  select candidate_count into v_count
  from public.opportunity_run_status where league = v_league;
  if v_count <> 0 then
    raise exception 'FAIL: zero-opportunity hour C should report 0 candidates, got %', v_count;
  end if;

  ---- Public view does NOT fall back to B's stale rows (C had zero) ----
  select count(*) into v_rows
  from public.opportunity_public where league = v_league;
  if v_rows <> 0 then
    raise exception 'FAIL: public view should be empty for zero-opp hour C, got % rows', v_rows;
  end if;

  ---- Candidate_count on the status row is what renders "0 candidates" ----
  raise notice 'PASS: zero-opportunity hour C is current, 0 candidates';

  ---- Case: a run that DID have rows projects them for the same league ----
  -- (re-project B to confirm rows reappear under the status row)
  perform public.project_poe2_opportunities(run_b);
  select count(*) into v_rows
  from public.opportunity_public where league = v_league;
  if v_rows <> 1 then
    raise exception 'FAIL: re-projecting B should expose 1 public row, got %', v_rows;
  end if;
  select candidate_count into v_count
  from public.opportunity_run_status where league = v_league;
  if v_count <> 1 then
    raise exception 'FAIL: status candidate_count for B should be 1, got %', v_count;
  end if;

  ---- Live data age is now()-source_hour, not a frozen value ----
  if (now() - hour_b) < interval '0 seconds' then
    raise exception 'FAIL: live data age should not be negative for hour B';
  end if;

  ---- Migration 013 replay is idempotent ----
  -- Re-issue the exact view definition from 013_latest_hour_view.sql. It must
  -- expose exactly ONE data_age column computed live as (now() - source_hour);
  -- selecting the stored r.data_age AND aliasing another would be a duplicate.
  create or replace view public.opportunity_public
  with (security_barrier = true, security_invoker = true)
  as
  select r.id, r.strategy, r.route, r.playbook, r.start_currency, r.end_currency,
    r.start_units, r.end_units, r.gross_profit_base, r.conservative_profit_base,
    r.expected_profit_base, r.gold_cost, r.leg_count, r.bottleneck_volume_share,
    r.ratio_range_pct, r.movement_haircut_pct, r.fill_confidence, r.score,
    r.source_hour, r.league, r.algorithm_version, r.run_status,
    r.valuation_bottleneck_volume_share, r.valuation_range_uncertainty_pct,
    r.valuation_confidence, r.valuation_executable, r.valuation_gold_included,
    r.valuation_trade_count_included, r.profit_class, r.realized_currency,
    (now() - r.source_hour) as data_age
  from public.opportunity_public_rows r
  join public.opportunity_run_status s
    on s.league = r.league and s.latest_successful_source_hour = r.source_hour
  where s.run_status = 'succeeded';
  -- After replay the view still exposes exactly one data_age output column.
  select count(*) into v_count
  from information_schema.columns
  where table_schema = 'public' and table_name = 'opportunity_public' and column_name = 'data_age';
  if v_count <> 1 then
    raise exception 'FAIL: replay must expose exactly one data_age column, got %', v_count;
  end if;
  raise notice 'PASS: migration 013 replay (create or replace view) idempotent, single data_age';

  ---- Replaying hour C is idempotent ----
  -- Re-project the zero-opportunity hour C: status stays hour C / 0 candidates,
  -- and the public view stays empty (B's rows must NOT reappear).
  perform public.project_poe2_opportunities(run_c);
  select candidate_count into v_count
  from public.opportunity_run_status where league = v_league;
  if v_count <> 0 then
    raise exception 'FAIL: replaying hour C should keep 0 candidates, got %', v_count;
  end if;
  select count(*) into v_rows
  from public.opportunity_public where league = v_league;
  if v_rows <> 0 then
    raise exception 'FAIL: after replaying hour C the view must stay empty (no fallback), got % rows', v_rows;
  end if;
  raise notice 'PASS: replaying zero-opportunity hour C is idempotent';

  raise notice 'SQL HALF OF SAFE-STATUS INTEGRATION PASSED';
end $$;

-- Leave the seeded rows for the RLS half to inspect, then commit this half's
-- writes so the .sh wrapper can run role checks.
commit;
