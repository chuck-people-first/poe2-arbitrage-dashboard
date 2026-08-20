// The round trip is the product. A two-leg spread that never converts back has
// not produced any of the currency the player started with, so these assert the
// chain is contiguous, closes in the starting currency, and never reports a net
// figure it has not actually earned.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { deriveEdges } from "../src/domain/edges.ts";
import { parseGggPayload } from "../src/domain/ggg.ts";
import { GGG_HUB_PATHS } from "../src/domain/mapping.ts";
import { buildMarketSignalRows, liquidityBand } from "../src/domain/market-signals.ts";
import type { RunSettings } from "../src/domain/types.ts";

const LEAGUE = "Runes of Aldur";
const HOUR = "2026-08-18T22:00:00Z";
const HUBS = [GGG_HUB_PATHS.EXALTED, GGG_HUB_PATHS.CHAOS, GGG_HUB_PATHS.DIVINE] as const;
const settings: RunSettings = {
  league: LEAGUE, startCurrency: GGG_HUB_PATHS.CHAOS, baseCurrency: GGG_HUB_PATHS.DIVINE,
  capitalUnits: 100, goldBudget: 2_000_000, maxLegs: 3, maxVolumeSharePct: 20,
  minConservativeProfitBase: 0.05, maxDataAgeHours: 3, movementRiskTolerancePct: 100,
};

const payload = parseGggPayload(JSON.parse(readFileSync(
  join(process.cwd(), "fixtures", "ggg-currency-exchange-1787090400.json"), "utf8",
)));
const edges = deriveEdges(payload.markets.filter((m) => m.league === LEAGUE), HOUR);
const signals = buildMarketSignalRows(edges, settings, LEAGUE, HOUR, "fixture", HUBS)
  .map((row) => row.route.discovery!);

describe("the complete round trip", () => {
  it("chains contiguously: what you want from one step is what you have for the next", () => {
    for (const signal of signals) {
      const { steps } = signal.flow;
      expect(steps.map((s) => s.action)).toEqual(["buy", "sell", "convert"]);
      for (let i = 1; i < steps.length; i += 1) {
        expect(steps[i]!.haveCurrency).toBe(steps[i - 1]!.wantCurrency);
        expect(steps[i]!.haveUnits).toBe(steps[i - 1]!.wantUnits);
      }
      // Starts in the starting currency and ends back in it. This is the leg
      // the user kept asking for: Divine has to become Exalted again.
      expect(steps[0]!.haveCurrency).toBe(signal.buyCurrency.name);
      expect(steps[0]!.haveUnits).toBe(signal.flow.startUnits);
      expect(steps.at(-1)!.wantCurrency).toBe(signal.buyCurrency.name);
      expect(steps[1]!.wantCurrency).toBe(signal.sellCurrency.name);
    }
  });

  it("reports net profit only when the loop actually closed", () => {
    for (const signal of signals) {
      const { flow } = signal;
      if (!flow.closesInStartCurrency) {
        expect(flow.finalUnits).toBeNull();
        expect(flow.netUnits).toBeNull();
        expect(flow.netPct).toBeNull();
        continue;
      }
      expect(flow.finalUnits).toBe(signal.finalStartingQuantity);
      expect(flow.netUnits).toBe(flow.finalUnits! - flow.startUnits);
      expect(flow.netPct).toBeCloseTo(signal.closedCycleProfitPct!, 6);
      // The closing step's output IS the final quantity — no separate arithmetic.
      expect(flow.steps.at(-1)!.wantUnits).toBe(flow.finalUnits);
    }
  });

  it("keeps an unverified gold fee out of the flow as null, never as zero", () => {
    for (const signal of signals) {
      for (const step of signal.flow.steps) {
        if (step.goldCost === null) continue;
        expect(step.goldCost).toBeGreaterThanOrEqual(0);
      }
      // A verified total exists exactly when every step's fee is verified —
      // an unknown fee is never quietly summed as zero.
      const anyUnknown = signal.flow.steps.some((step) => step.goldCost === null);
      expect(signal.flow.totalGold === null).toBe(anyUnknown);
      expect(signal.flow.estimatedTotalGold).toBeGreaterThan(0);
      if (signal.flow.totalGold !== null) {
        const summed = signal.flow.steps.reduce((total, step) => total + step.goldCost!, 0);
        expect(signal.flow.totalGold).toBe(summed);
      }
    }
  });

  it("covers the flow the player actually runs: buy with Exalted or Chaos, sell for Divine, convert back", () => {
    const divineExit = signals.filter((s) => s.sellCurrency.id === GGG_HUB_PATHS.DIVINE);
    expect(divineExit.length).toBeGreaterThan(10);
    for (const signal of divineExit) {
      expect([GGG_HUB_PATHS.EXALTED, GGG_HUB_PATHS.CHAOS]).toContain(signal.buyCurrency.id);
      expect(signal.flow.steps[2]!.haveCurrency).toBe("Divine Orb");
      expect(signal.flow.steps[2]!.wantCurrency).toBe(signal.buyCurrency.name);
    }
    // And the canonical Exalted loop is present.
    expect(divineExit.filter((s) => s.buyCurrency.id === GGG_HUB_PATHS.EXALTED).length).toBeGreaterThan(0);
  });
});

describe("liquidity band", () => {
  it("distinguishes order sizes instead of saturating", () => {
    expect(liquidityBand(0.01)).toBe("Low");
    expect(liquidityBand(0.05)).toBe("Low");
    expect(liquidityBand(0.06)).toBe("Medium");
    expect(liquidityBand(0.2)).toBe("Medium");
    expect(liquidityBand(0.21)).toBe("High");
    expect(liquidityBand(Number.POSITIVE_INFINITY)).toBe("High");
    // The fixture must exercise more than one band, or the column is decoration.
    expect(new Set(signals.map((s) => s.liquidityLabel)).size).toBeGreaterThan(1);
  });
});
