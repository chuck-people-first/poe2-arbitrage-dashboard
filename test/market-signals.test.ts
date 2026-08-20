import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { deriveEdges } from "../src/domain/edges.ts";
import { parseGggPayload } from "../src/domain/ggg.ts";
import { buildMarketSignalRows } from "../src/domain/market-signals.ts";
import { GGG_HUB_PATHS } from "../src/domain/mapping.ts";
import type { RunSettings } from "../src/domain/types.ts";

const LEAGUE = "Runes of Aldur";
const HOUR = "2026-08-18T22:00:00Z";
const settings: RunSettings = {
  league: LEAGUE,
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

describe("broad market signals", () => {
  const payload = parseGggPayload(JSON.parse(readFileSync(
    join(process.cwd(), "fixtures", "ggg-currency-exchange-1787090400.json"),
    "utf8",
  )));
  const edges = deriveEdges(payload.markets.filter((m) => m.league === LEAGUE), HOUR);
  const rows = buildMarketSignalRows(
    edges,
    settings,
    LEAGUE,
    HOUR,
    "fixture",
    [GGG_HUB_PATHS.EXALTED, GGG_HUB_PATHS.CHAOS, GGG_HUB_PATHS.DIVINE],
  );

  it("surfaces a broad named scanner instead of only fee-verified routes", () => {
    expect(rows.length).toBeGreaterThan(10);
    expect(rows.every((row) => row.route.discovery?.item.name && !row.route.discovery.item.name.startsWith("Metadata/"))).toBe(true);
    expect(rows.some((row) => row.route.discovery?.goldVerified === false)).toBe(true);
  });

  it("includes the entire equation with an independently observed return leg", () => {
    for (const row of rows) {
      const signal = row.route.discovery!;
      expect(signal.returnLeg).not.toBeNull();
      expect(signal.finalStartingQuantity).not.toBeNull();
      expect(signal.closedCycleProfitPct).not.toBeNull();
      expect(signal.buyLeg.receive).toBe(signal.sellLeg.pay);
      expect(signal.sellLeg.receive).toBe(signal.returnLeg!.pay);
      expect(signal.maxVolumeShare).toBeLessThanOrEqual(1);
    }
  });

  it("never converts an unknown fee into zero-cost executable profit", () => {
    for (const row of rows.filter((candidate) => !candidate.route.discovery!.goldVerified)) {
      expect(row.route.discovery!.totalGold).toBeNull();
      expect(row.route.discovery!.recommendation).not.toBe("TRADE NOW");
      expect(row.route.discovery!.warning).toMatch(/gold fee is not verified/i);
    }
  });
});
