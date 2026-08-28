// The operator's fee table may add knowledge. It may never fabricate it.
//
// Every test here defends one rule: an unknown fee stays unknown, a fee the
// operator typed is never reported as if the repo had verified it, and a
// partially-priced cycle is never presented as a priced one.

import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("../public/gold-fees.js", import.meta.url), "utf8");
const windowObject: Record<string, unknown> = {};
runInNewContext(source, { window: windowObject });
const fees = windowObject.POE2GoldFees as any;

/** An in-memory stand-in for localStorage, including the throwing kind. */
function fakeStorage(initial?: string, throws = false) {
  let value = initial;
  return {
    getItem: () => { if (throws) throw new Error("blocked"); return value ?? null; },
    setItem: (_k: string, v: string) => { if (throws) throw new Error("blocked"); value = v; },
  };
}

const identity = (id: string, goldCostPerUnit: number) => ({ id, name: id, iconUrl: null, goldCostPerUnit });

// A signal shaped like the ones market-signals.ts emits: the buy leg receives
// the item (the usually-unverified one), the other legs receive hub currency.
const ESSENCE = identity("Metadata/Items/Currency/EssenceAbyss", -1);
const DIVINE = identity("Metadata/Items/Currency/CurrencyModValues", 800);
const EXALTED = identity("Metadata/Items/Currency/CurrencyAddModToRare", 300);

const signal = (overrides: Record<string, unknown> = {}) => ({
  item: ESSENCE,
  buyCurrency: EXALTED,
  sellCurrency: DIVINE,
  buyLeg: { pay: 1000, receive: 10, goldCost: 0, hourlyVolume: 123 },
  sellLeg: { pay: 10, receive: 3, goldCost: 2400, hourlyVolume: 500 },
  returnLeg: { pay: 3, receive: 1200, goldCost: 360000, hourlyVolume: 900 },
  classification: "fee-check-needed",
  closedCycleProfitPct: 185.7,
  estimatedTotalGold: 58000,
  ...overrides,
});

describe("a typed fee is only accepted as a real per-unit number", () => {
  it("rejects zero, negatives, junk and account totals", () => {
    for (const bad of [0, -1, "", "abc", null, undefined, NaN, Infinity, 100001]) {
      expect(fees.normalizeFee(bad)).toBeNull();
    }
  });

  it("accepts a plausible fee and rounds it to whole gold", () => {
    expect(fees.normalizeFee("1,,")).toBeNull();
    expect(fees.normalizeFee(750)).toBe(750);
    expect(fees.normalizeFee("750.4")).toBe(750);
  });

  it("rejects zero specifically, because free is how an unknown cost becomes a fake cycle", () => {
    const applied = fees.applyFees(signal(), { [ESSENCE.id]: 0 });
    expect(applied.allVerified).toBe(false);
    expect(applied.totalGold).toBeNull();
  });
});

describe("storage never breaks the page", () => {
  it("returns an empty table for missing, malformed or hostile stored values", () => {
    expect(fees.load(fakeStorage(undefined))).toEqual({});
    expect(fees.load(fakeStorage("not json"))).toEqual({});
    expect(fees.load(fakeStorage("[1,2,3]"))).toEqual({});
    expect(fees.load(fakeStorage("null"))).toEqual({});
  });

  it("drops individual bad entries but keeps the good ones", () => {
    expect(fees.load(fakeStorage(JSON.stringify({ a: 700, b: 0, c: "x", d: 1200 }))))
      .toEqual({ a: 700, d: 1200 });
  });

  it("survives a storage that throws, in both directions", () => {
    expect(fees.load(fakeStorage(undefined, true))).toEqual({});
    expect(fees.save(fakeStorage(undefined, true), { a: 1 })).toBe(false);
  });

  it("round-trips a saved table", () => {
    const storage = fakeStorage();
    expect(fees.save(storage, { [ESSENCE.id]: 900 })).toBe(true);
    expect(fees.load(storage)).toEqual({ [ESSENCE.id]: 900 });
  });

  it("clears an entry when the value is blanked, falling back to the checked-in table", () => {
    const table = fees.setFee({ [ESSENCE.id]: 900 }, ESSENCE.id, "");
    expect(table[ESSENCE.id]).toBeUndefined();
  });
});

describe("provenance is never laundered", () => {
  it("reports an operator fee as user-verified, never as checked-in-verified", () => {
    const resolved = fees.resolveFee(ESSENCE, { [ESSENCE.id]: 900 });
    expect(resolved.source).toBe("user-verified");
    expect(resolved.verified).toBe(true);
    expect(resolved.cost).toBe(900);
  });

  it("keeps both numbers when the operator disagrees with the checked-in table", () => {
    const resolved = fees.resolveFee(DIVINE, { [DIVINE.id]: 950 });
    expect(resolved.source).toBe("user-verified");
    expect(resolved.checkedInValue).toBe(800);
    expect(resolved.disagrees).toBe(true);
  });

  it("leaves the checked-in fee alone when the operator has not entered one", () => {
    const resolved = fees.resolveFee(DIVINE, {});
    expect(resolved.source).toBe("checked-in-verified");
    expect(resolved.disagrees).toBe(false);
  });

  it("marks a -1 fee unverified and refuses to price it as zero", () => {
    const resolved = fees.resolveFee(ESSENCE, {});
    expect(resolved.verified).toBe(false);
    expect(resolved.cost).toBeNull();
  });
});

describe("an unknown fee is still a hard reject", () => {
  it("yields no total gold while any leg is unpriced", () => {
    const applied = fees.applyFees(signal(), {});
    expect(applied.allVerified).toBe(false);
    expect(applied.totalGold).toBeNull();
    expect(applied.provenance).toBe("unverified");
    expect(applied.unresolved.map((i: any) => i.id)).toEqual([ESSENCE.id]);
  });

  it("prices the cycle only once every leg resolves", () => {
    const applied = fees.applyFees(signal(), { [ESSENCE.id]: 900 });
    expect(applied.allVerified).toBe(true);
    expect(applied.provenance).toBe("user-verified");
    // buy 10 x 900 + sell 3 x 800 + return 1200 x 300
    expect(applied.totalGold).toBe(10 * 900 + 3 * 800 + 1200 * 300);
  });

  it("stays checked-in-verified when the repo already knew every fee", () => {
    const known = signal({ item: identity("Metadata/Items/Currency/CurrencyWeaponQuality", 500) });
    const applied = fees.applyFees(known, {});
    expect(applied.provenance).toBe("checked-in-verified");
    expect(applied.usesOperatorFee).toBe(false);
  });

  it("treats a two-leg signal with no return leg on its own terms", () => {
    const applied = fees.applyFees(signal({ returnLeg: null }), { [ESSENCE.id]: 900 });
    expect(applied.legs).toHaveLength(2);
    expect(applied.totalGold).toBe(10 * 900 + 3 * 800);
  });
});

describe("the fee-check work list", () => {
  it("ranks by what the row would be worth, best first", () => {
    const rows = [
      signal({ closedCycleProfitPct: 20 }),
      signal({ closedCycleProfitPct: 185.7 }),
      signal({ closedCycleProfitPct: 87.5 }),
    ];
    expect(fees.feeCheckQueue(rows, {}).map((e: any) => e.closedCycleProfitPct))
      .toEqual([185.7, 87.5, 20]);
  });

  it("omits rows a fee could never rescue", () => {
    // No closing cycle, or a losing one: checking the fee changes nothing.
    const rows = [signal({ closedCycleProfitPct: null }), signal({ closedCycleProfitPct: -5 })];
    expect(fees.feeCheckQueue(rows, {})).toEqual([]);
  });

  it("lists only rows where the fee is genuinely the last blocker", () => {
    // A high-risk row's headline can look excellent, but its sizing does not
    // fit the hour's liquidity — looking its fee up in game changes nothing.
    const rows = [
      signal({ classification: "high-risk", closedCycleProfitPct: 900 }),
      signal({ classification: "return-quote-available", closedCycleProfitPct: 400 }),
      signal({ classification: "fee-check-needed", closedCycleProfitPct: 12 }),
    ];
    expect(fees.feeCheckQueue(rows, {}).map((e: any) => e.closedCycleProfitPct)).toEqual([12]);
  });

  it("drops a row once its fee is known", () => {
    const rows = [signal()];
    expect(fees.feeCheckQueue(rows, {})).toHaveLength(1);
    expect(fees.feeCheckQueue(rows, { [ESSENCE.id]: 900 })).toHaveLength(0);
  });

  it("collapses to the distinct items worth checking, best potential first", () => {
    const other = identity("Metadata/Items/Currency/OmenAncients", -1);
    const rows = [
      signal({ closedCycleProfitPct: 20 }),
      signal({ item: other, closedCycleProfitPct: 87.5 }),
      signal({ closedCycleProfitPct: 185.7 }),
    ];
    const items = fees.missingFeeItems(rows, {});
    expect(items.map((i: any) => i.identity.id)).toEqual([ESSENCE.id, other.id]);
    expect(items[0].bestProfitPct).toBe(185.7);
    expect(items[0].rows).toBe(2);
  });
});
