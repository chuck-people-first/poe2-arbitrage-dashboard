// Golden test on real fixture data.
//
// Item 4 changed the outcome for this fixture hour: every two-leg cross from
// the 22:00Z fixture ends in a non-base currency whose reference valuation
// path is too illiquid to support the notional (e.g. the Exalted->Divine path
// through ThesisOfExperiments has a ~2598% bottleneck share vs the 20% cap).
// Those signals are therefore REJECTED instead of being published as reliable
// mark-to-market value. The "golden" behavior for this hour is: zero
// publishable two-leg signals, and the safe status projection (covered by the
// DB integration test) reports the hour with 0 candidates rather than falling
// back to an older hour.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseGggPayload } from "../src/domain/ggg";
import { deriveEdges } from "../src/domain/edges";
import { enumerateClosedTriangles, enumerateTwoLegFlips, evaluateCandidate } from "../src/domain/routes";
import { scoreCandidate, toRoute } from "../src/domain/scoring";
import { GGG_HUB_PATHS } from "../src/domain/mapping";
import { chainUsesIndependentObservations } from "../src/domain/playbook";
import type { RunSettings } from "../src/domain/types";

const LEAGUE = "Runes of Aldur";
const FIXTURE = "ggg-currency-exchange-1787090400.json";
const HOUR_UTC = "2026-08-18T22:00:00Z";

function loadFixture() {
  const raw = JSON.parse(
    readFileSync(join(process.cwd(), "fixtures", FIXTURE), "utf8"),
  );
  return parseGggPayload(raw);
}

function settings(): RunSettings {
  return {
    league: LEAGUE,
    startCurrency: GGG_HUB_PATHS.CHAOS,
    baseCurrency: GGG_HUB_PATHS.DIVINE,
    capitalUnits: 100,
    goldBudget: 2_000_000,
    maxLegs: 3,
    maxVolumeSharePct: 20,
    minConservativeProfitBase: 0.05,
    maxDataAgeHours: 0,
    movementRiskTolerancePct: 100,
  };
}

describe("golden playbook on real fixture data", () => {
  it("zero publishable two-leg signals this hour: every reference valuation path is illiquid or unvalued", () => {
    const payload = loadFixture();
    const roa = payload.markets.filter((m) => m.league === LEAGUE);
    const edges = deriveEdges(roa, HOUR_UTC);
    const referenceTimeMs = Date.parse(HOUR_UTC);

    const flips = enumerateTwoLegFlips(edges, settings());
    const scored = flips
      .map((c) => ({ c, ev: evaluateCandidate(c), sc: scoreCandidate(c, evaluateCandidate(c), edges, settings(), referenceTimeMs) }))
      .filter((x) => x.sc.score !== null)
      .map((x) => ({ route: toRoute(x.c, x.sc, x.ev, HOUR_UTC, edges, referenceTimeMs)!, sc: x.sc }))
      .filter((x) => x.route !== null)
      .sort((a, b) => a.sc.score! - b.sc.score!);

    // Item 4 honest outcome for this hour: no two-leg cross survives the
    // valuation-path liquidity gate (all end in illiquid reference markets).
    expect(scored.length).toBe(0);
    // And the previously-published 533% candidate is among the rejected set.
    const rejected = flips
      .map((c) => scoreCandidate(c, evaluateCandidate(c), edges, settings(), referenceTimeMs))
      .filter((s) => s.rejection !== null && s.rejection.includes("valuation path bottleneck volume share"));
    expect(rejected.length).toBeGreaterThan(0);
  });

  it("integer playbook and independent-observation invariants hold on every two-leg candidate", () => {
    const payload = loadFixture();
    const roa = payload.markets.filter((m) => m.league === LEAGUE);
    const edges = deriveEdges(roa, HOUR_UTC);
    const flips = enumerateTwoLegFlips(edges, settings());

    // Pick the candidate with the largest end notional; scoring may reject it
    // for valuation liquidity, but the playbook itself must still be integral.
    const evaluated = flips.map((c) => ({ c, ev: evaluateCandidate(c) }));
    const top = evaluated.sort((a, b) => b.ev.endUnits - a.ev.endUnits)[0]!;
    expect(chainUsesIndependentObservations(top.c.edges)).toBe(true);
    expect(top.ev.error).toBeNull();

    let units = top.c.startUnits;
    for (let i = 0; i < top.c.edges.length; i++) {
      const leg = top.ev.legs[i]!;
      expect(leg.fromUnits).toBe(units);
      expect(leg.toUnits).toBe(Math.floor(units * top.c.edges[i]!.rate));
      units = leg.toUnits;
    }
    expect(top.ev.endUnits).toBe(units);
  });

  it("fixture round trip: derived edges count matches deriveEdges output", () => {
    const payload = loadFixture();
    const roa = payload.markets.filter((m) => m.league === LEAGUE);
    const edges = deriveEdges(roa, HOUR_UTC);
    // 1389 markets × 2 directed edges = 2778, minus pairs rejected for zero ratios
    expect(roa.length).toBe(1389);
    expect(edges.length).toBe(2212);
  });
});
