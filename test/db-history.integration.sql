-- Compact currency-rate and append-only family-history integration checks.
\set ON_ERROR_STOP on
begin;

insert into private.flip_hourly_observations(
  family_id, league, source_hour, div_per_100k_gold, conservative_profit_divine,
  gold_required, lowest_leg_volume, volume_share, buy_rate, sell_rate, return_rate,
  buy_pay_units, buy_receive_units, sell_pay_units, sell_receive_units,
  return_pay_units, return_receive_units, buy_gold, sell_gold, return_gold,
  buy_volume_from, buy_volume_to, sell_volume_from, sell_volume_to,
  return_volume_from, return_volume_to, input_divine_value, output_divine_value, payload_sha256
) values
  ('history-family', 'Runes of Aldur', '2026-08-19T00:00:00Z', 1, 1, 47000, 1000, .01, .1, 10, .01,
   100, 500, 500, 4900, 4900, 105, 10000, 20000, 30000, 100000, 50000, 49000, 25000, 5000, 110000, 1, 2, 'history-a'),
  ('history-family', 'Runes of Aldur', '2026-08-19T01:00:00Z', 2, 2, 47000, 1000, .01, .11, 11, .011,
   101, 501, 501, 5001, 5001, 106, 10001, 20001, 30001, 100001, 50001, 50001, 25001, 5001, 110001, 1, 3, 'history-b')
on conflict (family_id, league, source_hour) do nothing;
insert into public.signal_history_projection(
  family_id, league, source_hour, div_per_100k_gold, conservative_profit_divine,
  gold_required, lowest_leg_volume, volume_share, buy_rate, sell_rate, return_rate,
  buy_pay_units, buy_receive_units, sell_pay_units, sell_receive_units,
  return_pay_units, return_receive_units, buy_gold, sell_gold, return_gold,
  buy_volume_from, buy_volume_to, sell_volume_from, sell_volume_to,
  return_volume_from, return_volume_to, input_divine_value, output_divine_value
)
select family_id, league, source_hour, div_per_100k_gold, conservative_profit_divine,
  gold_required, lowest_leg_volume, volume_share, buy_rate, sell_rate, return_rate,
  buy_pay_units, buy_receive_units, sell_pay_units, sell_receive_units,
  return_pay_units, return_receive_units, buy_gold, sell_gold, return_gold,
  buy_volume_from, buy_volume_to, sell_volume_from, sell_volume_to,
  return_volume_from, return_volume_to, input_divine_value, output_divine_value
from private.flip_hourly_observations
where family_id = 'history-family'
on conflict (family_id, league, source_hour) do nothing;

-- Append-only: a replay cannot overwrite the first observed value.
insert into private.flip_hourly_observations(
  family_id, league, source_hour, div_per_100k_gold, conservative_profit_divine,
  gold_required, lowest_leg_volume, volume_share, buy_rate, sell_rate, return_rate,
  input_divine_value, output_divine_value, payload_sha256
) values
  ('history-family', 'Runes of Aldur', '2026-08-19T00:00:00Z', 99, 99, 1, 1, 1, 99, 99, 99, 1, 100, 'replay')
on conflict (family_id, league, source_hour) do nothing;

do $$
begin
  if (select count(*) from private.flip_hourly_observations where family_id = 'history-family') <> 2 then
    raise exception 'FAIL: append-only history row count';
  end if;
  if (select first_detected_value from public.signal_history_public where family_id = 'history-family' order by source_hour desc limit 1) <> 1 then
    raise exception 'FAIL: first detected value was overwritten';
  end if;
  if (select current_value from public.signal_history_public where family_id = 'history-family' order by source_hour desc limit 1) <> 2 then
    raise exception 'FAIL: current value projection';
  end if;
  if (select status from public.signal_history_public where family_id = 'history-family' order by source_hour desc limit 1) <> 'NEW' then
    raise exception 'FAIL: new history status';
  end if;
  if (select buy_pay_units from public.signal_history_public where family_id = 'history-family' and source_hour = '2026-08-19T00:00:00Z') <> 100
     or (select buy_gold from public.signal_history_public where family_id = 'history-family' and source_hour = '2026-08-19T00:00:00Z') <> 10000
     or (select return_volume_to from public.signal_history_public where family_id = 'history-family' and source_hour = '2026-08-19T00:00:00Z') <> 110000 then
    raise exception 'FAIL: exact closed-cycle quantities/gold/volumes were not retained';
  end if;
end $$;

insert into private.currency_rate_hourly(
  source_hour, league, direction, from_currency, to_currency, market_id,
  rate, rate_low, rate_high, pay_units, receive_units, gold_cost,
  from_volume, to_volume, volume_share, fill_risk_pct, executable, reason, payload_sha256
) values
  ('2026-08-19T01:00:00Z', 'Runes of Aldur', 'exalted-to-chaos', 'exalted', 'chaos', 'm1',
   33, 32, 34, 100, 3300, 528000, 10000, 10000, .33, 33, true, null, 'rates-a'),
  ('2026-08-19T01:00:00Z', 'Runes of Aldur', 'chaos-to-exalted', 'chaos', 'exalted', 'm1',
   .03, .029, .031, 100, 3, 360, 10000, 10000, .01, 1, true, null, 'rates-a')
on conflict (league, source_hour, direction) do nothing;
insert into public.currency_rates_projection(
  source_hour, league, direction, from_currency, to_currency, market_id,
  rate, rate_low, rate_high, pay_units, receive_units, gold_cost,
  from_volume, to_volume, volume_share, fill_risk_pct, executable, reason
)
select source_hour, league, direction, from_currency, to_currency, market_id,
  rate, rate_low, rate_high, pay_units, receive_units, gold_cost,
  from_volume, to_volume, volume_share, fill_risk_pct, executable, reason
from private.currency_rate_hourly
where league = 'Runes of Aldur' and source_hour = '2026-08-19T01:00:00Z'
on conflict (league, source_hour, direction) do nothing;
do $$ begin
  if (select count(*) from public.currency_rates_public where source_hour = '2026-08-19T01:00:00Z') <> 2 then
    raise exception 'FAIL: currency-rate public projection';
  end if;
end $$;

-- Retention gate: raw observations expire after 14 days; compact history after 90.
insert into public.market_hours(source, realm, league, completed_hour, market_id, pair_a, pair_b,
  volume_traded, lowest_stock, highest_stock, lowest_ratio, highest_ratio, payload_sha256)
values ('ggg-hourly', 'poe2', 'retention-test', now() - interval '15 days', 'retention-market', 'a', 'b',
  '{"a":1}', '{"a":1}', '{"a":1}', '{"a":1}', '{"a":1}', 'retention-hash');
insert into public.opportunity_runs(league, source_hour, source_payload_sha256, settings, algorithm_version, status)
values ('retention-test', now() - interval '15 days', 'retention-run-hash', '{}'::jsonb, 'retention-v1', 'succeeded');
insert into private.currency_rate_hourly(source_hour, league, direction, from_currency, to_currency, rate, payload_sha256)
values (now() - interval '91 days', 'retention-test', 'exalted-to-chaos', 'exalted', 'chaos', 1, 'retention-rate');
insert into private.flip_hourly_observations(family_id, league, source_hour, div_per_100k_gold, conservative_profit_divine,
  gold_required, lowest_leg_volume, volume_share, buy_rate, sell_rate, return_rate, input_divine_value, output_divine_value, payload_sha256)
values ('retention-test', 'retention-test', now() - interval '91 days', 1, 1, 1, 1, .01, 1, 1, 1, 1, 2, 'retention-history');
select public.retain_poe2_market_data();
do $$ begin
  if exists (select 1 from public.market_hours where league = 'retention-test')
     or exists (select 1 from public.opportunity_runs where league = 'retention-test')
     or exists (select 1 from private.currency_rate_hourly where league = 'retention-test')
     or exists (select 1 from private.flip_hourly_observations where league = 'retention-test') then
    raise exception 'FAIL: raw/compact retention windows';
  end if;
end $$;

rollback;

do $$ begin
  raise notice 'COMPACT CURRENCY-RATE + SIGNAL-HISTORY TEST PASSED';
end $$;
