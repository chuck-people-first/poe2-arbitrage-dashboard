-- Phase 2 initial schema.
-- Apply with Supabase migrations. The write tables are private by RLS; only the
-- explicitly granted public view is readable by anon/authenticated clients.

create extension if not exists pgcrypto;

create table if not exists public.market_items (
  ggg_path text primary key,
  ninja_id text,
  display_name text not null,
  category text not null,
  icon_url text,
  gold_cost_per_unit numeric(30,0),
  mapping_source text not null check (mapping_source in ('checked-in-verified','poe-ninja','ggg-only','quarantined')),
  last_verified_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.market_hours (
  id uuid primary key default gen_random_uuid(),
  source text not null check (source = 'ggg-hourly'),
  realm text not null default 'poe2',
  league text not null,
  completed_hour timestamptz not null,
  market_id text not null,
  pair_a text not null,
  pair_b text not null,
  volume_traded jsonb not null,
  lowest_stock jsonb not null,
  highest_stock jsonb not null,
  lowest_ratio jsonb not null,
  highest_ratio jsonb not null,
  fetched_at timestamptz not null default now(),
  payload_sha256 text not null,
  created_at timestamptz not null default now(),
  unique (source, realm, league, completed_hour, market_id),
  check (pair_a <> pair_b),
  check (jsonb_typeof(volume_traded) = 'object'),
  check (jsonb_typeof(lowest_ratio) = 'object'),
  check (jsonb_typeof(highest_ratio) = 'object')
);

create index if not exists market_hours_lookup_idx
  on public.market_hours (league, completed_hour desc);
create index if not exists market_hours_market_idx
  on public.market_hours (market_id, completed_hour desc);

create table if not exists public.opportunity_runs (
  run_id uuid primary key default gen_random_uuid(),
  league text not null,
  source_hour timestamptz not null,
  source_payload_sha256 text not null,
  settings jsonb not null,
  algorithm_version text not null,
  status text not null check (status in ('running','succeeded','failed','skipped')),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  error text,
  unique (league, source_hour, algorithm_version)
);

create table if not exists public.opportunities (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.opportunity_runs(run_id) on delete cascade,
  strategy text not null check (strategy in ('two-leg-cross','closed-triangle')),
  route jsonb not null,
  playbook jsonb not null,
  start_currency text not null,
  end_currency text not null,
  start_units numeric(30,0) not null check (start_units > 0),
  end_units numeric(30,0) not null check (end_units >= 0),
  gross_profit_base numeric(30,12) not null,
  conservative_profit_base numeric(30,12) not null,
  expected_profit_base numeric(30,12) not null,
  gold_cost numeric(30,0) not null check (gold_cost >= 0),
  leg_count smallint not null check (leg_count between 2 and 3),
  bottleneck_volume_share numeric(12,9) not null check (bottleneck_volume_share >= 0),
  ratio_range_pct numeric(12,6) not null check (ratio_range_pct >= 0),
  movement_haircut_pct numeric(12,6) not null check (movement_haircut_pct >= 0),
  fill_confidence numeric(8,6) not null check (fill_confidence between 0 and 1),
  score numeric(30,12) not null,
  source_label text not null default 'Hourly signal' check (source_label = 'Hourly signal'),
  source_hour timestamptz not null,
  created_at timestamptz not null default now()
);

create index if not exists opportunities_run_score_idx
  on public.opportunities (run_id, score desc);

create table if not exists public.daily_market_rollups (
  id uuid primary key default gen_random_uuid(),
  source text not null check (source = 'ggg-hourly'),
  realm text not null default 'poe2',
  league text not null,
  market_id text not null,
  rollup_day date not null,
  volume numeric(30,6) not null default 0,
  ratio_low numeric(30,12),
  ratio_high numeric(30,12),
  ratio_open numeric(30,12),
  ratio_close numeric(30,12),
  volatility numeric(30,12),
  positive_snapshots integer not null default 0,
  updated_at timestamptz not null default now(),
  unique (source, realm, league, market_id, rollup_day)
);

create table if not exists public.ingestion_state (
  singleton boolean primary key default true check (singleton),
  source text not null default 'ggg-hourly' check (source = 'ggg-hourly'),
  last_successful_source_hour timestamptz,
  last_payload_sha256 text,
  last_run_id uuid references public.opportunity_runs(run_id),
  last_heartbeat timestamptz,
  last_error text,
  updated_at timestamptz not null default now()
);
insert into public.ingestion_state(singleton) values (true) on conflict (singleton) do nothing;

-- All base tables are private. No anon/authenticated policies are defined.
alter table public.market_items enable row level security;
alter table public.market_hours enable row level security;
alter table public.opportunity_runs enable row level security;
alter table public.opportunities enable row level security;
alter table public.daily_market_rollups enable row level security;
alter table public.ingestion_state enable row level security;

-- Service role bypasses RLS by Supabase design. Explicitly revoke table reads
-- from browser roles to prevent accidental exposure if a policy is added later.
revoke all on public.market_items, public.market_hours, public.opportunity_runs,
  public.opportunities, public.daily_market_rollups, public.ingestion_state
  from anon, authenticated;
