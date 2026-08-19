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
    algorithm_version, run_status
  )
  select o.id, o.strategy, o.route, o.playbook, o.start_currency, o.end_currency,
    o.start_units, o.end_units, o.gross_profit_base, o.conservative_profit_base,
    o.expected_profit_base, o.gold_cost, o.leg_count, o.bottleneck_volume_share,
    o.ratio_range_pct, o.movement_haircut_pct, o.fill_confidence, o.score,
    o.source_hour, v_league, v_version, 'succeeded'
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
