// Phase A — real non-currency identity test.
//
// Proves that a NON-hub currency item flip resolves to its full readable
// identity (real GGG path, full display name, real icon) from the
// authoritative poe.ninja image-decoded bridge, using Tul's Catalyst.
//
// The ITEM ID, readable name and icon come from real metadata. Only the
// arithmetic rates are controlled (this fixture hour has no catalyst market,
// so no live trade data exists to source a rate from).
//
// Exalted -> Tul's Catalyst -> Divine

import { describe, expect, it } from "vitest";
import type { Route, RouteLeg, ValuationDisclosure } from "../src/domain/types.ts";
import { toTwoLegFlip, resolveIdentity, allIdentitiesResolve } from "../src/domain/flips.ts";
import { lookupItem, goldCostPerUnit, GGG_HUB_PATHS } from "../src/domain/mapping.ts";

// Real GGG metadata path for Tul's Catalyst (from the image-decoded bridge).
const TULS = "Metadata/Items/Currency/Breach/BreachCatalystCold";
const EX = GGG_HUB_PATHS.EXALTED; // buy with Exalted
const DIV = GGG_HUB_PATHS.DIVINE; // sell for Divine

const edgeVal = (from: string, to: string, rate = 1) => ({ observationId: `${from}->${to}`, from, to, rate });
const valuation = (): ValuationDisclosure => ({
  profitKind: "mark-to-market",
  inputValuationPath: [edgeVal(EX, DIV)],
  outputValuationPath: [edgeVal(DIV, DIV)],
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
  edgeKey, from, to, fromUnits: give, toUnits: receive,
  playbook: { give, pay: from, receive, want: to },
  goldCost, fromShare: 0.01, toShare: 0.01, volumeShare: 0.02,
});

const HOUR = "2026-08-18T22:00:00Z";
const REF = Date.parse("2026-08-18T22:10:00Z");

// Controlled rates for arithmetic: 300 exalted buys 41 catalysts (= 265 in the
// product example scaled to ~41), then sell 41 catalysts for ~2 divine.
function baseTulFlip(overrides: Partial<Route> = {}): Route {
  return {
    id: "tul1",
    routeFamilyId: "fam-tul",
    strategy: "two-leg-cross",
    startCurrency: EX,
    endCurrency: DIV,
    hubCurrency: TULS,
    legs: [
      leg(EX, TULS, 265, 41, 265 * 120, "EX->TUL"),     // gold = 41 x gold? controlled
      leg(TULS, DIV, 41, 2, 2 * 800, "TUL->DIV"),
    ],
    startUnits: 265,
    endUnits: 2,
    grossProfitBase: 1.21,
    inputValueBase: 0.883,
    goldCostTotal: 265 * 1 + 2 * 1, // controlled small fee for arithmetic
    movementHaircutPct: 1,
    ratioRangeUncertaintyPct: 5,
    temporalMovementPct: null,
    movementStatus: "insufficient-history",
    estimatedMarketImpactPct: 0.5,
    conservativeProfitBase: 1.1,
    fillConfidence: 0.8,
    expectedProfitBase: 1.15,
    score: 1,
    divineProfitPerGold: 100,
    profitPerTrade: 0.5,
    capitalRoiPct: 120,
    bottleneckVolumeShare: 0.02,
    bottleneckEdgeKey: "EX->TUL",
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

describe("non-currency identity: Tul's Catalyst", () => {
  it("resolves Tul's Catalyst from real metadata with full name and icon", () => {
    const item = lookupItem(TULS);
    expect(item).not.toBeNull();
    expect(item!.displayName).toBe("Tul's Catalyst"); // full name, not an abbreviation
    expect(item!.category).toBe("Breach");
    expect(item!.iconUrl).toMatch(/^https:\/\/web\.poecdn\.com\/gen\/image\//);
    expect(item!.iconUrl).toContain("BreachCatalystCold"); // real icon asset

    const ident = resolveIdentity(TULS);
    expect(ident).not.toBeNull();
    expect(ident!.name).toBe("Tul's Catalyst");
    expect(ident!.iconUrl).toBe(item!.iconUrl); // not double-prefixed
  });

  it("builds an executable Exalted -> Tul's Catalyst -> Divine flip with the SAME real item on both legs", () => {
    const flip = toTwoLegFlip(baseTulFlip(), "Runes of Aldur", HOUR, REF);
    expect(flip).not.toBeNull();
    // same item on both legs: buyLeg.receive == sellLeg.pay
    expect(flip!.buyLeg.receive).toBe(flip!.sellLeg.pay);
    expect(flip!.item.id).toBe(TULS);
    expect(flip!.item.name).toBe("Tul's Catalyst");
    expect(flip!.buyCurrency.name).toBe("Exalted Orb");
    expect(flip!.sellCurrency.name).toBe("Divine Orb");
  });

  it("whole executable integer quantities on both legs", () => {
    const flip = toTwoLegFlip(baseTulFlip(), "Runes of Aldur", HOUR, REF)!;
    for (const l of [flip.buyLeg, flip.sellLeg]) {
      expect(Number.isInteger(l.pay)).toBe(true);
      expect(Number.isInteger(l.receive)).toBe(true);
      expect(l.pay).toBeGreaterThan(0);
      expect(l.receive).toBeGreaterThan(0);
    }
    expect(flip.buyLeg.pay).toBe(265);   // Exalted paid
    expect(flip.buyLeg.receive).toBe(41); // Tul's received
    expect(flip.sellLeg.pay).toBe(41);    // Tul's paid
    expect(flip.sellLeg.receive).toBe(2); // Divine received
  });

  it("both legs carry gold and volume", () => {
    const flip = toTwoLegFlip(baseTulFlip(), "Runes of Aldur", HOUR, REF)!;
    expect(flip.buyLeg.goldCost).toBeGreaterThanOrEqual(0);
    expect(flip.sellLeg.goldCost).toBeGreaterThanOrEqual(0);
    expect(flip.goldRequired).toBeGreaterThanOrEqual(0);
    expect(flip.lowestLegVolume).toBeGreaterThan(0);
    expect(typeof flip.fillRisk).toBe("number");
  });

  it("input/output Divine-equivalent and conservative<=gross P&L", () => {
    const flip = toTwoLegFlip(baseTulFlip(), "Runes of Aldur", HOUR, REF)!;
    expect(flip.grossProfitDivine).toBe(1.21);
    expect(flip.conservativeNetProfitDivine).toBe(1.1);
    expect(flip.conservativeNetProfitDivine).toBeLessThanOrEqual(flip.grossProfitDivine);
    expect(flip.inputDivineValue + flip.grossProfitDivine).toBeCloseTo(flip.outputDivineValue, 5);
  });

  it("unresolved and ambiguous identities are rejected from the public flip view", () => {
    // Unresolved path -> null identity, route not promotable.
    expect(lookupItem("Metadata/Items/Currency/NotARealPath")).toBeNull();
    expect(resolveIdentity("Metadata/Items/Currency/NotARealPath")).toBeNull();

    // A route whose hub item is unmapped must not produce a flip.
    const unmapped = baseTulFlip({ hubCurrency: "Metadata/Items/Currency/NotARealPath", legs: [leg(EX, "Metadata/Items/Currency/NotARealPath", 265, 41, 100, "a"), leg("Metadata/Items/Currency/NotARealPath", DIV, 41, 2, 100, "b")] });
    expect(toTwoLegFlip(unmapped, "Runes of Aldur", HOUR, REF)).toBeNull();
    expect(allIdentitiesResolve(unmapped)).toBe(false);
  });

  it("no raw GGG id ever surfaces as the display name", () => {
    const ident = resolveIdentity(TULS)!;
    expect(ident.name).not.toContain("BreachCatalystCold");
    expect(ident.name).not.toContain("Metadata/");
  });

  it("gold for Tul's Catalyst is UNVERIFIED (never marketed/priced without a verified fee)", () => {
    expect(goldCostPerUnit(TULS)).toEqual({ cost: 0, verified: false });
  });
});
