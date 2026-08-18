import { describe, expect, it } from "vitest";
import { deriveEdges, edgeIndex } from "../src/domain/edges";
import { pairRate } from "../src/domain/ggg";
import { enumerateClosedTriangles, enumerateTwoLegFlips, valueInBase } from "../src/domain/routes";
import type { DirectedEdge, GggMarket, RunSettings } from "../src/domain/types";

const A = "Metadata/Items/Currency/CurrencyRerollRare";
const B = "Metadata/Items/Currency/CurrencyModValues";
const C = "Metadata/Items/Currency/CurrencyAddModToRare";
const D = "Metadata/Items/Currency/CurrencyGemQuality";

function market(pair: [string, string], ratio: [number, number], id = pair.join("|")): GggMarket {
  const [x, y] = pair;
  return {
    league: "Test",
    marketId: id,
    pair,
    volumeTraded: { [x]: 100_000, [y]: 100_000 },
    lowestStock: { [x]: 100, [y]: 100 },
    highestStock: { [x]: 100, [y]: 100 },
    lowestRatio: { [x]: ratio[0], [y]: ratio[1] },
    highestRatio: { [x]: ratio[0], [y]: ratio[1] },
  };
}

function settings(maxLegs: number): RunSettings {
  return {
    startCurrency: A,
    baseCurrency: B,
    capitalUnits: 100,
    goldBudget: 1_000_000,
    maxLegs,
    maxVolumeSharePct: 20,
    minConservativeProfitBase: 0,
    maxDataAgeHours: 0,
    movementRiskTolerancePct: 100,
  };
}

function edge(from: string, to: string, rate: number, key: string): DirectedEdge {
  return {
    observationId: key,
    key,
    reverseEdgeKey: `${to}->${from}#reverse`,
    from,
    to,
    rate,
    rateLow: rate,
    rateHigh: rate,
    volumeFrom: 100_000,
    volumeTo: 100_000,
    hourlyVolume: 100_000,
    hourUtc: "2026-08-18T03:00:00Z",
    source: "ggg-hourly",
    confidence: null,
  };
}

describe("Phase 1 audit regressions", () => {
  it("honors maxLegs: triangles are excluded when maxLegs is two", () => {
    const edges = deriveEdges(
      [market([A, C], [1, 2]), market([C, D], [1, 2]), market([D, A], [1, 1])],
      "2026-08-18T03:00:00Z",
    );
    expect(enumerateTwoLegFlips(edges, settings(2)).every((r) => r.edges.length <= 2)).toBe(true);
    expect(enumerateClosedTriangles(edges, settings(2))).toHaveLength(0);
    expect(enumerateClosedTriangles(edges, settings(3)).length).toBeGreaterThan(0);
  });

  it("does not value a route endpoint through one of the route's own observations", () => {
    const routeEdge = edge(A, B, 2, "route-market");
    const valuationEdge = edge(D, B, 3, "valuation-market");
    expect(valueInBase(D, 10, B, [routeEdge, valuationEdge], new Set([routeEdge.key]))).toBe(30);
    expect(valueInBase(A, 10, B, [routeEdge], new Set([routeEdge.key]))).toBeNull();
  });

  it("preserves duplicate directed observations instead of overwriting one", () => {
    const first = edge(A, B, 1, "market-1");
    const second = edge(A, B, 2, "market-2");
    const index = edgeIndex([first, second]);
    expect(index.getAllByEndpoints(A, B)).toHaveLength(2);
  });

  it("returns null for a malformed zero-ratio pair instead of Infinity", () => {
    const m = market([A, B], [0, 1]);
    expect(pairRate(m, 0, "mid").rate).toBeNull();
    expect(pairRate(m, 1, "low").rate).toBeNull();
  });
});
