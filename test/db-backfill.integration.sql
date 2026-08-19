-- BACKFILL TEST (item 2): migration 013 must initialize opportunity_run_status
-- during deployment for every league that already has a successful run —
-- including runs with ZERO opportunities — and remove stale public rows,
-- WITHOUT waiting for the next Cron invocation.
--
-- Simulates a "migration 012 state" (only private tables populated, no
-- opportunity_run_status rows, stale public rows present), then runs the exact
-- backfill loop from migration 013 and asserts the public view is populated
-- immediately.
--
-- Any failing assertion RAISEs (psql exits non-zero via ON_ERROR_STOP).

begin;

do $$
declare
  v_league1 text := 'Runes of Aldur';
  v_league2 text := 'Standard';
  v_ver text := 'backfill-v1';
  run_a uuid := 'cccccccc-0000-0000-0000-00000000000a';
  run_b uuid := 'cccccccc-0000-0000-0000-00000000000b';
  run_c uuid := 'cccccccc-0000-0000-0000-00000000000c';
  run_d uuid := 'cccccccc-0000-0000-0000-00000000000d';
  hour_a timestamptz := '2026-08-18T21:00:00Z';
  hour_b timestamptz := '2026-08-18T22:00:00Z';
  hour_c timestamptz := '2026-08-18T23:00:00Z';
  hour_d timestamptz := '2026-08-18T22:00:00Z';
  v_count int;
  v_rows int;
  v_hour timestamptz;
  r record;
begin
  ---- Clean any previous run of this test ----
  delete from public.opportunity_public_rows where league in (v_league1, v_league2);
  delete from public.opportunity_run_status where league in (v_league1, v_league2);
  delete from public.opportunities where run_id in (run_a, run_b, run_c, run_d);
  delete from public.opportunity_runs where run_id in (run_a, run_b, run_c, run_d);

  ---- 012-STATE: only the private tables are populated ----
  -- League 1: hour A has opportunities, hour B ZERO opportunities, hour C ZERO.
  -- Latest successful = C (zero opportunities) -> status must report C / 0.
  insert into public.opportunity_runs(run_id, league, source_hour, source_payload_sha256, settings, algorithm_version, status, started_at, finished_at)
  values (run_a, v_league1, hour_a, 'sha-A', '{}'::jsonb, v_ver, 'succeeded', now(), now()),
         (run_b, v_league1, hour_b, 'sha-B', '{}'::jsonb, v_ver, 'succeeded', now(), now()),
         (run_c, v_league1, hour_c, 'sha-C', '{}'::jsonb, v_ver, 'succeeded', now(), now());
  insert into public.opportunities(id, run_id, strategy, route, playbook, start_currency, end_currency,
    start_units, end_units, gross_profit_base, conservative_profit_base, expected_profit_base,
    gold_cost, leg_count, bottleneck_volume_share, ratio_range_pct, movement_haircut_pct,
    fill_confidence, score, source_hour)
  values
    ('30000000-0000-0000-0000-000000000001', run_a, 'two-leg-cross', '{"profitClass":"mark-to-market","valuation":{"valuationBottleneckVolumeShare":0.001}}'::jsonb, '[]'::jsonb, 'A','B', 100, 10, 5, 4.5, 4.8, 8000, 2, 0.01, 1, 1, 0.8, 100, hour_a),
    ('30000000-0000-0000-0000-000000000002', run_b, 'two-leg-cross', '{"profitClass":"mark-to-market","valuation":{"valuationBottleneckVolumeShare":0.001}}'::jsonb, '[]'::jsonb, 'A','B', 100, 9, 6, 5.5, 5.8, 7200, 2, 0.02, 2, 1, 0.7, 110, hour_b);
  -- League 2: hour D has one opportunity.
  insert into public.opportunity_runs(run_id, league, source_hour, source_payload_sha256, settings, algorithm_version, status, started_at, finished_at)
  values (run_d, v_league2, hour_d, 'sha-D', '{}'::jsonb, v_ver, 'succeeded', now(), now());
  insert into public.opportunities(id, run_id, strategy, route, playbook, start_currency, end_currency,
    start_units, end_units, gross_profit_base, conservative_profit_base, expected_profit_base,
    gold_cost, leg_count, bottleneck_volume_share, ratio_range_pct, movement_haircut_pct,
    fill_confidence, score, source_hour)
  values ('30000000-0000-0000-0000-000000000003', run_d, 'two-leg-cross', '{"profitClass":"mark-to-market","valuation":{"valuationBottleneckVolumeShare":0.001}}'::jsonb, '[]'::jsonb, 'A','B', 100, 11, 7, 6.5, 6.8, 8800, 2, 0.01, 1, 1, 0.8, 120, hour_d);
  -- STALE public row for league 2 (older hour) that the backfill must remove.
  insert into public.opportunity_public_rows(id, strategy, route, playbook, start_currency, end_currency,
    start_units, end_units, gross_profit_base, conservative_profit_base, expected_profit_base,
    gold_cost, leg_count, bottleneck_volume_share, ratio_range_pct, movement_haircut_pct,
    fill_confidence, score, source_hour, league, algorithm_version, run_status)
  values ('30000000-0000-0000-0000-000000000099', 'two-leg-cross', '{"stale":true}'::jsonb, '[]'::jsonb, 'A','B',
    100, 5, 1, 0.9, 0.95, 4000, 2, 0.01, 1, 1, 0.5, 10, '2026-08-18T20:00:00Z', v_league2, v_ver, 'succeeded');

  ---- Apply the migration 013 BACKFILL (exact DO block from the migration) ----
  for r in
    select distinct on (league) run_id
    from public.opportunity_runs
    where status = 'succeeded'
    order by league, source_hour desc
  loop
    begin
      perform public.project_poe2_opportunities(r.run_id);
    exception when others then
      raise notice 'backfill skipped run %: %', r.run_id, sqlerrm;
    end;
  end loop;

  ---- Assertions ----
  -- League 1: status reports hour C (latest successful, ZERO opportunities).
  select latest_successful_source_hour into v_hour from public.opportunity_run_status where league = v_league1;
  if v_hour <> hour_c then raise exception 'FAIL: league 1 status should be hour C, got %', v_hour; end if;
  select candidate_count into v_count from public.opportunity_run_status where league = v_league1;
  if v_count <> 0 then raise exception 'FAIL: league 1 candidate_count should be 0, got %', v_count; end if;
  -- League 1 public view empty (hour C had zero opportunities; B must not fall back).
  select count(*) into v_rows from public.opportunity_public where league = v_league1;
  if v_rows <> 0 then raise exception 'FAIL: league 1 public view should be empty (zero-opp hour C), got % rows', v_rows; end if;

  -- League 2: status reports hour D with 1 candidate; view shows 1 row; stale row removed.
  select latest_successful_source_hour into v_hour from public.opportunity_run_status where league = v_league2;
  if v_hour <> hour_d then raise exception 'FAIL: league 2 status should be hour D, got %', v_hour; end if;
  select candidate_count into v_count from public.opportunity_run_status where league = v_league2;
  if v_count <> 1 then raise exception 'FAIL: league 2 candidate_count should be 1, got %', v_count; end if;
  select count(*) into v_rows from public.opportunity_public where league = v_league2;
  if v_rows <> 1 then raise exception 'FAIL: league 2 public view should show exactly 1 row, got % rows', v_rows; end if;

  raise notice 'BACKFILL TEST PASSED: public view populated immediately, zero-opportunity hour C current';
end $$;

commit;
