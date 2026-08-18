-- Phase 2 atomic RPCs used by the hourly worker.
-- PostgREST cannot run DDL, but it can call these pre-installed functions.
-- They keep market upsert/run creation and run completion/state update atomic.

create or replace function public.begin_poe2_ingestion(
  p_league text,
  p_source_hour timestamptz,
  p_payload_sha256 text,
  p_settings jsonb,
  p_algorithm_version text,
  p_markets jsonb
)
returns table(status text, run_id uuid, market_rows integer)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_run_id uuid;
  v_count integer := 0;
begin
  if exists (
    select 1 from public.opportunity_runs
    where league = p_league and source_hour = p_source_hour
      and algorithm_version = p_algorithm_version and status = 'succeeded'
      and source_payload_sha256 = p_payload_sha256
  ) then
    return query select 'skipped'::text, null::uuid, 0;
    return;
  end if;

  insert into public.market_hours(
    source, realm, league, completed_hour, market_id, pair_a, pair_b,
    volume_traded, lowest_stock, highest_stock, lowest_ratio, highest_ratio,
    payload_sha256
  )
  select 'ggg-hourly', 'poe2', p_league, p_source_hour,
    row->>'marketId', row->>'pairA', row->>'pairB',
    row->'volumeTraded', row->'lowestStock', row->'highestStock',
    row->'lowestRatio', row->'highestRatio', p_payload_sha256
  from jsonb_array_elements(p_markets) row
  on conflict (source, realm, league, completed_hour, market_id)
  do update set
    volume_traded = excluded.volume_traded,
    lowest_stock = excluded.lowest_stock,
    highest_stock = excluded.highest_stock,
    lowest_ratio = excluded.lowest_ratio,
    highest_ratio = excluded.highest_ratio,
    fetched_at = now(),
    payload_sha256 = excluded.payload_sha256;
  get diagnostics v_count = row_count;

  insert into public.opportunity_runs(
    league, source_hour, source_payload_sha256, settings,
    algorithm_version, status, started_at, error
  ) values (
    p_league, p_source_hour, p_payload_sha256, p_settings,
    p_algorithm_version, 'running', now(), null
  )
  on conflict (league, source_hour, algorithm_version)
  do update set
    source_payload_sha256 = excluded.source_payload_sha256,
    settings = excluded.settings,
    status = 'running',
    started_at = now(),
    finished_at = null,
    error = null
  returning opportunity_runs.run_id into v_run_id;

  return query select 'started'::text, v_run_id, v_count;
end;
$$;

create or replace function public.complete_poe2_ingestion(
  p_run_id uuid,
  p_league text,
  p_source_hour timestamptz,
  p_payload_sha256 text,
  p_opportunities jsonb
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count integer := 0;
begin
  delete from public.opportunities where run_id = p_run_id;
  insert into public.opportunities(
    run_id, strategy, route, playbook, start_currency, end_currency,
    start_units, end_units, gross_profit_base, conservative_profit_base,
    expected_profit_base, gold_cost, leg_count, bottleneck_volume_share,
    ratio_range_pct, movement_haircut_pct, fill_confidence, score,
    source_hour
  )
  select p_run_id,
    row->>'strategy', row->'route', row->'playbook', row->>'startCurrency',
    row->>'endCurrency', (row->>'startUnits')::numeric, (row->>'endUnits')::numeric,
    (row->>'grossProfitBase')::numeric, (row->>'conservativeProfitBase')::numeric,
    (row->>'expectedProfitBase')::numeric, (row->>'goldCost')::numeric,
    (row->>'legCount')::smallint, (row->>'bottleneckVolumeShare')::numeric,
    (row->>'ratioRangePct')::numeric, (row->>'movementHaircutPct')::numeric,
    (row->>'fillConfidence')::numeric, (row->>'score')::numeric, p_source_hour
  from jsonb_array_elements(p_opportunities) row;
  get diagnostics v_count = row_count;

  update public.opportunity_runs
  set status = 'succeeded', finished_at = now(), error = null
  where run_id = p_run_id;

  insert into public.ingestion_state(
    singleton, last_successful_source_hour, last_payload_sha256,
    last_run_id, last_heartbeat, last_error, updated_at
  ) values (true, p_source_hour, p_payload_sha256, p_run_id, now(), null, now())
  on conflict (singleton) do update set
    last_successful_source_hour = excluded.last_successful_source_hour,
    last_payload_sha256 = excluded.last_payload_sha256,
    last_run_id = excluded.last_run_id,
    last_heartbeat = now(),
    last_error = null,
    updated_at = now();

  return v_count;
exception when others then
  update public.opportunity_runs set status = 'failed', finished_at = now(), error = sqlerrm
    where run_id = p_run_id;
  raise;
end;
$$;

revoke all on function public.begin_poe2_ingestion(text,timestamptz,text,jsonb,text,jsonb) from public, anon, authenticated;
revoke all on function public.complete_poe2_ingestion(uuid,text,timestamptz,text,jsonb) from public, anon, authenticated;
grant execute on function public.begin_poe2_ingestion(text,timestamptz,text,jsonb,text,jsonb) to service_role;
grant execute on function public.complete_poe2_ingestion(uuid,text,timestamptz,text,jsonb) to service_role;
