# Phase 2 Supabase ingestion

This stage adds the database boundary for hourly signals. It does **not** add authentication, live quotes, frame uploads, or game actions.

## Migrations

Apply, in order, with the Supabase CLI or SQL editor:

1. `001_phase2_schema.sql` — normalized market snapshots, runs, opportunities, rollups, ingestion state, RLS and indexes.
2. `002_public_view_retention.sql` — fixed-column `opportunity_public` view and 14-day/90-day retention function.
3. `003_ingestion_rpcs.sql` — service-role-only atomic begin/complete RPCs.
4. `004_failure_and_cron_notes.sql` — failure marker RPC and scheduling notes.

The six base tables have RLS enabled and browser roles have no table grants. Only `opportunity_public` is granted to `anon` and `authenticated`. The service-role key must remain server-side.

## Worker

`src/ingestion/worker.ts` is a Node-runtime worker helper. It:

- computes the prior completed UTC hour (never the open hour);
- fetches the documented GGG completed-hour endpoint with a timeout and User-Agent;
- validates the payload through the Zod parser;
- filters the selected league;
- calls `begin_poe2_ingestion` idempotently;
- computes opportunities through an injected builder;
- calls `complete_poe2_ingestion`, which inserts rows and advances `ingestion_state` atomically;
- marks the run failed if calculation or completion errors occur.

`src/ingestion/pipeline.ts` is the framework-free/testable variant with a repository transaction interface.

## Scheduling

Do not put a service-role key in SQL or client code. Configure the hourly worker using Supabase Cron + an Edge Function/secure server endpoint and secrets stored in Supabase/Vercel. The retention function can be scheduled daily:

```sql
select cron.schedule(
  'poe2-retention-daily',
  '17 3 * * *',
  $$select public.retain_poe2_market_data()$$
);
```

The commented setup note is intentionally not auto-executed by the migration: enabling `pg_cron` and wiring an HTTP Edge Function requires the target Supabase project and secret configuration.

## Verification performed locally

```text
npm run typecheck   PASS
npm test            PASS (18 tests)
```

Tests cover league filtering, idempotent replay, failure state preservation, completed-hour calculation, SQL RLS/public-view contract, retention windows, and the atomic/idempotent RPC contract.
