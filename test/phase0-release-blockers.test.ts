// Review-required regression tests for the Phase 0 release blockers:
//  1. Expected-profit confidence is monotone (not reversed).
//  2. Volume share uses unit-safe shares (fromShare/toShare), never max of
//     two different currencies.
//  3. Live data age advances without a second ingestion.
//  4. Deduplication integrates into the production pipeline after scoring.
//  5. Route identity is deterministic (routeFamilyId / opportunityId) and
//     uses hourUtc, league and sizing.

import { describe, expect, it } from "vitest";
import type { DirectedEdge, Route, RouteLeg, RunSettings, ValuationDisclosure } from "../src/domain/types.ts";
import type { RouteCandidate } from "../src/domain/routes.ts";
import { evaluateCandidate } from "../src/domain/routes.ts";
import { expectedProfit, scoreCandidate, sourceAgeHours, toRoute } from "../src/domain/scoring.ts";
import { deriveEdges } from "../src/domain/edges.ts";
import { routeFamilyId, opportunityId } from "../src/domain/identity.ts";
import { dedupeOpportunityRows } from "../src/domain/dedupe.ts";
import { ingestCompletedHour, type IngestionRepository, type IngestionTransaction, type PersistedOpportunity } from "../src/ingestion/pipeline.ts";

const A = "Metadata/Items/Currency/CurrencyRerollRare"; // chaos
const B = "Metadata/Items/Currency/CurrencyModValues"; // divine (base)
const C = "Metadata/Items/Currency/CurrencyAddModToRare"; // exalted

const edge = (from: string, to: string, rate: number, key: string, volFrom: number, volTo: number): DirectedEdge => ({
  observationId: key, key, reverseEdgeKey: `${key}-rev`, from, to, rate,
  rateLow: rate * 0.91, rateHigh: rate * 1.09, volumeFrom: volFrom, volumeTo: volTo,
  hourUtc: "2026-08-18T22:00:00Z", source: "ggg-hourly", confidence: null,
});

const settings = (overrides: Partial<RunSettings> = {}): RunSettings => ({
  league: "Test", startCurrency: A, baseCurrency: B, capitalUnits: 100,
  goldBudget: 2_000_000, maxLegs: 3, maxVolumeSharePct: 20,
  minConservativeProfitBase: 0.01, maxDataAgeHours: 0, movementRiskTolerancePct: 100,
  ...overrides,
});

const valuation = (): ValuationDisclosure => ({
  profitKind: "mark-to-market", inputValuationPath: [], outputValuationPath: [],
  observationIds: [], valuationRates: [], returnToBaseLegs: [], returnToBaseIncluded: false,
});

const leg = (from: string, to: string, give: number, receive: number, gold: number, edgeKey: string): RouteLeg => ({
  edgeKey, from, to, fromUnits: give, toUnits: receive,
  playbook: { give, pay: from, receive, want: to }, goldCost: gold,
  fromShare: 0.01, toShare: 0.01, volumeShare: 0.01,
});

describe("expected-profit confidence monotonicity", () => {
  it("increasing confidence never reduces expected profit and bounds it", () => {
    const conservative = 50, gross = 100;
    const low = expectedProfit(conservative, gross, 0.1);
    const mid = expectedProfit(conservative, gross, 0.5);
    const high = expectedProfit(conservative, gross, 0.9);
    expect(high).toBeGreaterThan(mid);
    expect(mid).toBeGreaterThan(low);
    // bounded: conservative <= expected <= gross
    for (const v of [low, mid, high]) {
      expect(v).toBeGreaterThanOrEqual(conservative);
      expect(v).toBeLessThanOrEqual(gross);
    }
  });

  it("identical routes differ only in confidence -> higher confidence wins (not reversed)", () => {
    // Two-leg flip A(chaos)->B(divine=base)->C(exalted), end valued via an
    // independent C->B edge so gross profit is non-zero.
    const legsEdges = [edge(A, B, 0.1, "e1", 100000, 10000), edge(B, C, 330, "e2", 10000, 1_000_000)];
    const valuationEdge = edge(C, B, 1 / 300, "val", 100000, 10000);
    const s = settings({ goldBudget: 10_000_000 });
    const c: RouteCandidate = {
      strategy: "two-leg-cross", edges: legsEdges,
      startCurrency: A, endCurrency: C, startUnits: 1000, settings: s,
    };
    const allEdges = [...legsEdges, valuationEdge];
    const ev = evaluateCandidate(c);
    const sc = scoreCandidate(c, ev, allEdges, s, Date.parse("2026-08-18T22:00:00Z"));
    expect(sc.fields).not.toBeNull();
    const cons = sc.fields!.conservativeProfitBase;
    const gross = sc.fields!.grossProfitBase;
    expect(expectedProfit(cons, gross, 0.9)).toBeGreaterThan(expectedProfit(cons, gross, 0.1));
    // The persisted route's expected profit equals the monotone formula using
    // its own fill confidence.
    const route = toRoute(c, sc, ev, "2026-08-18T22:00:00Z", allEdges, Date.parse("2026-08-18T22:00:00Z"))!;
    expect(route.profitKind).toBe("mark-to-market"); // not realized base profit
    expect(route.valuation.returnToBaseIncluded).toBe(false);
    expect(route.expectedProfitBase).toBeCloseTo(
      expectedProfit(route.conservativeProfitBase, route.grossProfitBase, route.fillConfidence), 8,
    );
  });
});

describe("unit-safe volume share", () => {
  it("uses max(fromShare, toShare) per leg, not max of two currencies", () => {
    // Leg: 100 chaos -> 10 divine. chaos volume 1_000_000, divine volume 20.
    const c: RouteCandidate = {
      strategy: "two-leg-cross",
      edges: [edge(A, B, 0.1, "e1", 1_000_000, 20), edge(B, C, 330, "e2", 1000, 100_000)],
      startCurrency: A, endCurrency: C, startUnits: 100, settings: settings(),
    };
    const ev = evaluateCandidate(c);
    const l1 = ev.legs[0]!;
    // fromShare = 100/1_000_000 = 0.0001; toShare = 10/20 = 0.5
    expect(l1.fromShare).toBeCloseTo(0.0001, 10);
    expect(l1.toShare).toBeCloseTo(0.5, 10);
    expect(l1.volumeShare).toBeCloseTo(0.5, 10); // max of the two OWN-unit shares
  });

  it("a leg whose to-denominated share blows past the 20% ceiling is rejected", () => {
    // Old hourlyVolume audit figure (0.005975%) was computed against a max of two
    // currencies; with unit-correct shares the divine-side share is 50% and must
    // be rejected.
    const c: RouteCandidate = {
      strategy: "two-leg-cross",
      edges: [edge(A, B, 0.1, "e1", 1_000_000, 20), edge(B, C, 330, "e2", 1000, 100_000)],
      startCurrency: A, endCurrency: C, startUnits: 100, settings: settings(),
    };
    const ev = evaluateCandidate(c);
    const sc = scoreCandidate(c, ev, [], settings());
    expect(sc.rejection).toMatch(/bottleneck volume share/);
  });
});

describe("live data age", () => {
  it("source age advances as the reference time advances, with no second ingestion", () => {
    const edges = [edge(A, B, 0.1, "e1", 1000, 100)];
    const t0 = Date.parse("2026-08-18T22:00:00Z");
    const ageAtStart = sourceAgeHours(edges, t0);
    expect(ageAtStart).toBe(0);
    const ageLater = sourceAgeHours(edges, t0 + 3 * 3_600_000);
    expect(ageLater).toBeCloseTo(3, 8);
    // A stale candidate is rejected even though no new ingestion happened.
    const c: RouteCandidate = {
      strategy: "two-leg-cross", edges, startCurrency: A, endCurrency: B,
      startUnits: 100, settings: settings({ maxDataAgeHours: 1 }),
    };
    const ev = evaluateCandidate(c);
    const sc = scoreCandidate(c, ev, [], settings({ maxDataAgeHours: 1 }), t0 + 3 * 3_600_000);
    expect(sc.rejection).toMatch(/stale source: age/);
  });
});

describe("dedup integration in the production pipeline", () => {
  class Tx implements IngestionTransaction {
    hasSuccessfulRun = () => Promise.resolve(false);
    insertMarketHours = () => Promise.resolve();
    startRun = () => Promise.resolve("run-1");
    inserted: PersistedOpportunity[] = [];
    insertOpportunities = async (_r: string, rows: PersistedOpportunity[]) => { this.inserted = rows; };
    finishRun = () => Promise.resolve();
    updateIngestionState = () => Promise.resolve();
  }
  class Repo implements IngestionRepository {
    tx = new Tx();
    async transaction<T>(fn: (t: IngestionTransaction) => Promise<T>): Promise<T> { return fn(this.tx); }
  }

  const raw = {
    next_change_id: 1,
    markets: [{ league: "Test", market_id: "A|B", market_pair: [A, B],
      volume_traded: { [A]: 100, [B]: 10 }, lowest_stock: { [A]: 1, [B]: 1 }, highest_stock: { [A]: 1, [B]: 1 },
      lowest_ratio: { [A]: 10, [B]: 1 }, highest_ratio: { [A]: 10, [B]: 1 } }],
  };

  it("dedupes sizing variants after scoring, before persistence", async () => {
    const repo = new Repo();
    const settings = { league: "Test", sourceHourUtc: "2026-08-18T22:00:00.000Z", algorithmVersion: "v", routeSettings: {} };
    const mk = (id: string, score: number): PersistedOpportunity => ({
      strategy: "two-leg-cross", route: { routeFamilyId: "fam-A" }, playbook: [],
      startCurrency: A, endCurrency: B, startUnits: 100, endUnits: 10,
      grossProfitBase: 1, conservativeProfitBase: 0.5, expectedProfitBase: 0.7,
      goldCost: 100, legCount: 2, bottleneckVolumeShare: 0.1, ratioRangePct: 1,
      movementHaircutPct: 1, fillConfidence: 0.8, score, sourceHour: settings.sourceHourUtc,
    });
    const result = await ingestCompletedHour(raw, settings, repo, async () => [mk("a", 1), mk("b", 5), mk("c", 3)]);
    // Three same-family opportunities collapse to one (highest score 5).
    expect(result.opportunityRows).toBe(1);
    expect(repo.tx.inserted).toHaveLength(1);
    expect(repo.tx.inserted[0]!.score).toBe(5);
  });
});

describe("deterministic route identity", () => {
  it("routeFamilyId is stable and independent of sizing; opportunityId differs by hour/league/sizing", () => {
    const edges1 = [edge(A, B, 0.1, "o1", 1000, 100), edge(B, C, 330, "o2", 1000, 100)];
    const fam1 = routeFamilyId("two-leg-cross", edges1);
    expect(fam1).toBe(routeFamilyId("two-leg-cross", edges1));
    expect(fam1).toMatch(/^[0-9a-f]{64}$/);

    const opp1 = opportunityId(fam1, "Runes of Aldur", "2026-08-18T22:00:00Z", 100);
    const opp1b = opportunityId(fam1, "Runes of Aldur", "2026-08-18T22:00:00Z", 100);
    const oppOtherHour = opportunityId(fam1, "Runes of Aldur", "2026-08-18T21:00:00Z", 100);
    const oppOtherLeague = opportunityId(fam1, "Standard", "2026-08-18T22:00:00Z", 100);
    const oppOtherSizing = opportunityId(fam1, "Runes of Aldur", "2026-08-18T22:00:00Z", 500);
    expect(opp1).toBe(opp1b);
    expect(opp1).not.toBe(oppOtherHour);
    expect(opp1).not.toBe(oppOtherLeague);
    expect(opp1).not.toBe(oppOtherSizing);
  });

  it("deriveEdges still produces volumeFrom/volumeTo (no fabricated hourlyVolume)", () => {
    const cohort = [
      { league: "Test", marketId: `${A}|${B}`, pair: [A, B] as [string, string],
        volumeTraded: { [A]: 100, [B]: 10 }, lowestStock: {}, highestStock: {},
        lowestRatio: { [A]: 10, [B]: 1 }, highestRatio: { [A]: 10, [B]: 1 } },
      { league: "Test", marketId: `${B}|${C}`, pair: [B, C] as [string, string],
        volumeTraded: { [B]: 10, [C]: 1000 }, lowestStock: {}, highestStock: {},
        lowestRatio: { [B]: 1, [C]: 300 }, highestRatio: { [B]: 1, [C]: 300 } },
    ];
    // deriveEdges expects GggMarket; build minimal parseable objects.
    const edges = deriveEdges(cohort as never, "2026-08-18T22:00:00Z");
    for (const e of edges) {
      expect(e).not.toHaveProperty("hourlyVolume");
      expect(e.volumeFrom).toBeGreaterThan(0);
      expect(e.volumeTo).toBeGreaterThan(0);
    }
  });
});

describe("dedupeOpportunityRows scoping", () => {
  it("does not collapse different route families", () => {
    const row = (fam: string): { route: { routeFamilyId: string } } => ({ route: { routeFamilyId: fam } });
    const out = dedupeOpportunityRows([row("fam1"), row("fam2")]);
    expect(out).toHaveLength(2);
  });
});
