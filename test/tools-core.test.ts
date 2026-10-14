import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
// @ts-expect-error -- plain JS Vercel function; a .d.ts in api/ would be deployed as a function
import { flatten } from "../api/prices.js";

const source = readFileSync(new URL("../public/tools-core.js", import.meta.url), "utf8");
const windowObject: Record<string, unknown> = {};
runInNewContext(source, { window: windowObject });
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const T = windowObject.POE2Tools as any;

const book = {
  hubRatesPerDivine: { exalted: 400, chaos: 10 },
  items: [
    { name: "Divine Orb", category: "Currency", divine: 1, volumeDivine: 1000 },
    { name: "Exalted Orb", category: "Currency", divine: 0.0025, volumeDivine: 900 },
    { name: "Chaos Orb", category: "Currency", divine: 0.1, volumeDivine: 800 },
    { name: "Omen of Light", category: "Ritual", divine: 3, volumeDivine: 10 },
    { name: "Greater Essence of Command", category: "Essences", divine: 0.5, volumeDivine: 5 },
  ],
};
const index = T.indexBook(book);

/** Turn a stash-search group into a JS regex so the generated text is checked by behaviour. */
const asRegex = (group: string) => new RegExp(group.replace(/^"|"$/g, ""), "i");

describe("item text parsing", () => {
  it("reads a Ctrl+C currency stack", () => {
    const p = T.parseItemText("Item Class: Stackable Currency\nRarity: Currency\nDivine Orb\n--------\nStack Size: 3/20\n--------\nRandomises the numeric values");
    expect(p).toMatchObject({ itemClass: "Stackable Currency", rarity: "Currency", name: "Divine Orb", baseType: "Divine Orb", stackSize: 3 });
  });

  it("splits a unique into name and base, and reads thousands in stack size", () => {
    const p = T.parseItemText("Item Class: Rings\nRarity: Unique\nBlackheart\nIron Ring\n--------\nRequires: Level 8");
    expect(p).toMatchObject({ rarity: "Unique", name: "Blackheart", baseType: "Iron Ring" });
    expect(T.parseItemText("Rarity: Currency\nExalted Orb\n--------\nStack Size: 1,250/5,000").stackSize).toBe(1250);
  });

  it("reads a waystone tier", () => {
    expect(T.parseItemText("Item Class: Waystones\nRarity: Rare\nGrim Path\nWaystone (Tier 15)\n--------\nWaystone Tier: 15").tier).toBe(15);
  });
});

describe("price check", () => {
  it("prices a stack and converts to hub currencies", () => {
    const r = T.priceCheck(index, "Rarity: Currency\nChaos Orb\n--------\nStack Size: 20/20");
    expect(r.item.name).toBe("Chaos Orb");
    expect(r.totalDivine).toBeCloseTo(2);
    expect(T.convert(r.totalDivine, book.hubRatesPerDivine)).toEqual({ divine: 2, exalted: 800, chaos: 20 });
  });

  it("never prices rare or unique gear from a base-type name collision", () => {
    expect(T.priceCheck(index, "Item Class: Rings\nRarity: Unique\nChaos Orb\nIron Ring").item).toBeNull();
  });

  it("matches a typed name regardless of case and apostrophes", () => {
    expect(T.findItem(index, "divine orb").name).toBe("Divine Orb");
    expect(T.findItem(index, "essence of command").name).toBe("Greater Essence of Command");
    expect(T.findItem(index, "Mirror of Kalandra")).toBeNull();
  });
});

describe("stash value", () => {
  it("accepts every quantity format and totals in Divine", () => {
    const entries = T.parseStashLines("5 Divine Orb\nExalted Orb x400\nChaos Orb: 10\n12x Omen of Light\nMirror of Kalandra\n# comment");
    expect(entries.map((e: { quantity: number }) => e.quantity)).toEqual([5, 400, 10, 12, 1]);
    const v = T.valueStash(index, entries);
    expect(v.totalDivine).toBeCloseTo(5 + 1 + 1 + 36);
    expect(v.unpriced).toBe(1);
  });
});

describe("expected value", () => {
  it("prices book items and custom values, and reports ROI", () => {
    const r = T.expectedValue(index,
      [{ quantity: 400, name: "Exalted Orb" }],
      [{ probPct: 25, quantity: 1, name: "Omen of Light" }, { probPct: 75, quantity: 1, value: 20, unit: "chaos" }]);
    expect(r.costDivine).toBeCloseTo(1);
    expect(r.evDivine).toBeCloseTo(0.25 * 3 + 0.75 * 2);
    expect(r.net).toBeCloseTo(1.25);
    expect(r.roiPct).toBeCloseTo(125);
    expect(r.probTotalPct).toBeCloseTo(100);
  });

  it("counts a line with neither a book price nor a value as unpriced, but a typed 0 as worthless", () => {
    expect(T.expectedValue(index, [{ quantity: 1, name: "Nope" }], []).unpriced).toBe(1);
    const r = T.expectedValue(index, [{ quantity: 1, value: 1, unit: "divine" }], [{ probPct: 90, quantity: 1, value: 0 }]);
    expect(r.unpriced).toBe(0);
    expect(r.net).toBeCloseTo(-1);
  });
});

describe("stash-search regex", () => {
  it("matches exactly the integers in range", () => {
    const re = new RegExp(`^(${T.rangeRegex(7, 23)})$`);
    for (let n = 0; n < 40; n++) expect(re.test(String(n)), String(n)).toBe(n >= 7 && n <= 23);
  });

  it("matches every integer at or above a threshold", () => {
    for (const min of [1, 9, 45, 60, 100, 250]) {
      const re = new RegExp(`^(${T.atLeastRegex(min)})$`);
      for (let n = 0; n < 1200; n++) expect(re.test(String(n)), `${min}:${n}`).toBe(n >= min);
    }
  });

  it("builds tier, threshold, include and exclude groups that behave on item text", () => {
    const out = T.buildSearch({
      tierMin: 14, tierMax: 16,
      thresholds: [{ label: "Item Rarity", min: 50, style: "colon" }, { label: "Movement Speed", min: 25, style: "increased" }],
      include: ["Breach", "Delirium"], exclude: ["Reflect", "no regen"],
    });
    const groups = out.value.match(/"[^"]*"/g)!;
    expect(groups).toHaveLength(5);
    const [tier, rarity, ms, inc, exc] = groups.map(asRegex);
    expect(tier.test("Waystone Tier: 15")).toBe(true);
    expect(tier.test("Waystone Tier: 13")).toBe(false);
    expect(tier.test("Waystone Tier: 1")).toBe(false);
    expect(rarity.test("Item Rarity: +52% (augmented)")).toBe(true);
    expect(rarity.test("Item Rarity: +49%")).toBe(false);
    expect(ms.test("30% increased Movement Speed")).toBe(true);
    expect(ms.test("20% increased Movement Speed")).toBe(false);
    expect(inc.test("delirium")).toBe(true);
    expect(groups[4]).toBe('"!reflect|no regen"');
    expect(exc.source.startsWith("!")).toBe(true);
    expect(out.tooLong).toBe(false);
  });

  it("escapes regex characters in user terms", () => {
    expect(T.buildSearch({ include: ["(+1) level"] }).value).toBe('"\\(\\+1\\) level"');
  });
});

describe("trade links", () => {
  const decode = (url: string) => JSON.parse(decodeURIComponent(url.split("?q=")[1]!));
  it("searches uniques by name and type, rares by base", () => {
    const unique = T.tradeUrl("Runes of Aldur", T.parseItemText("Rarity: Unique\nBlackheart\nIron Ring"));
    expect(unique).toContain("/trade2/search/poe2/Runes%20of%20Aldur?q=");
    expect(decode(unique).query).toMatchObject({ name: "Blackheart", type: "Iron Ring" });
    expect(decode(T.tradeUrl("Standard", T.parseItemText("Rarity: Rare\nDoom Loop\nIron Ring"))).query).toMatchObject({ type: "Iron Ring" });
    expect(decode(T.tradeUrl("Standard", T.parseItemText("Rarity: Rare\nDoom Loop\nIron Ring"))).query.name).toBeUndefined();
  });
});

describe("price proxy flattening", () => {
  it("flattens poe.ninja categories, dedupes ids and keeps hub rates", () => {
    const raw = JSON.parse(readFileSync(new URL("../fixtures/poe-ninja/Currency.json", import.meta.url), "utf8"));
    const b = flatten("Runes of Aldur", [{ category: "Currency", raw }, { category: "Currency", raw }], "2026-01-01T00:00:00Z");
    const ids = b.items.map((i: { id: string }) => i.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(b.hubRatesPerDivine.exalted).toBeGreaterThan(0);
    expect(b.items.find((i: { name: string }) => i.name === "Divine Orb")?.divine).toBe(1);
  });
});
