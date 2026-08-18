-- Remove the default SECURITY DEFINER behavior from the public read view.
-- Base tables remain private; the view executes under the querying role.
alter view public.opportunity_public set (security_invoker = true);
comment on view public.opportunity_public is
  'Read-only hourly signals using invoker permissions. Never label rows Live verified; source_hour is mandatory.';
