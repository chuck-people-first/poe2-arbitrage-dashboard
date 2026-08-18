-- The worker executes these functions with service_role, which already bypasses
-- RLS. Avoid unnecessary privilege escalation from SECURITY DEFINER functions.
alter function public.begin_poe2_ingestion(text, timestamptz, text, jsonb, text, jsonb) security invoker;
alter function public.complete_poe2_ingestion(uuid, text, timestamptz, text, jsonb) security invoker;
alter function public.fail_poe2_ingestion(uuid, text) security invoker;
alter function public.retain_poe2_market_data() security invoker;
