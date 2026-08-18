-- Make the private-table deny posture explicit for browser roles.
-- service_role is intentionally not listed and continues to bypass RLS.
do $$
declare
  table_name text;
begin
  foreach table_name in array array[
    'market_items', 'market_hours', 'opportunity_runs',
    'opportunities', 'daily_market_rollups', 'ingestion_state'
  ] loop
    execute format(
      'create policy %I on public.%I for all to anon, authenticated using (false) with check (false)',
      'poe2_deny_browser_' || table_name,
      table_name
    );
  end loop;
end
$$;

create index if not exists ingestion_state_last_run_idx
  on public.ingestion_state(last_run_id);
