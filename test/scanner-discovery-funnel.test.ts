// Discovery funnel audit + the anti-fabrication regression.
//
// This file started as a throwaway diagnostic answering "why does production
// show one or two rows?". It is checked in because the answer is a set of
// measured numbers that must not silently move: each stage below is a real
// filter, and a change in any of them is a product change, not a refactor.
//
// It also pins the rule the whole scanner exists to protect: three favorable
// completed-hour boundaries from three different markets may have occurred at
// three different moments in the hour. Multiplying them is a POTENTIAL, never
// an executable cycle, and must never reach a row's headline or ranking.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { conflictsWith, deriveEdges } from "../src/domain/edges.ts";
import { resolveIdentity } from "../src/domain/flips.ts";
import { parseGggPayload } from "../src/domain/ggg.ts";
import { GGG_HUB_PATHS } from "../src/domain/mapping.ts";
import { buildMarketSignalRows } from "../src/domain/market-signals.ts";
import type { DirectedEdge, RunSettings } from "../src/domain/types.ts";

const LEAGUE = "Runes of Aldur";
const HOUR = "2026-08-18T22:00:00Z";
const HUBS = [GGG_HUB_PATHS.EXALTED, GGG_HUB_PATHS.CHAOS, GGG_HUB_PATHS.DIVINE] as const;

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

const payload = parseGggPayload(JSON.parse(readFileSync(
  join(process.cwd(), "fixtures", "ggg-currency-exchange-1787090400.json"),
  "utf8",
)));
const markets = payload.markets.filter((market) => market.league === LEAGUE);
const edges = deriveEdges(markets, HOUR);

/** Re-derive the funnel independently of market-signals.ts, so the audit can
 *  fail when the scanner drifts away from the measurement it is based on. */
function auditFunnel() {
  const hubs = new Set<string>(HUBS);
  const byFrom = new Map<string, DirectedEdge[]>();
  for (const edge of edges) byFrom.set(edge.from, [...(byFrom.get(edge.from) ?? []), edge]);

  let rawCombinations = 0;
  const families = new Map<string, { buy: DirectedEdge; sell: DirectedEdge; back: DirectedEdge | null }>();
  for (const start of HUBS) {
    for (const buy of byFrom.get(start) ?? []) {
      if (hubs.has(buy.to)) continue;
      rawCombinations += 1;
      if (!resolveIdentity(buy.to)) continue;
      for (const sell of byFrom.get(buy.to) ?? []) {
        if (!hubs.has(sell.to) || sell.to === start || conflictsWith(sell, new Set([buy.key]))) continue;
        const key = `${start}|${buy.to}|${sell.to}`;
        if (families.has(key)) continue;
        const back = edges
          .filter((edge) => edge.from === sell.to && edge.to === start && !conflictsWith(edge, new Set([buy.key, sell.key])))
          .sort((a, b) => Math.min(b.volumeFrom, b.volumeTo) - Math.min(a.volumeFrom, a.volumeTo))[0] ?? null;
        families.set(key, { buy, sell, back });
      }
    }
  }
  const all = [...families.values()];
  const withReturn = all.filter((family) => family.back !== null);
  const cycle = (family: typeof all[number], side: (edge: DirectedEdge) => number) =>
    side(family.buy) * side(family.sell) * side(family.back!);
  const midpointPositive = withReturn.filter((f) => cycle(f, (e) => e.rate) > 1);
  // The two gates added once the item map widened to 574 named paths: an item
  // that traded a handful of units has no price, and a four-figure spread is a
  // broken quote rather than an opportunity.
  const liquid = midpointPositive.filter((f) => Math.min(f.buy.volumeTo, f.sell.volumeFrom) >= 25);
  const plausible = liquid.filter((f) => (cycle(f, (e) => e.rate) - 1) * 100 <= 300);
  return {
    liquidEnoughToPrice: liquid.length,
    plausibleSpread: plausible.length,
    marketsInLeague: markets.length,
    rawCombinations,
    readableFamilies: all.length,
    withDirectReturnMarket: withReturn.length,
    positiveFavorable: withReturn.filter((f) => cycle(f, (e) => e.rateHigh) > 1).length,
    positiveMidpoint: withReturn.filter((f) => cycle(f, (e) => e.rate) > 1).length,
    midpointAtLeast25Pct: withReturn.filter((f) => (cycle(f, (e) => e.rate) - 1) * 100 >= 25).length,
    positiveConservative: withReturn.filter((f) => cycle(f, (e) => e.rateLow) > 1).length,
    maxFavorablePct: Math.max(...withReturn.map((f) => (cycle(f, (e) => e.rateHigh) - 1) * 100)),
  };
}

const rows = buildMarketSignalRows(edges, settings, LEAGUE, HOUR, "fixture", HUBS);
const signals = rows.map((row) => row.route.discovery!);

describe("discovery funnel on the checked-in real GGG hour", () => {
  const funnel = auditFunnel();

  it("measures each stage of the candidate funnel", () => {
    // These numbers have moved twice. poe.ninja's bridge took readable families
    // from 98 to 192; poe2scout — which publishes the GGG metadata path and the
    // display name in the same record — took them to 1,372, naming 574 of the
    // 583 traded paths and 100% of traded volume.
    //
    // That coverage also introduced the noise the last two stages exist to
    // remove: hundreds of items that traded once or twice an hour, arriving at
    // the top of the board as "+5,316%" round trips.
    expect(funnel).toMatchObject({
      marketsInLeague: 1389,
      readableFamilies: 1372,
      withDirectReturnMarket: 1372,
      positiveFavorable: 1102,
      positiveMidpoint: 686,
      midpointAtLeast25Pct: 406,
      positiveConservative: 258,
      liquidEnoughToPrice: 271,
      plausibleSpread: 256,
    });
  });

  it("publishes the midpoint-positive families that survive the liquidity and plausibility gates", () => {
    // The old scanner required a positive CONSERVATIVE closed cycle to list at
    // all, which is why readable families collapsed by an order of magnitude
    // before the UI filters even ran. Discovery is the midpoint gate now; what
    // it publishes is then bounded only by whether the market is real.
    expect(rows.length).toBe(funnel.plausibleSpread);
    // Broad: an order of magnitude past the ~14 rows the conservative-only gate
    // published, and past the 90 the poe.ninja bridge alone reached.
    expect(rows.length).toBeGreaterThan(200);
    // But strictly narrower than raw midpoint-positive — the gates are real.
    expect(rows.length).toBeLessThan(funnel.positiveMidpoint);
  });

  it("refuses to price an item that barely traded, however good the ratio looks", () => {
    // A market of one or two units produces whichever single trade happened to
    // occur. Every published row must clear the floor on BOTH item legs.
    for (const signal of signals) expect(signal.itemHourlyVolume).toBeGreaterThanOrEqual(25);
    // And no published spread may be in the range that only a broken quote
    // reaches — the raw hour contains them, the board does not.
    for (const signal of signals) expect(signal.priceModel.twoLegSpreadPct).toBeLessThanOrEqual(300);
    expect(funnel.positiveMidpoint - funnel.liquidEnoughToPrice).toBeGreaterThan(300);
  });

  it("keeps proof scarce even though discovery is broad", () => {
    const confirmed = signals.filter((signal) => signal.classification === "return-confirmed");
    expect(confirmed.length).toBeLessThanOrEqual(funnel.positiveConservative);
    for (const signal of confirmed) {
      expect(signal.goldVerified).toBe(true);
      expect(signal.priceModel.returnConfirmedCyclePct!).toBeGreaterThan(0);
      expect(signal.maxVolumeShare).toBeLessThanOrEqual(settings.maxVolumeSharePct / 100);
    }
  });
});

describe("favorable-boundary multiplication is never executable", () => {
  it("keeps the favorable compound out of the headline and the ranking", () => {
    for (const signal of signals) {
      const { twoLegSpreadPct, targetBidPotentialPct, returnConfirmedCyclePct } = signal.priceModel;
      // The favorable compound is the largest of the three by construction —
      // that is exactly why it may not be the number a row is judged on.
      expect(targetBidPotentialPct).toBeGreaterThanOrEqual(twoLegSpreadPct - 1e-9);
      expect(signal.spreadDivPer100kGold).not.toBe(targetBidPotentialPct);
      if (returnConfirmedCyclePct !== null) {
        expect(returnConfirmedCyclePct).toBeLessThanOrEqual(targetBidPotentialPct + 1e-9);
      }
      expect(signal.recommendation).not.toBe("TRADE NOW");
    }
  });

  it("never lets a favorable-only path claim a confirmed return", () => {
    for (const signal of signals) {
      if (signal.classification !== "return-confirmed") continue;
      // A confirmed row must survive the LEAST favorable boundary on every leg,
      // so its confirmed number can never be the favorable compound.
      expect(signal.priceModel.returnConfirmedCyclePct).toBeGreaterThan(0);
      expect(signal.priceModel.returnConfirmedCyclePct).toBeLessThan(signal.priceModel.targetBidPotentialPct);
    }
  });

  it("does not let the fixture's +1613% favorable compound reach any published figure", () => {
    const funnel = auditFunnel();
    expect(funnel.maxFavorablePct).toBeGreaterThan(1000);
    const maxConfirmed = Math.max(...signals.map((s) => s.priceModel.returnConfirmedCyclePct ?? 0));
    const maxSpread = Math.max(...signals.map((s) => s.priceModel.twoLegSpreadPct));
    expect(maxConfirmed).toBeLessThan(funnel.maxFavorablePct);
    expect(maxSpread).toBeLessThan(funnel.maxFavorablePct);
  });

  it("compounds each price model from one side of every leg's range", () => {
    // Regression for the mixed-boundary bug: taking the favorable price on one
    // market and the conservative price on another produced percentages
    // (+25,900%) that were never simultaneously available.
    const mk = (pair: [string, string], low: [number, number], high: [number, number], volume: [number, number]) => ({
      league: LEAGUE, marketId: pair.join("|"), pair,
      volumeTraded: { [pair[0]]: volume[0], [pair[1]]: volume[1] },
      lowestStock: { [pair[0]]: 1, [pair[1]]: 1 },
      highestStock: { [pair[0]]: 1, [pair[1]]: 1 },
      lowestRatio: { [pair[0]]: low[0], [pair[1]]: low[1] },
      highestRatio: { [pair[0]]: high[0], [pair[1]]: high[1] },
    });
    const item = "Metadata/Items/Currency/CurrencyFlaskQuality"; // Glassblower's Bauble
    const wide = deriveEdges([
      mk([GGG_HUB_PATHS.EXALTED, item], [1, 2], [3, 1], [20000, 20000]),
      mk([GGG_HUB_PATHS.DIVINE, item], [1, 100], [1, 92], [20000, 20000]),
      mk([GGG_HUB_PATHS.EXALTED, GGG_HUB_PATHS.DIVINE], [368, 1], [380, 1], [20000, 20000]),
    ], HOUR);
    const built = buildMarketSignalRows(wide, settings, LEAGUE, HOUR, "synthetic", HUBS);
    for (const row of built) {
      const model = row.route.discovery!.priceModel;
      const legs = row.route.legs;
      expect(legs.length).toBe(2);
      // Every published percentage is reproducible from a single consistent
      // side of each leg's observed range.
      expect(Number.isFinite(model.twoLegSpreadPct)).toBe(true);
      expect(model.discoveryBasis).toBe("ggg-completed-hour-midpoint");
      expect(model.targetBidPotentialPct).toBeGreaterThanOrEqual(model.twoLegSpreadPct - 1e-9);
      if (model.returnConfirmedCyclePct !== null) {
        expect(model.returnConfirmedCyclePct).toBeLessThanOrEqual(model.targetBidPotentialPct + 1e-9);
      }
    }
  });
});

describe("classification is the only thing that promotes a row", () => {
  it("labels every row and keeps the labels consistent with the evidence", () => {
    const seen = new Set<string>();
    for (const signal of signals) {
      seen.add(signal.classification);
      expect(signal.classificationLabel.length).toBeGreaterThan(0);
      switch (signal.classification) {
        case "return-confirmed":
          expect(signal.goldVerified).toBe(true);
          expect(signal.recommendation).toBe("VERIFY NOW");
          break;
        case "fee-check-needed":
          expect(signal.goldVerified).toBe(false);
          expect(signal.priceModel.returnConfirmedCyclePct!).toBeGreaterThan(0);
          expect(signal.recommendation).toBe("WATCH");
          break;
        case "return-quote-available":
          expect(signal.priceModel.returnObserved).toBe(true);
          expect(signal.priceModel.returnConfirmedCyclePct ?? 0).toBeLessThanOrEqual(0);
          break;
        case "high-risk":
          expect(signal.recommendation).toBe("HIGH RISK");
          break;
        default:
          break;
      }
    }
    // The fixture hour must exercise more than one classification, otherwise
    // the broad list has silently collapsed back into a single strict gate.
    expect(seen.size).toBeGreaterThan(2);
  });

  it("ranks on the midpoint model so every row is scored on the same basis", () => {
    const scores = rows.map((row) => row.score);
    expect([...scores].sort((a, b) => b - a)).toEqual(scores);
    for (const row of rows) {
      const signal = row.route.discovery!;
      expect(row.score).toBeCloseTo(signal.priceModel.twoLegSpreadPct - signal.maxVolumeShare * 100, 6);
    }
  });
});
