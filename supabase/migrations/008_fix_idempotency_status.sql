-- Qualify the table status column so it cannot collide with the function's
-- OUT parameter named status during idempotency checks.
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
security invoker
set search_path = public
as $$
declare
  v_run_id uuid;
  v_count integer := 0;
begin
  if exists (
    select 1 from public.opportunity_runs existing_run
    where existing_run.league = p_league and existing_run.source_hour = p_source_hour
      and existing_run.algorithm_version = p_algorithm_version
      and existing_run.status = 'succeeded'
      and existing_run.source_payload_sha256 = p_payload_sha256
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
    row->>'marketId', row->>'pairA', row->>'pairB', row->'volumeTraded',
    row->'lowestStock', row->'highestStock', row->'lowestRatio',
    row->'highestRatio', p_payload_sha256
  from jsonb_array_elements(p_markets) row
  on conflict (source, realm, league, completed_hour, market_id)
  do update set volume_traded = excluded.volume_traded,
    lowest_stock = excluded.lowest_stock, highest_stock = excluded.highest_stock,
    lowest_ratio = excluded.lowest_ratio, highest_ratio = excluded.highest_ratio,
    fetched_at = now(), payload_sha256 = excluded.payload_sha256;
  get diagnostics v_count = row_count;

  insert into public.opportunity_runs(
    league, source_hour, source_payload_sha256, settings,
    algorithm_version, status, started_at, error
  ) values (
    p_league, p_source_hour, p_payload_sha256, p_settings,
    p_algorithm_version, 'running', now(), null
  )
  on conflict (league, source_hour, algorithm_version)
  do update set source_payload_sha256 = excluded.source_payload_sha256,
    settings = excluded.settings, status = 'running', started_at = now(),
    finished_at = null, error = null
  returning opportunity_runs.run_id into v_run_id;

  return query select 'started'::text, v_run_id, v_count;
end;
$$;

revoke all on function public.begin_poe2_ingestion(text,timestamptz,text,jsonb,text,jsonb) from public, anon, authenticated;
grant execute on function public.begin_poe2_ingestion(text,timestamptz,text,jsonb,text,jsonb) to service_role;
