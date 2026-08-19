import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { deriveEdges } from "../src/domain/edges.ts";
import { parseGggPayload } from "../src/domain/ggg.ts";
import { GGG_HUB_PATHS } from "../src/domain/mapping.ts";
import {
  DEFAULT_START_CURRENCIES,
  enumerateAllCurrencyRoutes,
  isItemArbitrageCandidate,
  scanOpportunityRows,
} from "../src/domain/scanner.ts";
import type { DirectedEdge, RunSettings } from "../src/domain/types.ts";

const LEAGUE = "Runes of Aldur";
const HOUR = "2026-08-18T22:00:00Z";
const fixture = parseGggPayload(JSON.parse(readFileSync(
  join(process.cwd(), "fixtures", "ggg-currency-exchange-1787090400.json"),
  "utf8",
)));
const edges = deriveEdges(fixture.markets.filter((market) => market.league === LEAGUE), HOUR);

const settings: RunSettings = {
  league: LEAGUE,
  // Legacy/default value only. The automatic scanner replaces it per scope.
  startCurrency: GGG_HUB_PATHS.CHAOS,
  baseCurrency: GGG_HUB_PATHS.DIVINE,
  capitalUnits: 100,
  goldBudget: 2_000_000,
  maxLegs: 3,
  maxVolumeSharePct: 20,
  minConservativeProfitBase: 0.05,
  maxDataAgeHours: 3,
  movementRiskTolerancePct: 100,
};

const ITEM = "Metadata/Items/Currency/CurrencyAddEquipmentSocket";

function edge(from: string, to: string, rate: number, observationId: string): DirectedEdge {
  return {
    observationId,
    key: `${observationId}:${from}->${to}`,
    reverseEdgeKey: `${observationId}:${to}->${from}`,
    from,
    to,
    rate,
    rateLow: rate * 0.995,
    rateHigh: rate * 1.005,
    volumeFrom: 1_000_000,
    volumeTo: 1_000_000,
    hourUtc: HOUR,
    source: "ggg-hourly",
    confidence: null,
  };
}

// A controlled, independently observed profitable cycle:
// 100 Exalted -> 20 Artificer's -> 2 Divine -> 120 Exalted.
// The separate Exalted -> Chaos -> Divine path values start/end capital.
const profitableEdges: DirectedEdge[] = [
  edge(GGG_HUB_PATHS.EXALTED, ITEM, 0.2, "ex-item"),
  edge(ITEM, GGG_HUB_PATHS.DIVINE, 0.1, "item-div"),
  edge(GGG_HUB_PATHS.DIVINE, GGG_HUB_PATHS.EXALTED, 60, "div-ex"),
  edge(GGG_HUB_PATHS.EXALTED, GGG_HUB_PATHS.CHAOS, 0.1, "ex-chaos"),
  edge(GGG_HUB_PATHS.CHAOS, GGG_HUB_PATHS.DIVINE, 0.1, "chaos-div"),
];

describe("automatic multi-currency scanner", () => {
  it("enumerates Exalted, Chaos, and Divine without a user currency choice", () => {
    expect(DEFAULT_START_CURRENCIES).toEqual([
      GGG_HUB_PATHS.EXALTED,
      GGG_HUB_PATHS.CHAOS,
      GGG_HUB_PATHS.DIVINE,
    ]);
    const candidates = enumerateAllCurrencyRoutes(edges, settings);
    const starts = new Set(candidates.map((candidate) => candidate.startCurrency));
    expect(starts).toEqual(new Set(DEFAULT_START_CURRENCIES));
    for (const candidate of candidates) {
      expect(candidate.settings.startCurrency).toBe(candidate.startCurrency);
      expect(isItemArbitrageCandidate(candidate)).toBe(true);
      expect(DEFAULT_START_CURRENCIES).not.toContain(candidate.edges[0]!.to);
      expect(DEFAULT_START_CURRENCIES).toContain(candidate.edges[1]!.to);
    }
  });

  it("finds the genuine Exalted-start opportunity the old Chaos-only scan missed", () => {
    const rows = scanOpportunityRows(
      profitableEdges,
      settings,
      LEAGUE,
      HOUR,
      "fixture-payload",
      Date.parse(HOUR),
    );
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.some((row) => row.startCurrency === GGG_HUB_PATHS.EXALTED)).toBe(true);
    expect(rows.some((row) => row.cycle?.closed && row.cycle.executable)).toBe(true);
  });

  it("includes every leg's gold in any advertised closed cycle", () => {
    const cycle = scanOpportunityRows(
      profitableEdges,
      settings,
      LEAGUE,
      HOUR,
      "fixture-payload",
      Date.parse(HOUR),
    ).find((row) => row.cycle?.closed)?.cycle;
    expect(cycle).toBeDefined();
    expect(cycle!.totalGold).toBe(
      cycle!.buyLeg.goldCost + cycle!.sellLeg.goldCost + cycle!.returnLeg.goldCost,
    );
    expect(cycle!.sellCurrency.name).not.toBe("");
  });
});
