import { describe, expect, it } from "vitest";
import { ingestCompletedHour } from "../src/ingestion/pipeline";
import type { IngestionRepository, IngestionSettings, IngestionTransaction, PersistedMarketHour, PersistedOpportunity } from "../src/ingestion/pipeline";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { hourUnixSeconds, latestCompletedHour } from "../src/ingestion/worker";

const settings: IngestionSettings = {
  league: "Runes of Aldur",
  sourceHourUtc: "2026-08-18T03:00:00.000Z",
  algorithmVersion: "phase2-test-v1",
  routeSettings: { maxLegs: 2 },
};

const raw = {
  next_change_id: 1787025600,
  markets: [{
    league: "Runes of Aldur",
    market_id: "A|B",
    market_pair: ["A", "B"],
    volume_traded: { A: 10, B: 20 },
    lowest_stock: { A: 1, B: 2 },
    highest_stock: { A: 3, B: 4 },
    lowest_ratio: { A: 2, B: 1 },
    highest_ratio: { A: 2, B: 1 },
  }, {
    league: "Standard",
    market_id: "C|D",
    market_pair: ["C", "D"],
    volume_traded: { C: 10, D: 20 },
    lowest_stock: { C: 1, D: 2 },
    highest_stock: { C: 3, D: 4 },
    lowest_ratio: { C: 2, D: 1 },
    highest_ratio: { C: 2, D: 1 },
  }],
};

class FakeTx implements IngestionTransaction {
  successful = false;
  markets: PersistedMarketHour[] = [];
  opportunities: PersistedOpportunity[] = [];
  runStatus = "none";
  runId = "run-1";
  stateUpdated = false;
  hasSuccessfulRun(): Promise<boolean> { return Promise.resolve(this.successful); }
  insertMarketHours(rows: PersistedMarketHour[]): Promise<void> { this.markets.push(...rows); return Promise.resolve(); }
  startRun(): Promise<string> { this.runStatus = "running"; return Promise.resolve(this.runId); }
  insertOpportunities(_runId: string, rows: PersistedOpportunity[]): Promise<void> { this.opportunities.push(...rows); return Promise.resolve(); }
  finishRun(_runId: string, status: "succeeded" | "failed"): Promise<void> { this.runStatus = status; return Promise.resolve(); }
  updateIngestionState(): Promise<void> { this.stateUpdated = true; this.successful = true; return Promise.resolve(); }
}

class FakeRepo implements IngestionRepository {
  tx = new FakeTx();
  async transaction<T>(fn: (tx: IngestionTransaction) => Promise<T>): Promise<T> { return fn(this.tx); }
}

const opportunity = (markets: PersistedMarketHour[]): PersistedOpportunity[] => [{
  strategy: "two-leg-cross",
  route: { markets: markets.map((m) => m.marketId) },
  playbook: [],
  startCurrency: "A",
  endCurrency: "B",
  startUnits: 10,
  endUnits: 5,
  grossProfitBase: 1,
  conservativeProfitBase: 0.5,
  expectedProfitBase: 0.4,
  goldCost: 100,
  legCount: 2,
  bottleneckVolumeShare: 0.1,
  ratioRangePct: 0,
  movementHaircutPct: 1,
  fillConfidence: 0.8,
  score: 4,
  sourceHour: settings.sourceHourUtc,
}];

describe("Phase 2 ingestion pipeline", () => {
  it("always targets the prior completed UTC hour", () => {
    const hour = latestCompletedHour(new Date("2026-08-18T03:42:11.000Z"));
    expect(hour.toISOString()).toBe("2026-08-18T02:00:00.000Z");
    expect(hourUnixSeconds(hour)).toBe(1787018400);
  });

  it("filters league, persists one run, and advances state only after completion", async () => {
    const repo = new FakeRepo();
    const result = await ingestCompletedHour(raw, settings, repo, async (markets) => opportunity(markets));
    expect(result.status).toBe("succeeded");
    expect(result.marketRows).toBe(1);
    expect(result.opportunityRows).toBe(1);
    expect(repo.tx.runStatus).toBe("succeeded");
    expect(repo.tx.stateUpdated).toBe(true);
    expect(repo.tx.markets[0]?.league).toBe("Runes of Aldur");
  });

  it("is idempotent on replay of the same successful payload", async () => {
    const repo = new FakeRepo();
    await ingestCompletedHour(raw, settings, repo, async (markets) => opportunity(markets));
    const replay = await ingestCompletedHour(raw, settings, repo, async () => {
      throw new Error("builder must not run during idempotent replay");
    });
    expect(replay.status).toBe("skipped");
    expect(repo.tx.markets).toHaveLength(1);
  });

  it("does not advance state when opportunity calculation fails", async () => {
    const repo = new FakeRepo();
    await expect(ingestCompletedHour(raw, settings, repo, async () => {
      throw new Error("calculation failed");
    })).rejects.toThrow("calculation failed");
    expect(repo.tx.stateUpdated).toBe(false);
    expect(repo.tx.runStatus).toBe("failed");
  });
});

describe("Phase 2 SQL safety contract", () => {
  it("keeps base tables private and exposes only the explicit view", () => {
    const schema = readFileSync(join(process.cwd(), "supabase/migrations/001_phase2_schema.sql"), "utf8");
    const view = readFileSync(join(process.cwd(), "supabase/migrations/002_public_view_retention.sql"), "utf8");
    expect(schema).toContain("alter table public.market_hours enable row level security");
    expect(schema).toContain("revoke all on public.market_items");
    expect(view).toContain("create or replace view public.opportunity_public");
    expect(view).toContain("grant select on public.opportunity_public to anon, authenticated");
    expect(view).toContain("delete from public.market_hours where completed_hour < now() - interval '14 days'");
    expect(view).toContain("delete from public.daily_market_rollups where rollup_day < current_date - 90");
  });

  it("has idempotency, atomic completion, and failure handling RPCs", () => {
    const sql = readFileSync(join(process.cwd(), "supabase/migrations/003_ingestion_rpcs.sql"), "utf8");
    expect(sql).toContain("create or replace function public.begin_poe2_ingestion");
    expect(sql).toContain("on conflict (source, realm, league, completed_hour, market_id)");
    expect(sql).toContain("status = 'succeeded'");
    expect(sql).toContain("create or replace function public.complete_poe2_ingestion");
    expect(sql).toContain("insert into public.ingestion_state");
    expect(sql).toContain("exception when others then");
    const failure = readFileSync(join(process.cwd(), "supabase/migrations/004_failure_and_cron_notes.sql"), "utf8");
    expect(failure).toContain("create or replace function public.fail_poe2_ingestion");
    expect(failure).toContain("cron.schedule");
  });
});
