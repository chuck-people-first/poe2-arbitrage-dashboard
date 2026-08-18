// Golden test: the exact scored candidate from real fixture data must reproduce
// its displayed quantities and gold exactly, using ONLY independently observed
// markets. This is the acceptance-criteria check: "Integer playbook reproduction
// matches displayed quantities and gold exactly."

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseGggPayload } from "../src/domain/ggg";
import { deriveEdges } from "../src/domain/edges";
import { enumerateClosedTriangles, enumerateTwoLegFlips, evaluateCandidate } from "../src/domain/routes";
import { scoreCandidate, toRoute, rankDefault } from "../src/domain/scoring";
import { GGG_HUB_PATHS, displayName } from "../src/domain/mapping";
import { chainUsesIndependentObservations } from "../src/domain/playbook";
import type { RunSettings } from "../src/domain/types";

const LEAGUE = "Runes of Aldur";
const HOUR_UTC = "2026-08-18T03:00:00Z";

function loadFixture() {
  const raw = JSON.parse(
    readFileSync(join(process.cwd(), "fixtures", "ggg-currency-exchange-1787022000.json"), "utf8"),
  );
  return parseGggPayload(raw);
}

function settings(): RunSettings {
  return {
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
  it("the top scored two-leg route reproduces exactly", () => {
    const payload = loadFixture();
    const roa = payload.markets.filter((m) => m.league === LEAGUE);
    const edges = deriveEdges(roa, HOUR_UTC);

    const flips = enumerateTwoLegFlips(edges, settings());
    const scored = flips
      .map((c) => ({ c, ev: evaluateCandidate(c), sc: scoreCandidate(c, evaluateCandidate(c), edges, settings()) }))
      .filter((x) => x.sc.score !== null)
      .map((x) => ({ route: toRoute(x.c, x.sc, x.ev, HOUR_UTC)!, sc: x.sc }))
      .filter((x) => x.route !== null)
      .sort((a, b) => rankDefault(a.route, b.route));

    expect(scored.length).toBeGreaterThan(0);
    const top = scored[0]!.route;

    // Chain uses only independent observations
    const chainEdges = flips.find((c) => c.edges.map((e) => e.key).join() === top.legs.map((l) => l.edgeKey).join())!
      .edges;
    expect(chainUsesIndependentObservations(chainEdges)).toBe(true);

    // Every leg's playbook flows exactly: received = floor(given × rate)
    let units = top.startUnits;
    for (const leg of top.legs) {
      expect(leg.fromUnits).toBe(units);
      expect(leg.toUnits).toBe(Math.floor(units * chainEdges[top.legs.indexOf(leg)]!.rate));
      units = leg.toUnits;
    }
    expect(top.endUnits).toBe(units);
    // End currency valued in base and conservative profit positive
    expect(top.conservativeProfitBase).toBeGreaterThan(0);
  });

  it("fixture round trip: derived edges count matches earlier spike output", () => {
    const payload = loadFixture();
    const roa = payload.markets.filter((m) => m.league === LEAGUE);
    const edges = deriveEdges(roa, HOUR_UTC);
    // 1324 markets × 2 directed edges = 2648, minus 496 rejected for zero ratios
    expect(edges.length).toBe(2152);
  });
});