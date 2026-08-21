-- Safe public status projection + live data age.
--
-- PROBLEM FIXED: the old view filtered each league to max(source_hour) of
-- opportunity_public_rows. A successful ingestion hour that contained ZERO
-- opportunities produced no rows, so the previous hour stayed visible and
-- appeared current. That cannot represent "Completed HH:00 UTC — 0 candidates".
--
-- SOLUTION: an intentionally-safe per-league status table
-- (opportunity_run_status) is the single source of truth for the latest
-- successful source hour. Browser roles (anon/authenticated) may read ONLY this
-- safe status projection and the public opportunity rows the view exposes;
-- the private run and market tables remain inaccessible. When a run succeeds,
-- the projection atomically replaces that league's public rows (deleting the
-- previous league rows even when the new run contains zero opportunities),
-- inserts the new opportunity rows if any, and updates the safe status row.
--
-- Live data age: the public view computes data_age = now() - source_hour at
-- read time. It never returns the value frozen at insertion time.
--
-- COMPLETION IS ATOMIC (item 1): complete_poe2_ingestion is redefined below so
-- that inserting opportunities, marking the run successful, replacing the
-- public league projection and updating opportunity_run_status all happen in
-- ONE database transaction. A projection failure rolls the whole completion
-- back — a successful private run can never be committed with a stale public
-- projection. The Edge Function's separate project_poe2_opportunities() call
-- is removed; the function remains only as the shared projection primitive
-- (used by completion and by the deploy-time backfill).
--
-- DEPLOY-TIME BACKFILL (item 2): at the end of this migration, every league
-- with a successful run (including zero-opportunity runs) is projected
-- immediately, so the public view is populated on deployment without waiting
-- for the next Cron invocation.
--
-- VALUATION-PATH RISK (item 4): the public projection exposes the valuation
-- path liquidity/range/confidence/executability disclosure computed by the
-- engine, so the dashboard can label mark-to-market signals honestly.

-- Safe per-league status row: browser roles read this intentionally-safe
-- projection instead of any private run/market table.
create table if not exists public.opportunity_run_status (
  league text primary key,
  latest_successful_source_hour timestamptz not null,
  completed_at timestamptz not null default now(),
  candidate_count integer not null default 0,
  algorithm_version text not null,
  run_status text not null check (run_status in ('succeeded','failed','running'))
);
alter table public.opportunity_run_status enable row level security;
revoke all on public.opportunity_run_status from anon, authenticated;
grant select on public.opportunity_run_status to anon, authenticated;
drop policy if exists poe2_status_read on public.opportunity_run_status;
create policy poe2_status_read on public.opportunity_run_status
  for select to anon, authenticated using (true);
grant select, insert, update, delete on public.opportunity_run_status to service_role;

-- Extend the public projection table with the valuation-path risk disclosure
-- (item 4) and the profit classification (item 5).
alter table public.opportunity_public_rows
  add column if not exists valuation_bottleneck_volume_share numeric,
  add column if not exists valuation_range_uncertainty_pct numeric,
  add column if not exists valuation_confidence numeric,
  add column if not exists valuation_executable boolean,
  add column if not exists valuation_gold_included boolean,
  add column if not exists valuation_trade_count_included integer,
  add column if not exists profit_class text,
  add column if not exists realized_currency text;

-- The dashboard public view: only the opportunity rows belonging to each
-- league's latest SUCCESSFUL source hour (from the safe status row), so a
-- zero-opportunity successful hour surfaces as current rather than falling
-- back to the prior hour. data_age is computed live as now() - source_hour.
drop view if exists public.opportunity_public;
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
  on s.league = r.league
 and s.latest_successful_source_hour = r.source_hour
where s.run_status = 'succeeded';
grant select on public.opportunity_public to anon, authenticated;

-- Atomically project one completed successful run for its league: delete the
-- league's prior public rows (even when the new run has zero opportunities),
-- insert the new opportunity rows, then update the safe status row.
-- The valuation-risk columns are read from the route jsonb persisted by the
-- engine (route.valuation.* / route.profitClass / route.realizedCurrency).
drop function if exists public.project_poe2_opportunities(uuid);
create or replace function public.project_poe2_opportunities(p_run_id uuid)
returns void language plpgsql security invoker set search_path=public as $$
declare
  v_league text;
  v_source_hour timestamptz;
  v_version text;
  v_count integer := 0;
begin
  select r.league, r.source_hour, r.algorithm_version
    into v_league, v_source_hour, v_version
  from public.opportunity_runs r
  where r.run_id = p_run_id and r.status = 'succeeded'
  order by r.finished_at desc nulls last
  limit 1;

  if v_league is null then
    raise exception 'run % not found or not successful', p_run_id;
  end if;

  -- Atomically replace this league's public rows. A successful zero-opportunity
  -- hour still deletes the previous league rows so the dashboard cannot fall
  -- back to a stale earlier hour.
  delete from public.opportunity_public_rows where league = v_league;

  insert into public.opportunity_public_rows(
    id, strategy, route, playbook, start_currency, end_currency, start_units,
    end_units, gross_profit_base, conservative_profit_base, expected_profit_base,
    gold_cost, leg_count, bottleneck_volume_share, ratio_range_pct,
    movement_haircut_pct, fill_confidence, score, source_hour, league,
    algorithm_version, run_status,
    valuation_bottleneck_volume_share, valuation_range_uncertainty_pct,
    valuation_confidence, valuation_executable, valuation_gold_included,
    valuation_trade_count_included, profit_class, realized_currency
  )
  select o.id, o.strategy, o.route, o.playbook, o.start_currency, o.end_currency,
    o.start_units, o.end_units, o.gross_profit_base, o.conservative_profit_base,
    o.expected_profit_base, o.gold_cost, o.leg_count, o.bottleneck_volume_share,
    o.ratio_range_pct, o.movement_haircut_pct, o.fill_confidence, o.score,
    o.source_hour, v_league, v_version, 'succeeded',
    (o.route #>> '{valuation,valuationBottleneckVolumeShare}')::numeric,
    (o.route #>> '{valuation,valuationRangeUncertaintyPct}')::numeric,
    (o.route #>> '{valuation,valuationConfidence}')::numeric,
    (o.route #>> '{valuation,valuationExecutable}')::boolean,
    (o.route #>> '{valuation,valuationGoldIncluded}')::boolean,
    (o.route #>> '{valuation,valuationTradeCountIncluded}')::integer,
    o.route->>'profitClass',
    o.route->>'realizedCurrency'
  from public.opportunities o
  where o.run_id = p_run_id;
  get diagnostics v_count = row_count;

  -- Update the safe status row. The source of truth is the latest successful
  -- source hour; candidate_count lets the dashboard render "0 candidates".
  insert into public.opportunity_run_status(
    league, latest_successful_source_hour, completed_at, candidate_count,
    algorithm_version, run_status
  ) values (v_league, v_source_hour, now(), v_count, v_version, 'succeeded')
  on conflict (league) do update set
    latest_successful_source_hour = excluded.latest_successful_source_hour,
    completed_at = excluded.completed_at,
    candidate_count = excluded.candidate_count,
    algorithm_version = excluded.algorithm_version,
    run_status = excluded.run_status;
end;
$$;
revoke all on function public.project_poe2_opportunities(uuid) from public, anon, authenticated;
grant execute on function public.project_poe2_opportunities(uuid) to service_role;

-- ATOMIC COMPLETION (item 1): complete_poe2_ingestion now inserts the
-- opportunities, marks the run successful, THEN projects the league's public
-- rows and updates opportunity_run_status — all inside this single function
-- call (one transaction). If the projection raises, the entire completion
-- (including the 'succeeded' mark) rolls back, so a successful private run can
-- never be left with a stale public projection. The Edge Function must NOT
-- call project_poe2_opportunities separately.
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

  -- Same transaction: replace the league's public projection + status row.
  -- A failure here rolls back the 'succeeded' mark above (atomicity proof).
  perform public.project_poe2_opportunities(p_run_id);

  return v_count;
end;
$$;
revoke all on function public.complete_poe2_ingestion(uuid,text,timestamptz,text,jsonb) from public, anon, authenticated;
grant execute on function public.complete_poe2_ingestion(uuid,text,timestamptz,text,jsonb) to service_role;

-- DEPLOY-TIME BACKFILL (item 2): immediately populate opportunity_run_status
-- and the public view for every league that already has a successful run —
-- including runs with ZERO opportunities. Stale public rows for leagues with a
-- newer successful run are removed by the projection. No Cron wait.
do $$
declare
  r record;
begin
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
end $$;
