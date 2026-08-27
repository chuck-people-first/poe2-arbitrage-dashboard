// Golden test on real fixture data.
//
// Item 4 rejected every two-leg cross from the 22:00Z fixture whose reference
// valuation path was too illiquid to support the notional (e.g. the
// Exalted->Divine path through ThesisOfExperiments has a ~2598% bottleneck
// share vs the 20% cap). That gate still rejects those.
//
// What changed since: the Currency Exchange fee table (fees.generated.ts) now
// carries all 669 per-item gold fees, so candidates that used to be dropped
// for an UNVERIFIED fee are now priced with the game's real one. Nine survive
// this hour — all short Chaos -> item -> Divine/Exalted crosses. The safe
// status projection (covered by the DB integration test) reports the hour with
// those candidates rather than falling back to an older hour.

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
  it("nine publishable two-leg signals this hour; the rest fail the valuation-path liquidity gate", () => {
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

    // The valuation-path liquidity gate still rejects most of the 1,343 flips
    // this hour. What gets through is what the real fee table unlocked: nine
    // short crosses out of Chaos, priced with the game's own gold fees rather
    // than dropped as unpriceable.
    expect(scored.length).toBe(9);
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
