// PHASE 0 GATE TESTS.
// The most important test in the codebase: a rate and its reciprocal are the
// SAME observation and must never fabricate an arbitrage. This test proves it.

import { describe, expect, it } from "vitest";
import { deriveEdges } from "../src/domain/edges";
import { enumerateClosedTriangles, enumerateTwoLegFlips, evaluateCandidate } from "../src/domain/routes";
import { scoreCandidate } from "../src/domain/scoring";
import { chainUsesIndependentObservations, walkChain } from "../src/domain/playbook";
import type { GggMarket, RunSettings } from "../src/domain/types";
import { GGG_HUB_PATHS } from "../src/domain/mapping";

const DIVINE = GGG_HUB_PATHS.DIVINE;
const EXALTED = GGG_HUB_PATHS.EXALTED;
const CHAOS = GGG_HUB_PATHS.CHAOS;

function market(league: string, pair: [string, string], ratio: [number, number], volume: [number, number]): GggMarket {
  const [a, b] = pair;
  return {
    league,
    marketId: `${a}|${b}`,
    pair,
    volumeTraded: { [a]: volume[0], [b]: volume[1] },
    lowestStock: { [a]: 0, [b]: 0 },
    highestStock: { [a]: 0, [b]: 0 },
    lowestRatio: { [a]: ratio[0], [b]: ratio[1] },
    highestRatio: { [a]: ratio[0], [b]: ratio[1] },
  };
}

function settings(overrides: Partial<RunSettings> = {}): RunSettings {
  return {
    startCurrency: CHAOS,
    baseCurrency: DIVINE,
    capitalUnits: 1000,
    goldBudget: 5_000_000,
    maxLegs: 3,
    maxVolumeSharePct: 20,
    minConservativeProfitBase: 0.001,
    maxDataAgeHours: 0,
    movementRiskTolerancePct: 100,
    ...overrides,
  };
}

describe("reciprocal edges never fabricate arbitrage", () => {
  it("a two-leg route built from one market's own reciprocal produces ZERO profitable routes", () => {
    // One market: 100 chaos = 1 divine. Both directions derive from this single
    // observation. Any route CHAOS -> X -> DIVINE where X is also derived from
    // the same observation must be rejected before scoring.
    const mkts = [
      market("ROA", [CHAOS, DIVINE], [100, 1], [100000, 1000]),
      // A fake "X" whose only markets are chaos/x and x/divine from the SAME pair:
      // X is divine's alias — the route generator must not treat X as real.
    ];
    const edges = deriveEdges(mkts, "2026-08-18T00:00:00Z");
    const flips = enumerateTwoLegFlips(edges, settings());
    // With only one market, there can be no independent second leg:
    expect(flips.length).toBe(0);
  });

  it("triangle using the same market twice is rejected by independent-observation check", () => {
    const mkts = [
      market("ROA", [CHAOS, DIVINE], [100, 1], [100000, 1000]),
      market("ROA", [DIVINE, EXALTED], [1, 200], [1000, 200000]),
      market("ROA", [EXALTED, CHAOS], [2, 150], [200000, 150000]), // inconsistent: 2 ex = 150 chaos
    ];
    const edges = deriveEdges(mkts, "2026-08-18T00:00:00Z");
    // Build the triangle CHAOS -> DIVINE -> EXALTED -> CHAOS manually:
    const e1 = edges.find((e) => e.from === CHAOS && e.to === DIVINE)!;
    const e2 = edges.find((e) => e.from === DIVINE && e.to === EXALTED)!;
    const e3 = edges.find((e) => e.from === EXALTED && e.to === CHAOS)!;
    // All three are distinct markets — this is a legitimate triangle.
    expect(chainUsesIndependentObservations([e1, e2, e3])).toBe(true);
    // But using e1 then its reverse is rejected:
    const reverse = edges.find((e) => e.from === DIVINE && e.to === CHAOS && e.observationId === e1.observationId)!;
    expect(chainUsesIndependentObservations([e1, reverse])).toBe(false);
  });

  it("no manufactured edge from a single price pairs with itself", () => {
    // One market with a 150:1 ratio — the edge A->B and B->A come from the same
    // observation. A two-leg "A -> B -> A" round trip must never be emitted.
    const mkts = [market("ROA", [EXALTED, DIVINE], [150, 1], [500000, 3500])];
    const edges = deriveEdges(mkts, "2026-08-18T00:00:00Z");
    const flips = enumerateTwoLegFlips(edges, settings({ startCurrency: EXALTED }));
    expect(flips.length).toBe(0);
    const triangles = enumerateClosedTriangles(edges, settings({ startCurrency: EXALTED }));
    expect(triangles.length).toBe(0);
  });
});

describe("closed triangle with genuinely inconsistent independent markets", () => {
  it("detects a triangle when three markets disagree", () => {
    const mkts = [
      market("ROA", [CHAOS, DIVINE], [100, 1], [10000, 100]), // 100 c = 1 d
      market("ROA", [DIVINE, EXALTED], [1, 210], [100, 21000]), // 1 d = 210 e
      market("ROA", [EXALTED, CHAOS], [2, 190], [21000, 19000]), // 2 e = 190 c => 105 c per e
    ];
    const edges = deriveEdges(mkts, "2026-08-18T00:00:00Z");
    const candidates = enumerateClosedTriangles(edges, settings());
    expect(candidates.length).toBeGreaterThan(0);
    for (const c of candidates) {
      expect(chainUsesIndependentObservations(c.edges)).toBe(true);
      const ev = evaluateCandidate(c);
      expect(ev.error).toBeNull();
    }
  });
});

describe("integer playbook conservation", () => {
  it("received units are floored, never rounded up", () => {
    const mkts = [market("ROA", [CHAOS, DIVINE], [100, 1], [10000, 100])];
    const edges = deriveEdges(mkts, "2026-08-18T00:00:00Z");
    const e = edges.find((x) => x.from === CHAOS && x.to === DIVINE)!;
    // 100 chaos -> exactly 1 divine
    const res = walkChain([e], 100);
    expect(res.endUnits).toBe(1);
    const res2 = walkChain([e], 250); // 250 * 0.01 = 2.5 -> 2
    expect(res2.endUnits).toBe(2);
  });
});

describe("hard filters", () => {
  it("caps volume share at configured ceiling", () => {
    const mkts = [
      market("ROA", [CHAOS, DIVINE], [100, 1], [1000, 10]), // tiny market
      market("ROA", [CHAOS, EXALTED], [100, 2], [1_000_000, 20_000]), // deep market
    ];
    const edges = deriveEdges(mkts, "2026-08-18T00:00:00Z");
    const candidates = enumerateTwoLegFlips(edges, settings());
    const scored = candidates
      .map((c) => scoreCandidate(c, evaluateCandidate(c), edges, settings()))
      .filter((s) => s.rejection === null);
    // X must have enough volume — the 100:10 market caps at 10% of 10 units.
    for (const s of scored) {
      expect(s.fields!.bottleneckVolumeShare).toBeLessThanOrEqual(0.2);
    }
  });
});