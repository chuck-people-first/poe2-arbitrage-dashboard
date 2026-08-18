-- Public-safe projection: browser roles read this table only; all source tables
-- remain private. The security-invoker view below is its only public interface.
create table if not exists public.opportunity_public_rows (
  id uuid primary key,
  strategy text not null,
  route jsonb not null,
  playbook jsonb not null,
  start_currency text not null,
  end_currency text not null,
  start_units numeric not null,
  end_units numeric not null,
  gross_profit_base numeric not null,
  conservative_profit_base numeric not null,
  expected_profit_base numeric not null,
  gold_cost numeric not null,
  leg_count smallint not null,
  bottleneck_volume_share numeric not null,
  ratio_range_pct numeric not null,
  movement_haircut_pct numeric not null,
  fill_confidence numeric not null,
  score numeric not null,
  source_hour timestamptz not null,
  league text not null,
  algorithm_version text not null,
  run_status text not null default 'succeeded',
  data_age interval not null default interval '0 seconds'
);
alter table public.opportunity_public_rows enable row level security;
revoke all on public.opportunity_public_rows from anon, authenticated;
grant select on public.opportunity_public_rows to anon, authenticated;
drop policy if exists poe2_public_projection_read on public.opportunity_public_rows;
create policy poe2_public_projection_read on public.opportunity_public_rows
  for select to anon, authenticated using (true);
grant select, insert, update, delete on public.opportunity_public_rows to service_role;

-- Replace the view with an invoker view over the intentionally public-safe table.
drop view if exists public.opportunity_public;
create view public.opportunity_public
with (security_barrier = true, security_invoker = true)
as
select id, strategy, route, playbook, start_currency, end_currency,
  start_units, end_units, gross_profit_base, conservative_profit_base,
  expected_profit_base, gold_cost, leg_count, bottleneck_volume_share,
  ratio_range_pct, movement_haircut_pct, fill_confidence, score,
  source_hour, league, algorithm_version, run_status, data_age
from public.opportunity_public_rows;
grant select on public.opportunity_public to anon, authenticated;

-- Backfill the current successful run without exposing private tables.
insert into public.opportunity_public_rows(
  id, strategy, route, playbook, start_currency, end_currency, start_units,
  end_units, gross_profit_base, conservative_profit_base, expected_profit_base,
  gold_cost, leg_count, bottleneck_volume_share, ratio_range_pct,
  movement_haircut_pct, fill_confidence, score, source_hour, league,
  algorithm_version, run_status, data_age
)
select o.id, o.strategy, o.route, o.playbook, o.start_currency, o.end_currency,
  o.start_units, o.end_units, o.gross_profit_base, o.conservative_profit_base,
  o.expected_profit_base, o.gold_cost, o.leg_count, o.bottleneck_volume_share,
  o.ratio_range_pct, o.movement_haircut_pct, o.fill_confidence, o.score,
  o.source_hour, r.league, r.algorithm_version, 'succeeded', now() - o.source_hour
from public.opportunities o join public.opportunity_runs r on r.run_id=o.run_id
where r.status='succeeded'
on conflict (id) do update set source_hour=excluded.source_hour, data_age=excluded.data_age;

-- Keep the public projection synchronized for future atomic completions.
create or replace function public.project_poe2_opportunities(p_run_id uuid)
returns void language plpgsql security invoker set search_path=public as $$
begin
  delete from public.opportunity_public_rows where id in (select id from public.opportunities where run_id=p_run_id);
  insert into public.opportunity_public_rows(
    id, strategy, route, playbook, start_currency, end_currency, start_units,
    end_units, gross_profit_base, conservative_profit_base, expected_profit_base,
    gold_cost, leg_count, bottleneck_volume_share, ratio_range_pct,
    movement_haircut_pct, fill_confidence, score, source_hour, league,
    algorithm_version, run_status, data_age
  )
  select o.id, o.strategy, o.route, o.playbook, o.start_currency, o.end_currency,
    o.start_units, o.end_units, o.gross_profit_base, o.conservative_profit_base,
    o.expected_profit_base, o.gold_cost, o.leg_count, o.bottleneck_volume_share,
    o.ratio_range_pct, o.movement_haircut_pct, o.fill_confidence, o.score,
    o.source_hour, r.league, r.algorithm_version, 'succeeded', now() - o.source_hour
  from public.opportunities o join public.opportunity_runs r on r.run_id=o.run_id
  where o.run_id=p_run_id;
end;
$$;
revoke all on function public.project_poe2_opportunities(uuid) from public, anon, authenticated;
grant execute on function public.project_poe2_opportunities(uuid) to service_role;
