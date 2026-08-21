// Phase A regression tests for the TwoLegFlip product model.
//
// Covers the Phase A acceptance contract:
//   1. IDENTIFIER RESOLUTION — every displayed identity must resolve to a
//      readable name via the checked-in mapping; a raw GGG id is never shown.
//   2. UNRESOLVED / AMBIGUOUS REJECTION — unmapped items are dropped from the
//      public flip projection (never shown as an internal id).
//   3. SAME-ITEM ENFORCEMENT — leg1.to === leg2.from is asserted at build time.
//   4. INTEGER QUANTITIES — both legs carry exact, positive, integer units.
//   5. DIV/GOLD — defined as Net Divine profit per 100K Gold, and matches the
//      explicit formula conservative / gold x 100,000.
//   6. RENDERING — the public projection exposes resolved names, readable
//      quantities, div/gold, volume, fill risk and gold (never raw GGG paths).

import { describe, expect, it } from "vitest";
import type { Route, RouteLeg, RunSettings, ValuationDisclosure } from "../src/domain/types.ts";
import { toTwoLegFlip, resolveIdentity, allIdentitiesResolve, estimateFillRisk, fillRiskLabel } from "../src/domain/flips.ts";
import { lookupItem, displayName, GGG_HUB_PATHS } from "../src/domain/mapping.ts";

const A = GGG_HUB_PATHS.CHAOS; // chaos orb (buy currency)
const X = GGG_HUB_PATHS.DIVINE; // item being flipped (divine orb)
const B = GGG_HUB_PATHS.EXALTED; // sell currency (exalted orb)

const D = GGG_HUB_PATHS.DIVINE;

const edgeVal = (from: string, to: string, rate = 1): { observationId: string; from: string; to: string; rate: number } => ({ observationId: `${from}->${to}`, from, to, rate });

const valuation = (): ValuationDisclosure => ({
  profitKind: "mark-to-market",
  inputValuationPath: [edgeVal(A, D)],
  outputValuationPath: [edgeVal(B, D)],
  observationIds: ["x", "y"],
  valuationRates: [1, 1],
  returnToBaseLegs: [],
  returnToBaseIncluded: false,
  valuationBottleneckVolumeShare: 0.01,
  valuationRangeUncertaintyPct: 5,
  valuationConfidence: 0.8,
  valuationExecutable: false,
  valuationGoldIncluded: false,
  valuationTradeCountIncluded: 0,
});

const leg = (from: string, to: string, give: number, receive: number, goldCost: number, edgeKey: string): RouteLeg => ({
  edgeKey,
  from,
  to,
  fromUnits: give,
  toUnits: receive,
  playbook: { give, pay: from, receive, want: to },
  goldCost,
  fromShare: 0.01,
  toShare: 0.01,
  volumeShare: 0.02,
});

const settings: RunSettings = {
  league: "Test",
  startCurrency: A,
  baseCurrency: D,
  capitalUnits: 100,
  goldBudget: 2_000_000,
  maxLegs: 3,
  maxVolumeSharePct: 20,
  minConservativeProfitBase: 0.01,
  maxDataAgeHours: 0,
  movementRiskTolerancePct: 100,
};

// A clean executable two-leg flip: pay 100 chaos -> receive 10 divine ->
// sell 10 divine -> receive 3300 exalted. The item X (divine) is same in both
// legs. goldCostTotal = 8000 (leg1: 10 divine x 800) + 0 (leg2 gold for exalted
// 3300 would be 396k at 120/ea, scaled for a small fixture).
function baseRoute(overrides: Partial<Route> = {}): Route {
  return {
    id: "r1",
    routeFamilyId: "fam1",
    strategy: "two-leg-cross",
    startCurrency: A,
    endCurrency: B,
    hubCurrency: X,
    legs: [
      leg(A, X, 100, 10, 8000, "A->X"),
      leg(X, B, 10, 3300, 0, "X->B"),
    ],
    startUnits: 100,
    endUnits: 3300,
    grossProfitBase: 2, // output 3 divine equiv - input 1 divine equiv (scaled)
    inputValueBase: 1,
    goldCostTotal: 8000,
    movementHaircutPct: 1,
    ratioRangeUncertaintyPct: 5,
    temporalMovementPct: null,
    movementStatus: "insufficient-history",
    estimatedMarketImpactPct: 0.5,
    conservativeProfitBase: 1.8,
    fillConfidence: 0.8,
    expectedProfitBase: 1.9,
    score: 1,
    divineProfitPerGold: 0.000225,
    profitPerTrade: 0.9,
    capitalRoiPct: 180,
    bottleneckVolumeShare: 0.02,
    bottleneckEdgeKey: "A->X",
    dataAgeHours: 1,
    ratioRangePct: 5,
    profitKind: "mark-to-market",
    profitClass: "mark-to-market",
    realizedCurrency: null,
    realizedProfitStart: null,
    realizedProfitBase: null,
    valuation: valuation(),
    ...overrides,
  };
}

const HOUR = "2026-08-18T22:00:00Z";
const REF = Date.parse("2026-08-18T22:10:00Z");

describe("identifier resolution", () => {
  it("maps the hub currencies to readable names", () => {
    expect(lookupItem(A)?.displayName).toBe("Chaos Orb");
    expect(lookupItem(X)?.displayName).toBe("Divine Orb");
    expect(lookupItem(B)?.displayName).toBe("Exalted Orb");
  });

  it("resolveIdentity returns a readable identity (never a raw GGG path as the name)", () => {
    const id = resolveIdentity(X);
    expect(id).not.toBeNull();
    expect(id!.name).toBe("Divine Orb");
    expect(id!.id).toBe(X); // stable GGG path as the machine key (name is the display)
    expect(typeof id!.goldCostPerUnit).toBe("number");
  });

  it("a path with no mapping resolves to null (rejected, not guessed)", () => {
    expect(lookupItem("Metadata/Items/Unknown/NotAMappedItem")).toBeNull();
    expect(resolveIdentity("Metadata/Items/Unknown/NotAMappedItem")).toBeNull();
    expect(allIdentitiesResolve(baseRoute({ startCurrency: "Metadata/Items/Unknown/Foo" }))).toBe(false);
  });

  it("displayName falls back to a last-segment label only for diagnostics, never in the flip projection", () => {
    expect(displayName(A)).toBe("Chaos Orb");
    expect(displayName("Metadata/Items/Currency/SomeUnmapped")).toBe("SomeUnmapped");
  });
});

describe("same-item two-leg enforcement", () => {
  it("builds a two-leg flip where leg1.to === leg2.from (the same item)", () => {
    const f = toTwoLegFlip(baseRoute(), "Test", HOUR, REF)!;
    expect(f).not.toBeNull();
    expect(f.buyLeg.receive).toBe(f.sellLeg.pay); // received X == paid X
    expect(f.item.id).toBe(X);
  });

  it("rejects a route whose legs do not share the same item (not a clean flip)", () => {
    const bad = toTwoLegFlip(baseRoute({ legs: [leg(A, X, 100, 10, 8000, "A->X"), leg(B, A, 3300, 5, 0, "B->A2")] }), "Test", HOUR, REF);
    expect(bad).toBeNull();
  });

  it("rejects a non-two-leg strategy", () => {
    expect(toTwoLegFlip(baseRoute({ strategy: "closed-triangle", legs: [leg(A, X, 100, 10, 0, "1"), leg(X, B, 10, 5, 0, "2"), leg(B, A, 5, 3, 0, "3")] }), "Test", HOUR, REF)).toBeNull();
  });
});

describe("exact integer quantities", () => {
  it("exposes exact integer pay/receive on both legs", () => {
    const f = toTwoLegFlip(baseRoute(), "Test", HOUR, REF)!;
    for (const l of [f.buyLeg, f.sellLeg]) {
      expect(Number.isInteger(l.pay)).toBe(true);
      expect(Number.isInteger(l.receive)).toBe(true);
      expect(l.pay).toBeGreaterThan(0);
      expect(l.receive).toBeGreaterThan(0);
    }
  });

  it("rejects a route with a non-integer or non-positive unit", () => {
    const r = baseRoute({ legs: [leg(A, X, 100, 10.5, 8000, "A->X"), leg(X, B, 10, 3300, 0, "X->B")] });
    expect(toTwoLegFlip(r, "Test", HOUR, REF)).toBeNull();
  });
});

describe("divineProfitPerGold", () => {
  it("defines divineProfitPerGold as Net Divine profit per 100K Gold with the explicit formula", () => {
    const f = toTwoLegFlip(baseRoute(), "Test", HOUR, REF)!;
    const divineProfitPerGold = f.conservativeNetProfitDivine / f.goldRequired;
    expect(f.divineProfitPerGold).toBe(divineProfitPerGold);
    expect(f.divPer100kGold).toBe(divineProfitPerGold * 100_000);
    // 1.8 / 8000 x 100000 = 22.5
    expect(f.divPer100kGold).toBeCloseTo(22.5, 5);
  });

  it("is 0 when gold is 0 (never divide by zero)", () => {
    const f = toTwoLegFlip(baseRoute({ goldCostTotal: 0 }), "Test", HOUR, REF)!;
    expect(f.divPer100kGold).toBe(0);
  });

  it("gross and conservative P&L are Divine-equivalent and conservative <= gross", () => {
    const f = toTwoLegFlip(baseRoute(), "Test", HOUR, REF)!;
    expect(f.grossProfitDivine).toBe(2);
    expect(f.conservativeNetProfitDivine).toBe(1.8);
    expect(f.conservativeNetProfitDivine).toBeLessThanOrEqual(f.grossProfitDivine);
    expect(f.inputDivineValue + f.grossProfitDivine).toBeCloseTo(f.outputDivineValue, 5);
  });
});

describe("volume and fill risk", () => {
  it("computed lowest-leg volume and a labeled fill-risk estimate (explicitly heuristic)", () => {
    const f = toTwoLegFlip(baseRoute(), "Test", HOUR, REF)!;
    expect(f.lowestLegVolume).toBeGreaterThan(0);
    expect(f.fillRisk).toBeGreaterThanOrEqual(0);
    expect(f.fillRisk).toBeLessThanOrEqual(1);
    expect(["Low", "Medium", "High"]).toContain(f.fillRiskLabel);
  });

  it("fill-risk labels never claim certainty", () => {
    expect(fillRiskLabel(0.05)).toBe("Low");
    expect(fillRiskLabel(0.2)).toBe("Medium");
    expect(fillRiskLabel(0.5)).toBe("High");
    expect(estimateFillRisk(0.5, 100, 10)).toBeGreaterThan(0);
  });

  it("rejects a route with invalid volume share", () => {
    const r = baseRoute({ bottleneckVolumeShare: 0 }); // share <= 0 is invalid
    expect(toTwoLegFlip(r, "Test", HOUR, REF)).toBeNull();
  });
});

describe("rendering-safe projection", () => {
  it("exposes resolved names and readable quantities, never raw GGG paths as display text", () => {
    const f = toTwoLegFlip(baseRoute(), "Test", HOUR, REF)!;
    expect(f.item.name).toMatch(/Divine Orb/);
    expect(f.buyCurrency.name).toMatch(/Chaos Orb/);
    expect(f.sellCurrency.name).toMatch(/Exalted Orb/);
    // The leaf of a raw GGG path must never appear as the display name.
    expect(f.item.name).not.toContain("CurrencyModValues");
    expect(f.buyCurrency.name).not.toContain("CurrencyRerollRare");
    expect(f.sellCurrency.name).not.toContain("CurrencyAddModToRare");
  });

  it("the playbook surfaces exact click/pay/receive/sell instructions", () => {
    const f = toTwoLegFlip(baseRoute(), "Test", HOUR, REF)!;
    expect(f.buyLeg.pay).toBe(100);
    expect(f.buyLeg.receive).toBe(10);
    expect(f.sellLeg.pay).toBe(10);
    expect(f.sellLeg.receive).toBe(3300);
    expect(f.tradeCount).toBe(2);
  });

  it("prominent columns are present: conservative P&L, divineProfitPerGold, volume, fill risk, gold", () => {
    const f = toTwoLegFlip(baseRoute(), "Test", HOUR, REF)!;
    expect(typeof f.conservativeNetProfitDivine).toBe("number");
    expect(typeof f.divPer100kGold).toBe("number");
    expect(typeof f.volumeShare).toBe("number");
    expect(typeof f.fillRisk).toBe("number");
    expect(typeof f.goldRequired).toBe("number");
  });
});
