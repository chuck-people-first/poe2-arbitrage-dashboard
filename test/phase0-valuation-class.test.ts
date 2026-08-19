// Item 4 (valuation-path risk) and item 5 (profit classification) tests.
// Valuation references are vetted for liquidity before being trusted; routes
// are classified by what they actually close, never hardcoded to
// mark-to-market.

import { describe, expect, it } from "vitest";
import type { DirectedEdge, Route, RunSettings, ValuationDisclosure } from "../src/domain/types.ts";
import { classifyRoute, scoreCandidate, valuationRisk } from "../src/domain/scoring.ts";
import { enumerateTwoLegFlips, evaluateCandidate } from "../src/domain/routes.ts";
import { deriveEdges } from "../src/domain/edges.ts";
import { GGG_HUB_PATHS } from "../src/domain/mapping.ts";

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

describe("item 4: valuation-path risk", () => {
  it("rejects a valuation path whose bottleneck share exceeds the 20% ceiling", () => {
    // Output valued through a 2-hop path whose first hop has only 100 units
    // of depth: 3300 exalted / 100 = 33x -> 3300% share.
    const input = [edge(A, B, 0.1, "e1", 1_000_000, 100_000)];
    const output = [edge(C, "X", 0.0078, "val1", 100, 1), edge("X", B, 2.5, "val2", 1000, 2500)];
    const risk = valuationRisk(input, output, 100, 3300, settings());
    expect(risk.bottleneckShare).toBeGreaterThan(20);
    expect(risk.rejection).toMatch(/valuation path bottleneck volume share/);
  });

  it("rejects a valuation path with missing or zero volume", () => {
    const input = [edge(A, B, 0.1, "e1", 0, 100_000)];
    const output: DirectedEdge[] = [];
    expect(() => valuationRisk(input, output, 100, 0, settings())).toThrow(/missing or zero volume/);
  });

  it("rejects a valuation path with non-positive rates", () => {
    const bad = { ...edge(A, B, 0.1, "e1", 1000, 100), rate: 0 };
    const input = [bad];
    expect(() => valuationRisk(input, [], 100, 0, settings())).toThrow(/non-positive rate/);
  });

  it("accepts a liquid valuation path and reports its metrics", () => {
    const input = [edge(A, B, 0.1, "e1", 1_000_000, 100_000)];
    const output = [edge(C, B, 1 / 300, "val", 10_000_000, 100_000)];
    const risk = valuationRisk(input, output, 100, 3300, settings());
    expect(risk.rejection).toBeNull();
    expect(risk.bottleneckShare).toBeLessThanOrEqual(0.2);
    expect(risk.rangeUncertaintyPct).toBeGreaterThan(0);
  });

  it("end-to-end: an illiquid reference path rejects the candidate instead of inflating it", () => {
    const legsEdges = [edge(A, B, 0.1, "e1", 1_000_000, 100_000), edge(B, C, 330, "e2", 100_000, 1_000_000)];
    const illiquidVal = edge(C, B, 1 / 300, "val", 5_000, 1_000); // 3300/5000 = 66% > 20%
    const allEdges = [...legsEdges, illiquidVal];
    const c = { strategy: "two-leg-cross" as const, edges: legsEdges, startCurrency: A, endCurrency: C, startUnits: 1000, settings: settings({ goldBudget: 10_000_000 }) };
    const sc = scoreCandidate(c, evaluateCandidate(c), allEdges, c.settings, Date.parse("2026-08-18T22:00:00Z"));
    expect(sc.rejection).toMatch(/valuation path bottleneck volume share/);
  });
});

describe("item 5: profit classification", () => {
  const base = { settings: settings() };

  it("two-leg cross ending in another currency is mark-to-market, not realized", () => {
    const cls = classifyRoute({ strategy: "two-leg-cross", edges: [], startCurrency: A, endCurrency: C, startUnits: 100, ...base });
    expect(cls.profitClass).toBe("mark-to-market");
    expect(cls.profitKind).toBe("mark-to-market");
    expect(cls.realizedCurrency).toBeNull();
  });

  it("a route returning to its starting currency is closed-realized in the START currency", () => {
    const cls = classifyRoute({ strategy: "closed-triangle", edges: [], startCurrency: A, endCurrency: A, startUnits: 100, ...base });
    expect(cls.profitClass).toBe("closed-realized");
    expect(cls.realizedCurrency).toBe(A);
  });

  it("a two-leg route ending in display base is still mark-to-market until it returns to start", () => {
    const cls = classifyRoute({ strategy: "two-leg-cross", edges: [], startCurrency: A, endCurrency: B, startUnits: 100, ...base });
    expect(cls.profitClass).toBe("mark-to-market");
    expect(cls.profitKind).toBe("mark-to-market");
    expect(cls.realizedCurrency).toBeNull();
  });

  it("persisted route carries classification + valuation-risk disclosure", () => {
    // Deep synthetic markets so a route scores: A->B->C with a liquid C->B reference.
    const mkts = [
      { league: "Test", marketId: `${A}|${B}`, pair: [A, B] as [string, string], volumeTraded: { [A]: 1_000_000, [B]: 100_000 }, lowestStock: { [A]: 1, [B]: 1 }, highestStock: { [A]: 1, [B]: 1 }, lowestRatio: { [A]: 10, [B]: 1 }, highestRatio: { [A]: 10, [B]: 1 } },
      // route leg buys exalted at 1 divine = 330 exalted
      { league: "Test", marketId: `${B}|${C}`, pair: [B, C] as [string, string], volumeTraded: { [B]: 100_000, [C]: 1_000_000 }, lowestStock: { [B]: 1, [C]: 1 }, highestStock: { [B]: 1, [C]: 1 }, lowestRatio: { [B]: 1, [C]: 330 }, highestRatio: { [B]: 1, [C]: 330 } },
      // liquid reference with a real spread: ~297-300 exalted = 1 divine
      { league: "Test", marketId: `${C}|${B}`, pair: [C, B] as [string, string], volumeTraded: { [C]: 10_000_000, [B]: 100_000 }, lowestStock: { [C]: 1, [B]: 1 }, highestStock: { [C]: 1, [B]: 1 }, lowestRatio: { [C]: 300, [B]: 1 }, highestRatio: { [C]: 297, [B]: 1 } },
    ];
    const edges = deriveEdges(mkts as never, "2026-08-18T22:00:00Z");
    const s = settings({ goldBudget: 2_000_000_000, capitalUnits: 1000 });
    const candidates = enumerateTwoLegFlips(edges, s);
    const scored = candidates
      .map((c) => ({ c, sc: scoreCandidate(c, evaluateCandidate(c), edges, s, Date.parse("2026-08-18T22:00:00Z")) }))
      .find((x) => x.sc.rejection === null);
    expect(scored).toBeDefined();
    const fields = scored!.sc.fields!;
    expect(fields.profitClass).toBe("mark-to-market");
    expect(fields.realizedCurrency).toBeNull();
    expect(fields.valuationBottleneckVolumeShare).toBeLessThanOrEqual(0.2);
    expect(fields.valuationRangeUncertaintyPct).toBeGreaterThan(0);
    expect(fields.valuationExecutable).toBe(false); // return conversion not included
    expect(fields.valuationGoldIncluded).toBe(false);
    expect(fields.valuationTradeCountIncluded).toBe(0);
  });
});
