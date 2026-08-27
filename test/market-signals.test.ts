import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { deriveEdges } from "../src/domain/edges.ts";
import { parseGggPayload } from "../src/domain/ggg.ts";
import { buildMarketSignalRows } from "../src/domain/market-signals.ts";
import { GGG_HUB_PATHS, estimatedGoldCostPerUnit, goldCostPerUnit } from "../src/domain/mapping.ts";
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

  it("uses the verified current Glassblower fee instead of an estimate", () => {
    expect(goldCostPerUnit("Metadata/Items/Currency/CurrencyFlaskQuality")).toEqual({ cost: 750, verified: true });
  });

  it("surfaces a broad named scanner, now with a verified fee on every row", () => {
    // Discovery lists every readable item mispriced at the completed-hour
    // midpoint. Proving the round trip is a separate, stricter question that
    // `classification` answers per row — it is not an entry requirement.
    expect(rows.length).toBeGreaterThan(40);
    expect(rows.every((row) => row.route.discovery?.item.name && !row.route.discovery.item.name.startsWith("Metadata/"))).toBe(true);
    // The gold fee is a static per-item constant in the game's Currency
    // Exchange table, and the generated table carries all 669 of them. Every
    // path that trades on the exchange therefore has a verified fee; a row
    // with an unverified one would mean an item traded that the exchange
    // table does not list, which should not happen.
    expect(rows.every((row) => row.route.discovery?.goldVerified === true)).toBe(true);
  });

  it("prices every listed row against an independently observed return market", () => {
    for (const row of rows) {
      const signal = row.route.discovery!;
      expect(signal.returnLeg).not.toBeNull();
      expect(signal.returnRatio).not.toBeNull();
      expect(signal.priceModel.returnObserved).toBe(true);
      expect(signal.buyLeg.receive).toBe(signal.sellLeg.pay);
      expect(signal.sellLeg.receive).toBe(signal.returnLeg!.pay);
      // A closed-cycle number exists only where an integer sizing actually
      // closed inside the observed hourly liquidity. Where none did, the row
      // still lists (the mispricing is real) but must say so as HIGH RISK
      // rather than persist an impossible liquidity ratio as a plan.
      if (signal.closedCycleProfitPct === null) {
        expect(signal.classification).toBe("high-risk");
        expect(signal.recommendation).toBe("HIGH RISK");
      } else {
        expect(signal.maxVolumeShare).toBeLessThanOrEqual(1);
        expect(signal.finalStartingQuantity).toBeGreaterThanOrEqual(1);
      }
    }
  });

  it("never converts an unknown fee into zero-cost executable profit", () => {
    // No live row exercises this any more — the exchange table covers every
    // traded path — so the invariant is asserted against the gate itself: a
    // path that is not on the Currency Exchange has no fee, and an absent fee
    // reports as unverified with a zero cost the caller must not spend.
    const notExchangeable = "Metadata/Items/Armours/BodyArmours/BodyStr1";
    expect(goldCostPerUnit(notExchangeable)).toEqual({ cost: 0, verified: false });
    const fallback = estimatedGoldCostPerUnit(notExchangeable);
    expect(fallback.verified).toBe(false);
    expect(fallback.cost).toBeGreaterThan(0);
    expect(fallback.basis).toMatch(/fallback/i);
    // And nothing in the scanner reports a fee it did not verify.
    for (const row of rows) {
      const signal = row.route.discovery!;
      if (signal.goldVerified) expect(signal.totalGold).toBeGreaterThan(0);
      else expect(signal.totalGold).toBeNull();
    }
  });

  it("publishes conservative completed-hour ratios in I WANT : I HAVE form", () => {
    for (const row of rows) {
      const signal = row.route.discovery!;
      for (const ratio of [signal.buyRatio, signal.sellRatio, signal.returnRatio]) {
        expect(ratio).not.toBeNull();
        expect(ratio!.want).toBeGreaterThan(0);
        expect(ratio!.have).toBeGreaterThan(0);
        expect(ratio!.side).toBe("conservative-hourly");
        expect(Math.min(ratio!.want, ratio!.have)).toBe(1);
      }
    }
  });

  it("lists exactly the two real GGG hourly ratio boundaries without inventing ladder tiers", () => {
    for (const row of rows) {
      const signal = row.route.discovery!;
      const legs = [
        [signal.buyRatioRange, signal.buyRatio],
        [signal.sellRatioRange, signal.sellRatio],
        [signal.returnRatioRange, signal.returnRatio],
      ] as const;
      for (const [range, conservative] of legs) {
        expect(range).not.toBeNull();
        expect(range!.source).toBe("ggg-completed-hour-boundaries");
        expect(Object.keys(range!).sort()).toEqual(["conservative", "favorable", "source"]);
        expect(range!.conservative).toEqual(conservative);
        expect(range!.conservative.side).toBe("conservative-hourly");
        expect(range!.favorable.side).toBe("favorable-hourly");
        for (const ratio of [range!.favorable, range!.conservative]) {
          expect(Math.min(ratio.want, ratio.have)).toBe(1);
        }
      }
    }
  });

  it("does not combine the three best hourly extremes into a fabricated Bauble cycle", () => {
    const bauble = "Metadata/Items/Currency/CurrencyFlaskQuality";
    const mk = (
      pair: [string, string],
      low: [number, number],
      high: [number, number],
      volume: [number, number],
    ) => ({
      league: LEAGUE,
      marketId: pair.join("|"),
      pair,
      volumeTraded: { [pair[0]]: volume[0], [pair[1]]: volume[1] },
      lowestStock: { [pair[0]]: 1, [pair[1]]: 1 },
      highestStock: { [pair[0]]: 1, [pair[1]]: 1 },
      lowestRatio: { [pair[0]]: low[0], [pair[1]]: low[1] },
      highestRatio: { [pair[0]]: high[0], [pair[1]]: high[1] },
    });
    const screenshotEdges = deriveEdges([
      // The user's live book was ~1 Bauble : 2.90 Exalted. The completed
      // hour rounded to a 3:1 adverse boundary and also contained a tiny 1:2
      // favorable extreme. The scanner must plan from 3:1, not 1:2.
      mk([GGG_HUB_PATHS.EXALTED, bauble], [1, 2], [3, 1], [1394, 969]),
      // Priced so the midpoint spread stays inside the plausibility cap: the
      // point of this case is which BOUNDARY gets used, not the headline size.
      mk([GGG_HUB_PATHS.DIVINE, bauble], [1, 150], [1, 140], [40, 1920]),
      mk([GGG_HUB_PATHS.EXALTED, GGG_HUB_PATHS.DIVINE], [368, 1], [380, 1], [10000, 100]),
    ], HOUR);
    const screenshotRows = buildMarketSignalRows(
      screenshotEdges,
      settings,
      LEAGUE,
      HOUR,
      "screenshot",
      [GGG_HUB_PATHS.EXALTED, GGG_HUB_PATHS.CHAOS, GGG_HUB_PATHS.DIVINE],
    );
    const signal = screenshotRows.find((row) => row.route.discovery?.item.id === bauble)?.route.discovery;
    expect(signal?.buyRatio).toEqual({ want: 1, have: 3, side: "conservative-hourly" });
    expect(signal?.buyRatioRange).toEqual({
      favorable: { want: 2, have: 1, side: "favorable-hourly" },
      conservative: { want: 1, have: 3, side: "conservative-hourly" },
      source: "ggg-completed-hour-boundaries",
    });
    expect(signal?.closedCycleProfitPct).toBeLessThan(25);
    expect(signal?.priceModel.returnConfirmedCyclePct ?? 0).toBeLessThan(25);
  });
});
