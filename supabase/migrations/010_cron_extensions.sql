-- Enable only the extensions required for the scheduled PoE2 ingestion and retention jobs.
create extension if not exists pg_net;
create extension if not exists pg_cron;
