-- Failure marker for calculation/upstream failures after begin RPC.
create or replace function public.fail_poe2_ingestion(p_run_id uuid, p_error text)
returns void
language sql
security definer
set search_path = public
as $$
  update public.opportunity_runs
  set status = 'failed', finished_at = now(), error = left(p_error, 2000)
  where run_id = p_run_id;
$$;
revoke all on function public.fail_poe2_ingestion(uuid,text) from public, anon, authenticated;
grant execute on function public.fail_poe2_ingestion(uuid,text) to service_role;

-- Supabase Cron setup (run once after the Edge/worker endpoint is deployed):
-- select cron.schedule('poe2-retention-daily', '17 3 * * *', $$select public.retain_poe2_market_data()$$);
-- Schedule the ingestion worker hourly from Supabase Cron/Edge Function using
-- the project's secret store; never put a service-role key in this migration.
