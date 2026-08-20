-- 016: retain hourly history for Market Scanner discovery rows.
--
-- 015 recorded flip_hourly_observations only for closed-triangle rows that were
-- both closed and executable. The broad Market Scanner publishes two-leg-cross
-- rows carrying route.discovery, so none of its families accumulated history and
-- every scanner drawer showed INSUFFICIENT HISTORY regardless of how many hours
-- had been ingested. This replaces complete_poe2_ingestion with the same
-- function plus a discovery branch; the closed-cycle branch is unchanged and
-- both still commit inside the single completion transaction.
--
-- Append-only semantics are preserved: on conflict do nothing, so an hour
-- already recorded is never recomputed from current prices.

create or replace function public.complete_poe2_ingestion(
  p_run_id uuid, p_league text, p_source_hour timestamptz,
  p_payload_sha256 text, p_opportunities jsonb, p_rates jsonb
)
returns integer language plpgsql security definer set search_path = public, private as $$
declare v_count integer := 0; v_version text; v_row jsonb; v_cycle jsonb; v_legs jsonb; v_disc jsonb;
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
    v_cycle := v_row->'cycle'; v_legs := v_row->'route'->'legs'; v_disc := v_row->'route'->'discovery';
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

    -- Market Scanner discovery rows get the same hourly retention as verified
    -- cycles. Without this the scanner's own families have no history at all
    -- and every drawer reads INSUFFICIENT HISTORY forever.
    --
    -- What is retained is the ratio that CAUSED the row: buy/sell/return are
    -- the conservative completed-hour boundaries the player was told to type
    -- (rate = want / have). div_per_100k_gold is the midpoint discovery metric
    -- the list is ranked on, so the series is comparable hour over hour. Rows
    -- whose sizing never closed carry no observation - there is no quantity to
    -- record - rather than a fabricated zero.
    if v_disc is not null
       and v_disc->'returnLeg' is not null and v_disc->'returnLeg' <> 'null'::jsonb
       and v_disc->>'finalStartingQuantity' is not null
       and v_disc->>'spreadDivPer100kGold' is not null then
      insert into private.flip_hourly_observations(family_id, league, source_hour, div_per_100k_gold,
        conservative_profit_divine, gold_required, lowest_leg_volume, volume_share, buy_rate, sell_rate, return_rate,
        buy_pay_units, buy_receive_units, sell_pay_units, sell_receive_units, return_pay_units, return_receive_units,
        buy_gold, sell_gold, return_gold, buy_volume_from, buy_volume_to, sell_volume_from, sell_volume_to,
        return_volume_from, return_volume_to, input_divine_value, output_divine_value, payload_sha256)
      values (v_disc->>'familyId', p_league, p_source_hour,
        (v_disc->>'spreadDivPer100kGold')::numeric,
        coalesce((v_disc->>'estimatedProfitDivine')::numeric, 0),
        coalesce((v_disc->>'estimatedTotalGold')::numeric, 0)::bigint,
        coalesce((v_disc->>'itemHourlyVolume')::numeric, 0),
        coalesce((v_disc->>'maxVolumeShare')::numeric, 0),
        (v_disc->'buyRatio'->>'want')::numeric / nullif((v_disc->'buyRatio'->>'have')::numeric, 0),
        (v_disc->'sellRatio'->>'want')::numeric / nullif((v_disc->'sellRatio'->>'have')::numeric, 0),
        (v_disc->'returnRatio'->>'want')::numeric / nullif((v_disc->'returnRatio'->>'have')::numeric, 0),
        (v_disc->'buyLeg'->>'pay')::integer, (v_disc->'buyLeg'->>'receive')::integer,
        (v_disc->'sellLeg'->>'pay')::integer, (v_disc->'sellLeg'->>'receive')::integer,
        (v_disc->'returnLeg'->>'pay')::integer, (v_disc->'returnLeg'->>'receive')::integer,
        coalesce((v_disc->'buyLeg'->>'goldCost')::numeric, 0)::bigint,
        coalesce((v_disc->'sellLeg'->>'goldCost')::numeric, 0)::bigint,
        coalesce((v_disc->'returnLeg'->>'goldCost')::numeric, 0)::bigint,
        (v_legs->0->>'volumeFrom')::numeric, (v_legs->0->>'volumeTo')::numeric,
        (v_legs->1->>'volumeFrom')::numeric, (v_legs->1->>'volumeTo')::numeric,
        (v_disc->'returnLeg'->>'hourlyVolume')::numeric, (v_disc->'returnLeg'->>'hourlyVolume')::numeric,
        coalesce((v_disc->>'startingQuantity')::numeric, 0),
        coalesce((v_disc->>'finalStartingQuantity')::numeric, 0), p_payload_sha256)
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
