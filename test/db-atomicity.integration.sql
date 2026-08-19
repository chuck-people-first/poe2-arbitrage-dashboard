-- ATOMICITY FAILURE-INJECTION TEST (item 1).
-- Proves a projection error can NEVER leave: private run = succeeded while the
-- public projection is stale, because complete_poe2_ingestion inserts
-- opportunities, marks the run successful, replaces the public league
-- projection AND updates opportunity_run_status in ONE transaction.
--
-- Injection: run B's opportunity row carries a route jsonb whose
-- valuation.valuationBottleneckVolumeShare is NOT numeric. The opportunities
-- insert accepts it (jsonb), but the projection step's cast
-- (route #>> '...')::numeric fails deterministically — exactly the class of
-- failure that used to strand a successful run with a stale public view.
--
-- Any failing assertion RAISEs (psql exits non-zero via ON_ERROR_STOP).

begin;

do $$
declare
  v_league text := 'Runes of Aldur';
  v_ver text := 'atomicity-v1';
  run_a uuid := 'bbbbbbbb-0000-0000-0000-00000000000a';
  run_b uuid := 'bbbbbbbb-0000-0000-0000-00000000000b';
  hour_a timestamptz := '2026-08-18T21:00:00Z';
  hour_b timestamptz := '2026-08-18T22:00:00Z';
  v_count int;
  v_status text;
  v_rows int;
  v_hour timestamptz;
begin
  ---- Idempotent re-seed: clear rows from any previous run of this test ----
  delete from public.opportunity_public_rows where league = v_league;
  delete from public.opportunity_run_status where league = v_league;
  delete from public.opportunities where run_id in (run_a, run_b);
  delete from public.opportunity_runs where run_id in (run_a, run_b);

  ---- Hour A: a GOOD run projected through the shared primitive ----
  insert into public.opportunity_runs(run_id, league, source_hour, source_payload_sha256, settings, algorithm_version, status, started_at, finished_at)
  values (run_a, v_league, hour_a, 'sha-A', '{}'::jsonb, v_ver, 'succeeded', now(), now());
  insert into public.opportunities(id, run_id, strategy, route, playbook, start_currency, end_currency,
    start_units, end_units, gross_profit_base, conservative_profit_base, expected_profit_base,
    gold_cost, leg_count, bottleneck_volume_share, ratio_range_pct, movement_haircut_pct,
    fill_confidence, score, source_hour)
  values ('20000000-0000-0000-0000-000000000001', run_a, 'two-leg-cross',
    '{"profitClass":"mark-to-market","realizedCurrency":null,"valuation":{"valuationBottleneckVolumeShare":0.001,"valuationRangeUncertaintyPct":5,"valuationConfidence":0.8,"valuationExecutable":false,"valuationGoldIncluded":false,"valuationTradeCountIncluded":0}}'::jsonb,
    '[]'::jsonb, 'Metadata/Items/Currency/CurrencyRerollRare', 'Metadata/Items/Currency/CurrencyModValues',
    100, 10, 5, 4.5, 4.8, 8000, 2, 0.01, 1, 1, 0.8, 100, hour_a);
  perform public.project_poe2_opportunities(run_a);
  select count(*) into v_rows from public.opportunity_public where league = v_league;
  if v_rows <> 1 then raise exception 'FAIL: hour A should be publicly visible, got % rows', v_rows; end if;
  raise notice 'PASS: hour A projected and visible';

  ---- Hour B: begin a run whose projection will FAIL (bad valuation cast) ----
  insert into public.opportunity_runs(run_id, league, source_hour, source_payload_sha256, settings, algorithm_version, status, started_at)
  values (run_b, v_league, hour_b, 'sha-B', '{}'::jsonb, v_ver, 'running', now());

  ---- Complete must FAIL: the injected opportunity's route jsonb carries a
  ---- non-numeric valuation.valuationBottleneckVolumeShare, so the projection
  ---- step's numeric cast raises INSIDE the same transaction as the 'succeeded'
  ---- mark. complete_poe2_ingestion deletes/re-inserts opportunities from its
  ---- jsonb payload, so the poison row goes through the RPC exactly as the
  ---- edge function would send it.
  begin
    perform public.complete_poe2_ingestion(run_b, v_league, hour_b, 'sha-B',
      '[{"strategy":"two-leg-cross","route":{"profitClass":"mark-to-market","realizedCurrency":null,"valuation":{"valuationBottleneckVolumeShare":"not-a-number","valuationRangeUncertaintyPct":5,"valuationConfidence":0.8,"valuationExecutable":false,"valuationGoldIncluded":false,"valuationTradeCountIncluded":0}},"playbook":[],"startCurrency":"Metadata/Items/Currency/CurrencyRerollRare","endCurrency":"Metadata/Items/Currency/CurrencyModValues","startUnits":100,"endUnits":10,"grossProfitBase":5,"conservativeProfitBase":4.5,"expectedProfitBase":4.8,"goldCost":8000,"legCount":2,"bottleneckVolumeShare":0.01,"ratioRangePct":1,"movementHaircutPct":1,"fillConfidence":0.8,"score":100}]'::jsonb);
    raise exception 'FAIL: complete_poe2_ingestion should have raised on the injected projection error';
  exception when others then
    if sqlerrm like '%numeric%' then
      raise notice 'PASS: complete raised during the projection step: %', sqlerrm;
    else
      raise;
    end if;
  end;

  ---- The private run must NOT be succeeded (the whole completion rolled back) ----
  select status into v_status from public.opportunity_runs where run_id = run_b;
  if v_status = 'succeeded' then
    raise exception 'FAIL: private run B must not be succeeded after a failed projection, got %', v_status;
  end if;
  raise notice 'PASS: private run B status = % (atomic rollback held)', v_status;

  ---- The public projection must still be hour A (nothing stale from B) ----
  select count(*) into v_rows from public.opportunity_public where league = v_league;
  if v_rows <> 1 then raise exception 'FAIL: public view must still show hour A, got % rows', v_rows; end if;
  select latest_successful_source_hour into v_hour from public.opportunity_run_status where league = v_league;
  if v_hour <> hour_a then raise exception 'FAIL: status must still report hour A, got %', v_hour; end if;
  raise notice 'PASS: public view + status unchanged (hour A), no stale hour-B projection';

  raise notice 'ATOMICITY FAILURE-INJECTION TEST PASSED';
end $$;

-- History-write failure injection: a malformed closed-cycle observation must
-- roll back the rate rows, opportunity rows and run completion together.
do $$
declare
  run_c uuid := 'bbbbbbbb-0000-0000-0000-00000000000c';
  hour_c timestamptz := '2026-08-18T23:00:00Z';
  v_status text;
begin
  delete from private.flip_hourly_observations where family_id = 'atomic-history-family';
  delete from private.currency_rate_hourly where league = 'Runes of Aldur' and source_hour = hour_c;
  delete from public.opportunities where run_id = run_c;
  delete from public.opportunity_runs where run_id = run_c;
  insert into public.opportunity_runs(run_id, league, source_hour, source_payload_sha256, settings, algorithm_version, status, started_at)
    values (run_c, 'Runes of Aldur', hour_c, 'sha-C', '{}'::jsonb, 'atomicity-v1', 'running', now());
  begin
    perform public.complete_poe2_ingestion(run_c, 'Runes of Aldur', hour_c, 'sha-C',
      '[{"strategy":"closed-triangle","playbook":[],"startCurrency":"Metadata/Items/Currency/CurrencyModValues","endCurrency":"Metadata/Items/Currency/CurrencyModValues","startUnits":100,"endUnits":105,"grossProfitBase":1,"conservativeProfitBase":1,"expectedProfitBase":1,"goldCost":3,"legCount":3,"bottleneckVolumeShare":0.01,"ratioRangePct":1,"movementHaircutPct":1,"fillConfidence":0.8,"score":1,"route":{"routeFamilyId":"atomic-history-family","profitClass":"closed-realized","startCurrency":"Metadata/Items/Currency/CurrencyModValues","endCurrency":"Metadata/Items/Currency/CurrencyModValues","startUnits":100,"endUnits":105,"grossProfitBase":1,"conservativeProfitBase":1,"expectedProfitBase":1,"goldCost":3,"legCount":3,"bottleneckVolumeShare":0.01,"ratioRangePct":1,"movementHaircutPct":1,"fillConfidence":0.8,"score":1,"valuation":{"valuationBottleneckVolumeShare":0.01,"valuationRangeUncertaintyPct":1,"valuationConfidence":0.8,"valuationExecutable":true,"valuationGoldIncluded":true,"valuationTradeCountIncluded":3},"legs":[{"fromUnits":100,"toUnits":500,"rate":5,"volumeFrom":1000,"volumeTo":5000},{"fromUnits":500,"toUnits":4900,"rate":9.8,"volumeFrom":5000,"volumeTo":49000},{"fromUnits":4900,"toUnits":105,"rate":0.0214,"volumeFrom":49000,"volumeTo":1000}]},"cycle":{"closed":true,"executable":true,"familyId":"atomic-history-family","realizedProfitPer100kGold":"not-a-number","conservativeRealizedProfitDivine":1,"totalGold":3,"bottleneckVolume":1000,"maxVolumeShare":0.01,"realizedProfitDivineEquivalent":1,"finalStartingQuantity":105,"buyLeg":{"pay":100,"receive":500,"goldCost":1},"sellLeg":{"pay":500,"receive":4900,"goldCost":1},"returnLeg":{"pay":4900,"receive":105,"goldCost":1}}}]',
      '[{"direction":"exalted-to-chaos","from_currency":"exalted","to_currency":"chaos","market_id":"m","rate":5,"rate_low":5,"rate_high":5,"pay_units":100,"receive_units":500,"gold_cost":1,"from_volume":1000,"to_volume":5000,"volume_share":0.1,"fill_risk_pct":10,"executable":true,"reason":null}]');
    raise exception 'FAIL: malformed history should have raised';
  exception when others then
    if sqlerrm not like '%numeric%' then raise; end if;
  end;
  select status into v_status from public.opportunity_runs where run_id = run_c;
  if v_status <> 'running' then raise exception 'FAIL: history failure changed run status to %', v_status; end if;
  if exists (select 1 from private.flip_hourly_observations where family_id = 'atomic-history-family') then raise exception 'FAIL: history row survived rollback'; end if;
  if exists (select 1 from private.currency_rate_hourly where league = 'Runes of Aldur' and source_hour = hour_c) then raise exception 'FAIL: rate row survived rollback'; end if;
  raise notice 'ATOMIC HISTORY FAILURE-INJECTION PASSED';
end $$;

commit;
