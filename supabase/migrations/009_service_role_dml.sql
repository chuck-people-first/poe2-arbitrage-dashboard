-- The ingestion worker runs as service_role. Explicitly grant only the DML
-- needed by the server-side RPCs; anon/authenticated remain denied by RLS.
grant select, insert, update, delete on public.market_items to service_role;
grant select, insert, update, delete on public.market_hours to service_role;
grant select, insert, update, delete on public.opportunity_runs to service_role;
grant select, insert, update, delete on public.opportunities to service_role;
grant select, insert, update, delete on public.daily_market_rollups to service_role;
grant select, insert, update, delete on public.ingestion_state to service_role;
