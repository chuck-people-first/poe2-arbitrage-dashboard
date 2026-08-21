-- Phase B/C completion boundary: rates and closed-cycle history commit with the run.
-- Browser roles only see safe, denormalized projections; raw payload hashes and
-- private run data never cross that boundary.

-- The first version used LIKE private tables for projections. Remove the
-- payload hash from those public tables before adding the intentionally minimal
-- history fields.
drop view if exists public.currency_rates_public;
drop view if exists public.signal_history_public;
alter table public.currency_rates_projection drop column if exists payload_sha256;
alter table public.signal_history_projection drop column if exists payload_sha256;

alter table private.flip_hourly_observations
  add column if not exists buy_pay_units integer not null default 0,
  add column if not exists buy_receive_units integer not null default 0,
  add column if not exists sell_pay_units integer not null default 0,
  add column if not exists sell_receive_units integer not null default 0,
  add column if not exists return_pay_units integer not null default 0,
  add column if not exists return_receive_units integer not null default 0,
  add column if not exists buy_gold bigint not null default 0,
  add column if not exists sell_gold bigint not null default 0,
  add column if not exists return_gold bigint not null default 0,
  add column if not exists buy_volume_from numeric not null default 0,
  add column if not exists buy_volume_to numeric not null default 0,
  add column if not exists sell_volume_from numeric not null default 0,
  add column if not exists sell_volume_to numeric not null default 0,
  add column if not exists return_volume_from numeric not null default 0,
  add column if not exists return_volume_to numeric not null default 0;

alter table public.signal_history_projection
  add column if not exists buy_pay_units integer not null default 0,
  add column if not exists buy_receive_units integer not null default 0,
  add column if not exists sell_pay_units integer not null default 0,
  add column if not exists sell_receive_units integer not null default 0,
  add column if not exists return_pay_units integer not null default 0,
  add column if not exists return_receive_units integer not null default 0,
  add column if not exists buy_gold bigint not null default 0,
  add column if not exists sell_gold bigint not null default 0,
  add column if not exists return_gold bigint not null default 0,
  add column if not exists buy_volume_from numeric not null default 0,
  add column if not exists buy_volume_to numeric not null default 0,
  add column if not exists sell_volume_from numeric not null default 0,
  add column if not exists sell_volume_to numeric not null default 0,
  add column if not exists return_volume_from numeric not null default 0,
  add column if not exists return_volume_to numeric not null default 0;

-- Replace the compact public views with minimal, read-only invoker views.
drop view if exists public.currency_rates_public;
create view public.currency_rates_public
with (security_barrier = true, security_invoker = true)
as
select league, source_hour, direction, from_currency, to_currency, market_id,
  rate, rate_low, rate_high, pay_units, receive_units, gold_cost,
  from_volume, to_volume, volume_share, fill_risk_pct, executable, reason,
  now() - source_hour as source_age
from public.currency_rates_projection;
grant select on public.currency_rates_public to anon, authenticated;

 drop view if exists public.signal_history_public;
create view public.signal_history_public
with (security_barrier = true, security_invoker = true)
as
with ranked as (
  select h.*,
    count(*) over (partition by h.family_id, h.league) as sample_count,
    first_value(h.source_hour) over (partition by h.family_id, h.league order by h.source_hour) as first_seen_source_hour,
    first_value(h.div_per_100k_gold) over (partition by h.family_id, h.league order by h.source_hour) as first_detected_value,
    first_value(h.source_hour) over (partition by h.family_id, h.league order by h.div_per_100k_gold desc, h.source_hour) as best_source_hour,
    first_value(h.div_per_100k_gold) over (partition by h.family_id, h.league order by h.div_per_100k_gold desc, h.source_hour) as best_value,
    last_value(h.source_hour) over (partition by h.family_id, h.league order by h.source_hour rows between unbounded preceding and unbounded following) as latest_source_hour,
    last_value(h.div_per_100k_gold) over (partition by h.family_id, h.league order by h.source_hour rows between unbounded preceding and unbounded following) as current_value,
    max(h.source_hour) filter (where h.div_per_100k_gold > 0) over (partition by h.family_id, h.league) as last_profitable_source_hour
  from public.signal_history_projection h
)
select family_id, league, source_hour, div_per_100k_gold, conservative_profit_divine,
  gold_required, lowest_leg_volume, volume_share, buy_rate, sell_rate, return_rate,
  buy_pay_units, buy_receive_units, sell_pay_units, sell_receive_units,
  return_pay_units, return_receive_units, buy_gold, sell_gold, return_gold,
  buy_volume_from, buy_volume_to, sell_volume_from, sell_volume_to,
  return_volume_from, return_volume_to, input_divine_value, output_divine_value,
  sample_count, first_seen_source_hour, first_detected_value, best_source_hour,
  best_value, latest_source_hour, current_value, last_profitable_source_hour,
  ((current_value - first_detected_value) / nullif(abs(first_detected_value), 0)) * 100 as change_since_detection_pct,
  extract(epoch from (latest_source_hour - first_seen_source_hour)) / 3600 as opportunity_duration_hours,
  case when sample_count < 2 then 'INSUFFICIENT HISTORY'
    when current_value <= 0 or now() - latest_source_hour > interval '26 hours' then 'EXPIRED'
    when sample_count = 2 then 'NEW'
    when current_value > lag(div_per_100k_gold) over (partition by family_id, league order by source_hour) then 'IMPROVING'
    when current_value < lag(div_per_100k_gold) over (partition by family_id, league order by source_hour) then 'DEGRADING'
    else 'STABLE' end as status,
  now() - source_hour as source_age
from ranked;
grant select on public.signal_history_public to anon, authenticated;

-- One transaction boundary for opportunities, status, compact rates, compact
-- history and both safe projections. p_rates is always the complete six-row
-- direction set (including unavailable directions).
drop function if exists public.complete_poe2_ingestion(uuid,text,timestamptz,text,jsonb);
drop function if exists public.complete_poe2_ingestion(uuid,text,timestamptz,text,jsonb,jsonb);
create or replace function public.complete_poe2_ingestion(
  p_run_id uuid, p_league text, p_source_hour timestamptz,
  p_payload_sha256 text, p_opportunities jsonb, p_rates jsonb
)
returns integer language plpgsql security definer set search_path = public, private as $$
declare v_count integer := 0; v_version text; v_row jsonb; v_cycle jsonb; v_legs jsonb;
begin
  delete from public.opportunities where run_id = p_run_id;
  insert into public.opportunities(run_id, strategy, route, playbook, start_currency, end_currency,
    start_units, end_units, gross_profit_base, conservative_profit_base, expected_profit_base,
    gold_cost, leg_count, bottleneck_volume_share, ratio_range_pct, movement_haircut_pct,
    fill_confidence, score, source_hour)
  select p_run_id, row->>'strategy', row->'route', row->'playbook', row->>'startCurrency', row->>'endCurrency',
    (row->>'startUnits')::numeric, (row->>'endUnits')::numeric, (row->>'grossProfitBase')::numeric,
    (row->>'conservativeProfitBase')::numeric, (row->>'expectedProfitBase')::numeric, (row->>'goldCost')::numeric,
    (row->>'legCount')::smallint, (row->>'bottleneckVolumeShare')::numeric, (row->>'ratioRangePct')::numeric,
    (row->>'movementHaircutPct')::numeric, (row->>'fillConfidence')::numeric, (row->>'score')::numeric, p_source_hour
  from jsonb_array_elements(coalesce(p_opportunities, '[]'::jsonb)) row;
  get diagnostics v_count = row_count;

  insert into private.currency_rate_hourly(source_hour, league, direction, from_currency, to_currency, market_id,
    rate, rate_low, rate_high, pay_units, receive_units, gold_cost, from_volume, to_volume,
    volume_share, fill_risk_pct, executable, reason, payload_sha256)
  select p_source_hour, p_league, x.direction, x.from_currency, x.to_currency, x.market_id,
    x.rate, x.rate_low, x.rate_high, x.pay_units, x.receive_units, x.gold_cost, x.from_volume, x.to_volume,
    x.volume_share, x.fill_risk_pct, x.executable, x.reason, p_payload_sha256
  from jsonb_to_recordset(coalesce(p_rates, '[]'::jsonb)) as x(direction text, from_currency text, to_currency text,
    market_id text, rate numeric, rate_low numeric, rate_high numeric, pay_units integer, receive_units integer,
    gold_cost bigint, from_volume numeric, to_volume numeric, volume_share numeric, fill_risk_pct numeric,
    executable boolean, reason text)
  on conflict (league, source_hour, direction) do nothing;

  insert into public.currency_rates_projection(source_hour, league, direction, from_currency, to_currency, market_id,
    rate, rate_low, rate_high, pay_units, receive_units, gold_cost, from_volume, to_volume,
    volume_share, fill_risk_pct, executable, reason)
  select p_source_hour, p_league, x.direction, x.from_currency, x.to_currency, x.market_id,
    x.rate, x.rate_low, x.rate_high, x.pay_units, x.receive_units, x.gold_cost, x.from_volume, x.to_volume,
    x.volume_share, x.fill_risk_pct, x.executable, x.reason
  from jsonb_to_recordset(coalesce(p_rates, '[]'::jsonb)) as x(direction text, from_currency text, to_currency text,
    market_id text, rate numeric, rate_low numeric, rate_high numeric, pay_units integer, receive_units integer,
    gold_cost bigint, from_volume numeric, to_volume numeric, volume_share numeric, fill_risk_pct numeric,
    executable boolean, reason text)
  on conflict (league, source_hour, direction) do nothing;

  for v_row in select value from jsonb_array_elements(coalesce(p_opportunities, '[]'::jsonb)) loop
    v_cycle := v_row->'cycle'; v_legs := v_row->'route'->'legs';
    if v_row->>'strategy' = 'closed-triangle' and coalesce((v_cycle->>'closed')::boolean, false)
       and coalesce((v_cycle->>'executable')::boolean, false) and jsonb_array_length(v_legs) = 3 then
      insert into private.flip_hourly_observations(family_id, league, source_hour, div_per_100k_gold,
        conservative_profit_divine, gold_required, lowest_leg_volume, volume_share, buy_rate, sell_rate, return_rate,
        buy_pay_units, buy_receive_units, sell_pay_units, sell_receive_units, return_pay_units, return_receive_units,
        buy_gold, sell_gold, return_gold, buy_volume_from, buy_volume_to, sell_volume_from, sell_volume_to,
        return_volume_from, return_volume_to, input_divine_value, output_divine_value, payload_sha256)
      values (coalesce(v_cycle->>'familyId', v_row->'route'->>'routeFamilyId'), p_league, p_source_hour,
        (v_cycle->>'realizedProfitPer100kGold')::numeric, (v_cycle->>'conservativeRealizedProfitDivine')::numeric,
        (v_cycle->>'totalGold')::bigint, (v_cycle->>'bottleneckVolume')::numeric, (v_cycle->>'maxVolumeShare')::numeric,
        coalesce((v_legs->0->>'rate')::numeric, (v_legs->0->>'toUnits')::numeric / nullif((v_legs->0->>'fromUnits')::numeric, 0)),
        coalesce((v_legs->1->>'rate')::numeric, (v_legs->1->>'toUnits')::numeric / nullif((v_legs->1->>'fromUnits')::numeric, 0)),
        coalesce((v_legs->2->>'rate')::numeric, (v_legs->2->>'toUnits')::numeric / nullif((v_legs->2->>'fromUnits')::numeric, 0)),
        (v_cycle->'buyLeg'->>'pay')::integer, (v_cycle->'buyLeg'->>'receive')::integer,
        (v_cycle->'sellLeg'->>'pay')::integer, (v_cycle->'sellLeg'->>'receive')::integer,
        (v_cycle->'returnLeg'->>'pay')::integer, (v_cycle->'returnLeg'->>'receive')::integer,
        (v_cycle->'buyLeg'->>'goldCost')::bigint, (v_cycle->'sellLeg'->>'goldCost')::bigint, (v_cycle->'returnLeg'->>'goldCost')::bigint,
        (v_legs->0->>'volumeFrom')::numeric, (v_legs->0->>'volumeTo')::numeric,
        (v_legs->1->>'volumeFrom')::numeric, (v_legs->1->>'volumeTo')::numeric,
        (v_legs->2->>'volumeFrom')::numeric, (v_legs->2->>'volumeTo')::numeric,
        (v_cycle->>'realizedProfitDivineEquivalent')::numeric, (v_cycle->>'finalStartingQuantity')::numeric, p_payload_sha256)
      on conflict (family_id, league, source_hour) do nothing;
    end if;
  end loop;
  insert into public.signal_history_projection(
    family_id, league, source_hour, div_per_100k_gold, conservative_profit_divine,
    gold_required, lowest_leg_volume, volume_share, buy_rate, sell_rate, return_rate,
    input_divine_value, output_divine_value, buy_pay_units, buy_receive_units,
    sell_pay_units, sell_receive_units, return_pay_units, return_receive_units,
    buy_gold, sell_gold, return_gold, buy_volume_from, buy_volume_to,
    sell_volume_from, sell_volume_to, return_volume_from, return_volume_to
  )
  select h.family_id, h.league, h.source_hour, h.div_per_100k_gold, h.conservative_profit_divine,
    h.gold_required, h.lowest_leg_volume, h.volume_share, h.buy_rate, h.sell_rate, h.return_rate,
    h.input_divine_value, h.output_divine_value, h.buy_pay_units, h.buy_receive_units,
    h.sell_pay_units, h.sell_receive_units, h.return_pay_units, h.return_receive_units,
    h.buy_gold, h.sell_gold, h.return_gold, h.buy_volume_from, h.buy_volume_to,
    h.sell_volume_from, h.sell_volume_to, h.return_volume_from, h.return_volume_to
  from private.flip_hourly_observations h
  where h.league = p_league and h.source_hour = p_source_hour
  on conflict (family_id, league, source_hour) do nothing;

  update public.opportunity_runs set status='succeeded', finished_at=now(), error=null where run_id=p_run_id;
  insert into public.ingestion_state(singleton, last_successful_source_hour, last_payload_sha256, last_run_id, last_heartbeat, last_error, updated_at)
  values (true,p_source_hour,p_payload_sha256,p_run_id,now(),null,now())
  on conflict (singleton) do update set last_successful_source_hour=excluded.last_successful_source_hour,
    last_payload_sha256=excluded.last_payload_sha256,last_run_id=excluded.last_run_id,last_heartbeat=now(),last_error=null,updated_at=now();
  select algorithm_version into v_version from public.opportunity_runs where run_id=p_run_id;
  delete from public.opportunity_public_rows where league=p_league;
  insert into public.opportunity_public_rows(id,strategy,route,playbook,start_currency,end_currency,start_units,end_units,
    gross_profit_base,conservative_profit_base,expected_profit_base,gold_cost,leg_count,bottleneck_volume_share,
    ratio_range_pct,movement_haircut_pct,fill_confidence,score,source_hour,league,algorithm_version,run_status,
    valuation_bottleneck_volume_share,valuation_range_uncertainty_pct,valuation_confidence,valuation_executable,
    valuation_gold_included,valuation_trade_count_included,profit_class,realized_currency)
  select o.id,o.strategy,o.route,o.playbook,o.start_currency,o.end_currency,o.start_units,o.end_units,o.gross_profit_base,
    o.conservative_profit_base,o.expected_profit_base,o.gold_cost,o.leg_count,o.bottleneck_volume_share,o.ratio_range_pct,
    o.movement_haircut_pct,o.fill_confidence,o.score,o.source_hour,p_league,v_version,'succeeded',
    (o.route #>> '{valuation,valuationBottleneckVolumeShare}')::numeric,(o.route #>> '{valuation,valuationRangeUncertaintyPct}')::numeric,
    (o.route #>> '{valuation,valuationConfidence}')::numeric,(o.route #>> '{valuation,valuationExecutable}')::boolean,
    (o.route #>> '{valuation,valuationGoldIncluded}')::boolean,(o.route #>> '{valuation,valuationTradeCountIncluded}')::integer,
    o.route->>'profitClass',o.route->>'realizedCurrency' from public.opportunities o where o.run_id=p_run_id;
  insert into public.opportunity_run_status(league,latest_successful_source_hour,completed_at,candidate_count,algorithm_version,run_status)
  values(p_league,p_source_hour,now(),v_count,v_version,'succeeded') on conflict (league) do update set
    latest_successful_source_hour=excluded.latest_successful_source_hour,completed_at=excluded.completed_at,
    candidate_count=excluded.candidate_count,algorithm_version=excluded.algorithm_version,run_status='succeeded';
  return v_count;
end;
$$;
revoke all on function public.complete_poe2_ingestion(uuid,text,timestamptz,text,jsonb,jsonb) from public, anon, authenticated;
grant execute on function public.complete_poe2_ingestion(uuid,text,timestamptz,text,jsonb,jsonb) to service_role;

-- Keep old callers safe, but they cannot create rate/history observations.
create or replace function public.complete_poe2_ingestion(
  p_run_id uuid, p_league text, p_source_hour timestamptz,
  p_payload_sha256 text, p_opportunities jsonb
) returns integer language sql security definer set search_path=public,private as $$
  select public.complete_poe2_ingestion($1,$2,$3,$4,$5,'[]'::jsonb);
$$;
revoke all on function public.complete_poe2_ingestion(uuid,text,timestamptz,text,jsonb) from public, anon, authenticated;
grant execute on function public.complete_poe2_ingestion(uuid,text,timestamptz,text,jsonb) to service_role;

-- Rates are part of completion now; there is deliberately no separate
-- best-effort rate writer that could commit after a succeeded run.
drop function if exists public.record_currency_rates(text,timestamptz,text,jsonb);
