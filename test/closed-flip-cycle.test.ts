import { describe, expect, it } from "vitest";
import type { Route, RouteLeg } from "../src/domain/types.ts";
import { toClosedFlipCycle } from "../src/domain/flips.ts";
import { projectRoute } from "../src/domain/opportunity.ts";
import { GGG_HUB_PATHS } from "../src/domain/mapping.ts";

const EX = GGG_HUB_PATHS.EXALTED;
const TUL = "Metadata/Items/Currency/Breach/BreachCatalystCold";
const DIV = GGG_HUB_PATHS.DIVINE;
const HOUR = "2026-08-18T22:00:00Z";
const leg = (from: string, to: string, give: number, receive: number, gold: number, share = .01): RouteLeg => ({
  edgeKey: `${from}->${to}`, from, to, fromUnits: give, toUnits: receive,
  playbook: { give, pay: from, receive, want: to }, goldCost: gold,
  fromShare: share, toShare: share, volumeShare: share,
});
function cycle(overrides: Partial<Route> = {}): Route {
  return {
    id: "closed-1", routeFamilyId: "fam-closed", strategy: "closed-triangle", startCurrency: EX, endCurrency: EX,
    hubCurrency: TUL, startUnits: 265, endUnits: 340,
    legs: [leg(EX, TUL, 265, 62, 43_400), leg(TUL, DIV, 62, 2, 1_600), leg(DIV, EX, 2, 340, 2_000)],
    grossProfitBase: 1, inputValueBase: 1, goldCostTotal: 47_000, movementHaircutPct: 5,
    ratioRangeUncertaintyPct: 5, temporalMovementPct: null, movementStatus: "insufficient-history",
    estimatedMarketImpactPct: 2, conservativeProfitBase: .8, fillConfidence: .8, expectedProfitBase: .9,
    score: 1, divineProfitPerGold: .000017, profitPerTrade: .26, capitalRoiPct: 20,
    bottleneckVolumeShare: .01, bottleneckEdgeKey: "x", dataAgeHours: 1, ratioRangePct: 5,
    profitKind: "closed-realized", profitClass: "closed-realized", realizedCurrency: EX,
    realizedProfitStart: 75, realizedProfitBase: 1, valuation: {
      profitKind: "closed-realized", inputValuationPath: [], outputValuationPath: [], observationIds: [], valuationRates: [],
      returnToBaseLegs: [], returnToBaseIncluded: true, valuationBottleneckVolumeShare: .01,
      valuationRangeUncertaintyPct: 5, valuationConfidence: .8, valuationExecutable: true,
      valuationGoldIncluded: true, valuationTradeCountIncluded: 1,
    }, ...overrides,
  };
}

describe("ClosedFlipCycle", () => {
  it("requires and exposes the independently observed direct return leg", () => {
    const c = toClosedFlipCycle(cycle(), "Runes of Aldur", HOUR, Date.parse("2026-08-18T22:10:00Z"));
    expect(c?.closed).toBe(true); expect(c?.tradeCount).toBe(3);
    expect(c?.returnLeg.pay).toBe(2); expect(c?.returnLeg.receive).toBe(340);
    expect(c?.sellCurrency.name).toBe("Divine Orb");
    expect(c?.netRealizedProfitStart).toBe(75); expect(c?.totalGold).toBe(47_000);
    expect(c?.finalStartingQuantity).toBeGreaterThan(c!.startingQuantity);
    expect(c?.realizedProfitPer100kGold).toBeCloseTo(.8 / 47_000 * 100_000, 5);
  });
  it("projectRoute carries the closed-cycle projection into the public row", () => {
    const row = projectRoute(cycle(), "Runes of Aldur", HOUR, "fixture", Date.parse("2026-08-18T22:10:00Z"));
    expect(row?.cycle?.closed).toBe(true);
    expect(row?.cycle?.tradeCount).toBe(3);
    expect(row?.route.flip).toBeUndefined();
  });
  it("rejects a missing/non-executable return leg", () => {
    expect(toClosedFlipCycle(cycle({ legs: [leg(EX, TUL, 265, 62, 43_400), leg(TUL, DIV, 62, 2, 1_600)] }), "Runes of Aldur", HOUR)).toBeNull();
    expect(toClosedFlipCycle(cycle({ legs: [leg(EX, TUL, 265, 62, 43_400), leg(TUL, DIV, 62, 2, 1_600), leg(DIV, EX, 2, 340, 2_000, .25)] }), "Runes of Aldur", HOUR)).toBeNull();
  });
  it("rejects a return conversion that leaves the player with less starting currency", () => {
    expect(toClosedFlipCycle(cycle({ endUnits: 200, legs: [leg(EX, TUL, 265, 62, 43_400), leg(TUL, DIV, 62, 2, 1_600), leg(DIV, EX, 2, 200, 2_000)] }), "Runes of Aldur", HOUR)).toBeNull();
  });
  it("keeps gold separate from starting-currency profit", () => {
    const c = toClosedFlipCycle(cycle({ legs: [leg(EX, TUL, 265, 62, 4_340), leg(TUL, DIV, 62, 2, 160_000), leg(DIV, EX, 2, 340, 200_000)] }), "Runes of Aldur", HOUR)!;
    expect(c.netRealizedProfitStart).toBe(75); expect(c.totalGold).toBe(364_340);
  });
});
