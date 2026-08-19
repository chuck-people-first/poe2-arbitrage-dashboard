-- Main dashboard view: only the latest successful source hour per league.
-- Older rows remain in the projection for a future history view.
create or replace view public.opportunity_public
with (security_barrier = true, security_invoker = true)
as
select id, strategy, route, playbook, start_currency, end_currency,
  start_units, end_units, gross_profit_base, conservative_profit_base,
  expected_profit_base, gold_cost, leg_count, bottleneck_volume_share,
  ratio_range_pct, movement_haircut_pct, fill_confidence, score,
  source_hour, league, algorithm_version, run_status, data_age
from public.opportunity_public_rows current_row
where current_row.source_hour = (
  select max(latest_row.source_hour)
  from public.opportunity_public_rows latest_row
  where latest_row.league = current_row.league
);
grant select on public.opportunity_public to anon, authenticated;
