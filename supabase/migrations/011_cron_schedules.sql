-- Idempotent Vault-backed schedules. Secret values are inserted separately
-- through vault.create_secret and never appear in this migration.
do $outer$
declare
  existing_job bigint;
begin
  select jobid into existing_job from cron.job where jobname = 'poe2-hourly-ingest';
  if existing_job is not null then perform cron.unschedule(existing_job); end if;
  perform cron.schedule(
    'poe2-hourly-ingest', '10 * * * *',
    $cmd$select net.http_post(
      url := (select decrypted_secret from vault.decrypted_secrets where name = 'poe2_ingest_url'),
      headers := jsonb_build_object(
        'content-type', 'application/json',
        'x-poe2-ingestion-token', (select decrypted_secret from vault.decrypted_secrets where name = 'poe2_ingest_token')
      ),
      body := '{}'::jsonb
    );$cmd$
  );

  select jobid into existing_job from cron.job where jobname = 'poe2-retention-daily';
  if existing_job is not null then perform cron.unschedule(existing_job); end if;
  perform cron.schedule(
    'poe2-retention-daily', '17 3 * * *',
    $cmd$retain_poe2_market_data$cmd$
  );
end
$outer$;
