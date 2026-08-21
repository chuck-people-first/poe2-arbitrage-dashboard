-- Phase B/C compact hourly currency rates and signal-family history.
-- Raw market payload-derived tables remain on the existing 14-day policy;
-- these compact rows are append-only and retained for at least 90 days.

create schema if not exists private;

create table if not exists private.currency_rate_hourly (
  source_hour timestamptz not null,
  league text not null,
  direction text not null check (direction in (
    'exalted-to-chaos','chaos-to-exalted','exalted-to-divine',
    'divine-to-exalted','chaos-to-divine','divine-to-chaos'
  )),
  from_currency text not null,
  to_currency text not null,
  market_id text,
  rate numeric,
  rate_low numeric,
  rate_high numeric,
  pay_units integer not null default 0,
  receive_units integer not null default 0,
  gold_cost bigint not null default 0,
  from_volume numeric not null default 0,
  to_volume numeric not null default 0,
  volume_share numeric,
  fill_risk_pct numeric,
  executable boolean not null default false,
  reason text,
  payload_sha256 text not null,
  created_at timestamptz not null default now(),
  primary key (league, source_hour, direction)
);

create table if not exists private.flip_hourly_observations (
  family_id text not null,
  league text not null,
  source_hour timestamptz not null,
  div_per_100k_gold numeric not null,
  conservative_profit_divine numeric not null,
  gold_required bigint not null,
  lowest_leg_volume numeric not null,
  volume_share numeric not null,
  buy_rate numeric not null,
  sell_rate numeric not null,
  return_rate numeric not null,
  input_divine_value numeric not null,
  output_divine_value numeric not null,
  payload_sha256 text not null,
  created_at timestamptz not null default now(),
  primary key (family_id, league, source_hour)
);

comment on table private.flip_hourly_observations is
  'Append-only compact family observations. Never recompute historical rows from current prices.';
comment on table private.currency_rate_hourly is
  'Append-only direct six-direction hourly quotes with exact integer execution details.';

alter table private.currency_rate_hourly enable row level security;
alter table private.flip_hourly_observations enable row level security;
revoke all on private.currency_rate_hourly, private.flip_hourly_observations from anon, authenticated;
revoke all on private.currency_rate_hourly, private.flip_hourly_observations from public;
grant select, insert on private.currency_rate_hourly to service_role;
grant select, insert on private.flip_hourly_observations to service_role;

-- Security-invoker views cannot bypass underlying table permissions. These
-- minimal projection tables are the only browser-readable history surface.
create table if not exists public.currency_rates_projection (like private.currency_rate_hourly including defaults including constraints including indexes);
create table if not exists public.signal_history_projection (like private.flip_hourly_observations including defaults including constraints including indexes);
alter table public.currency_rates_projection enable row level security;
alter table public.signal_history_projection enable row level security;
revoke all on public.currency_rates_projection, public.signal_history_projection from public;
revoke all on public.currency_rates_projection, public.signal_history_projection from anon, authenticated;
grant select on public.currency_rates_projection, public.signal_history_projection to anon, authenticated;
grant select, insert on public.currency_rates_projection, public.signal_history_projection to service_role;
drop policy if exists currency_rates_projection_read on public.currency_rates_projection;
drop policy if exists signal_history_projection_read on public.signal_history_projection;
create policy currency_rates_projection_read on public.currency_rates_projection for select to anon, authenticated using (true);
create policy signal_history_projection_read on public.signal_history_projection for select to anon, authenticated using (true);

create or replace view public.currency_rates_public
with (security_barrier = true, security_invoker = true)
as
select
  league, source_hour, direction, from_currency, to_currency, market_id,
  rate, rate_low, rate_high, pay_units, receive_units, gold_cost,
  from_volume, to_volume, volume_share, fill_risk_pct, executable, reason,
  now() - source_hour as source_age
from public.currency_rates_projection;

grant select on public.currency_rates_public to anon, authenticated;

create or replace view public.signal_history_public
with (security_barrier = true, security_invoker = true)
as
with ranked as (
  select
    h.*,
    count(*) over (partition by h.family_id, h.league) as sample_count,
    first_value(h.source_hour) over (partition by h.family_id, h.league order by h.source_hour) as first_seen_source_hour,
    first_value(h.div_per_100k_gold) over (partition by h.family_id, h.league order by h.source_hour) as first_detected_value,
    first_value(h.div_per_100k_gold) over (partition by h.family_id, h.league order by h.div_per_100k_gold desc, h.source_hour) as best_value,
    last_value(h.source_hour) over (partition by h.family_id, h.league order by h.source_hour rows between unbounded preceding and unbounded following) as latest_source_hour,
    last_value(h.div_per_100k_gold) over (partition by h.family_id, h.league order by h.source_hour rows between unbounded preceding and unbounded following) as current_value,
    max(h.source_hour) filter (where h.div_per_100k_gold > 0) over (partition by h.family_id, h.league) as last_profitable_source_hour
  from public.signal_history_projection h
)
select
  family_id, league, source_hour, div_per_100k_gold, conservative_profit_divine,
  gold_required, lowest_leg_volume, volume_share, buy_rate, sell_rate, return_rate,
  input_divine_value, output_divine_value, sample_count,
  first_seen_source_hour, first_detected_value, best_value, latest_source_hour,
  current_value, last_profitable_source_hour,
  ((current_value - first_detected_value) / nullif(abs(first_detected_value), 0)) * 100 as change_since_detection_pct,
  extract(epoch from (latest_source_hour - first_seen_source_hour)) / 3600 as opportunity_duration_hours,
  case
    when sample_count < 2 then 'INSUFFICIENT HISTORY'
    when current_value <= 0 or now() - latest_source_hour > interval '26 hours' then 'EXPIRED'
    when current_value > div_per_100k_gold then 'IMPROVING'
    when current_value < div_per_100k_gold then 'DEGRADING'
    when sample_count = 2 then 'NEW'
    else 'STABLE'
  end as status,
  now() - source_hour as source_age
from ranked;

grant select on public.signal_history_public to anon, authenticated;

drop function if exists public.record_currency_rates(text,timestamptz,text,jsonb);
create or replace function public.record_currency_rates(
  p_league text,
  p_source_hour timestamptz,
  p_payload_sha256 text,
  p_rates jsonb
)
returns jsonb language plpgsql security definer set search_path = public, private as $$
begin
  insert into private.currency_rate_hourly(
    source_hour, league, direction, from_currency, to_currency, market_id,
    rate, rate_low, rate_high, pay_units, receive_units, gold_cost,
    from_volume, to_volume, volume_share, fill_risk_pct, executable, reason, payload_sha256
  )
  select p_source_hour, p_league, x.direction, x.from_currency, x.to_currency, x.market_id,
    x.rate, x.rate_low, x.rate_high, x.pay_units, x.receive_units, x.gold_cost,
    x.from_volume, x.to_volume, x.volume_share, x.fill_risk_pct, x.executable, x.reason, p_payload_sha256
  from jsonb_to_recordset(p_rates) as x(
    direction text, from_currency text, to_currency text, market_id text,
    rate numeric, rate_low numeric, rate_high numeric, pay_units integer,
    receive_units integer, gold_cost bigint, from_volume numeric, to_volume numeric,
    volume_share numeric, fill_risk_pct numeric, executable boolean, reason text
  )
  on conflict (league, source_hour, direction) do nothing;
  insert into public.currency_rates_projection(
    source_hour, league, direction, from_currency, to_currency, market_id,
    rate, rate_low, rate_high, pay_units, receive_units, gold_cost,
    from_volume, to_volume, volume_share, fill_risk_pct, executable, reason, payload_sha256
  )
  select p_source_hour, p_league, x.direction, x.from_currency, x.to_currency, x.market_id,
    x.rate, x.rate_low, x.rate_high, x.pay_units, x.receive_units, x.gold_cost,
    x.from_volume, x.to_volume, x.volume_share, x.fill_risk_pct, x.executable, x.reason, p_payload_sha256
  from jsonb_to_recordset(p_rates) as x(
    direction text, from_currency text, to_currency text, market_id text,
    rate numeric, rate_low numeric, rate_high numeric, pay_units integer,
    receive_units integer, gold_cost bigint, from_volume numeric, to_volume numeric,
    volume_share numeric, fill_risk_pct numeric, executable boolean, reason text
  )
  on conflict (league, source_hour, direction) do nothing;
  return jsonb_build_object('recorded', true);
end;
$$;
revoke all on function public.record_currency_rates(text,timestamptz,text,jsonb) from public, anon, authenticated;
grant execute on function public.record_currency_rates(text,timestamptz,text,jsonb) to service_role;

-- Public users receive projections only. No browser grants exist for raw markets,
-- runs, payload hashes, admin functions, or either compact private table.
revoke all on public.currency_rates_public, public.signal_history_public from public;
revoke all on public.currency_rates_public, public.signal_history_public from anon, authenticated;
grant select on public.currency_rates_public, public.signal_history_public to anon, authenticated;

create or replace function public.retain_poe2_market_data()
returns void
language plpgsql
security definer
set search_path = public, private
as $$
begin
  delete from public.market_hours where completed_hour < now() - interval '14 days';
  delete from public.opportunity_runs where source_hour < now() - interval '14 days';
  delete from public.daily_market_rollups where rollup_day < current_date - 90;
  delete from private.currency_rate_hourly where source_hour < now() - interval '90 days';
  delete from private.flip_hourly_observations where source_hour < now() - interval '90 days';
end;
$$;
revoke all on function public.retain_poe2_market_data() from public, anon, authenticated;
grant execute on function public.retain_poe2_market_data() to service_role;
