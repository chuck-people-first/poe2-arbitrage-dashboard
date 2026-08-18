-- Phase 2 public read surface and retention.
-- The view is deliberately fixed-column and security-barrier; base tables have
-- no browser grants, while this view is the only public read surface.

create or replace view public.opportunity_public
with (security_barrier = true)
as
select
  o.id,
  o.strategy,
  o.route,
  o.playbook,
  o.start_currency,
  o.end_currency,
  o.start_units,
  o.end_units,
  o.gross_profit_base,
  o.conservative_profit_base,
  o.expected_profit_base,
  o.gold_cost,
  o.leg_count,
  o.bottleneck_volume_share,
  o.ratio_range_pct,
  o.movement_haircut_pct,
  o.fill_confidence,
  o.score,
  o.source_label,
  o.source_hour,
  r.league,
  r.algorithm_version,
  r.status as run_status,
  now() - r.source_hour as data_age
from public.opportunities o
join public.opportunity_runs r on r.run_id = o.run_id
where r.status = 'succeeded';

grant select on public.opportunity_public to anon, authenticated;

create or replace function public.retain_poe2_market_data()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  delete from public.market_hours where completed_hour < now() - interval '14 days';
  delete from public.opportunity_runs where source_hour < now() - interval '14 days';
  delete from public.daily_market_rollups where rollup_day < current_date - 90;
end;
$$;

revoke all on function public.retain_poe2_market_data() from public, anon, authenticated;
grant execute on function public.retain_poe2_market_data() to service_role;

comment on view public.opportunity_public is
  'Read-only hourly signals. Never label these rows Live verified; source_hour is mandatory.';
