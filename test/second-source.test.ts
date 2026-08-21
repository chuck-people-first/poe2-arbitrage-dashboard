// The second source earns its place only if it is measurably better than
// guessing, and only if it never renames an item on price alone. These tests
// pin both claims against the checked-in real hour.

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildDivinePriceBook } from "../src/domain/divine-price.ts";
import { deriveEdges } from "../src/domain/edges.ts";
import { parseGggPayload } from "../src/domain/ggg.ts";
import { GGG_HUB_PATHS, ITEM_MAP } from "../src/domain/mapping.ts";
import { NINJA_BRIDGE_MAPPING, NINJA_BRIDGE_QUARANTINE } from "../src/domain/mapping.ninja-bridge.ts";
import { classifyAgreement, crossSourcePrice, deviationPct } from "../src/domain/cross-source.ts";
import { buildSnapshot, decodeArtPath, normalizeOverview, NINJA_CATEGORIES, type NinjaCategory, type RawOverview } from "../src/integrations/poe-ninja.ts";

const LEAGUE = "Runes of Aldur";
const FIXTURES = join(process.cwd(), "fixtures");
const gggFile = readdirSync(FIXTURES).filter((f) => f.startsWith("ggg-currency-exchange-")).sort().pop()!;
const HOUR = new Date(Number(gggFile.replace("ggg-currency-exchange-", "").replace(".json", "")) * 1000).toISOString();

const payload = parseGggPayload(JSON.parse(readFileSync(join(FIXTURES, gggFile), "utf8")));
const edges = deriveEdges(payload.markets.filter((m) => m.league === LEAGUE), HOUR);
const book = buildDivinePriceBook(edges);

const ninjaDir = join(FIXTURES, "poe-ninja");
const snapshot = buildSnapshot(LEAGUE, readdirSync(ninjaDir).map((f) => ({
  category: f.replace(".json", "") as NinjaCategory,
  raw: JSON.parse(readFileSync(join(ninjaDir, f), "utf8")) as RawOverview,
})), HOUR);
const quoteById = new Map(snapshot.quotes.map((q) => [q.ninjaId, q]));

describe("poe.ninja snapshot", () => {
  it("loads every category with prices, names and the art join key", () => {
    expect(snapshot.quotes.length).toBeGreaterThan(400);
    expect(new Set(snapshot.quotes.map((q) => q.category)).size).toBe(NINJA_CATEGORIES.length);
    for (const quote of snapshot.quotes) {
      expect(quote.divinePrice).toBeGreaterThan(0);
      expect(quote.name.length).toBeGreaterThan(0);
    }
    // Hub rates come back for the cross-check on the hour itself.
    expect(snapshot.hubRatesPerDivine.exalted).toBeGreaterThan(0);
    expect(snapshot.hubRatesPerDivine.chaos).toBeGreaterThan(0);
  });

  it("decodes the poecdn image token to the item's art path", () => {
    const divine = snapshot.quotes.find((q) => q.ninjaId === "divine")!;
    expect(divine.artPath).toBe("2DItems/Currency/CurrencyModValues");
    expect(divine.artLeaf).toBe("CurrencyModValues");
    expect(decodeArtPath("not-an-image")).toBeNull();
    expect(decodeArtPath(undefined)).toBeNull();
  });

  it("drops unpriced and unnamed lines rather than inventing a zero", () => {
    const normalized = normalizeOverview({
      items: [{ id: "a", name: "Real Item" }, { id: "b", name: "No Price" }],
      lines: [{ id: "a", primaryValue: 0.5 }, { id: "b", primaryValue: 0 }, { id: "missing", primaryValue: 9 }],
    }, "Currency");
    expect(normalized.map((q) => q.ninjaId)).toEqual(["a"]);
  });

  it("survives a partial outage instead of failing the run", () => {
    const partial = buildSnapshot(LEAGUE, [], HOUR, ["Currency", "Runes"]);
    expect(partial.quotes).toEqual([]);
    expect(partial.failedCategories).toEqual(["Currency", "Runes"]);
  });
});

describe("Divine price book", () => {
  it("prices from the market where the item itself traded most, not the nearest hop", () => {
    // Blacksmith's Whetstone: the direct Divine market moved 10 Divine and
    // prices it 4x away from the independent source; the Exalted market moved
    // hundreds of units and agrees. Hop count must not decide this.
    const whetstone = book.entries.get("Metadata/Items/Currency/CurrencyWeaponQuality");
    expect(whetstone).toBeDefined();
    expect(whetstone!.basis).not.toBe("direct");
    const ninja = quoteById.get("whetstone")!;
    expect(deviationPct(whetstone!.divine, ninja.divinePrice)!).toBeLessThan(25);
  });

  it("beats the hop-count rule across every item both sources price", () => {
    const matched = [...book.entries.keys()].filter((path) => {
      const id = ITEM_MAP[path]?.ninjaId;
      return id ? quoteById.has(id) : false;
    });
    expect(matched.length).toBeGreaterThan(30);
    const devs = matched
      .map((path) => deviationPct(book.entries.get(path)!.divine, quoteById.get(ITEM_MAP[path]!.ninjaId)!.divinePrice))
      .filter((d): d is number => d !== null);
    const mean = devs.reduce((a, b) => a + b, 0) / devs.length;
    // Benchmarked alternatives scored 17.2-19.3% mean deviation; the chosen
    // rule scored 14.4%. A regression past 16% means the rule drifted.
    expect(mean).toBeLessThan(16);
    // And gross outliers stay rare.
    expect(devs.filter((d) => d > 60).length).toBeLessThanOrEqual(2);
  });

  it("reports how far the hour's own markets disagreed", () => {
    const multi = [...book.entries.values()].filter((e) => e.candidates > 1);
    expect(multi.length).toBeGreaterThan(20);
    for (const entry of multi) expect(entry.spreadPct).toBeGreaterThanOrEqual(0);
    // Thin completed hours genuinely disagree with themselves; that is a real
    // warning the product surfaces rather than averages away.
    expect(multi.some((e) => e.spreadPct > 50)).toBe(true);
  });

  it("keeps the hub rates within sight of the independent source", () => {
    expect(deviationPct(book.exaltedPerDivine, snapshot.hubRatesPerDivine.exalted!)!).toBeLessThan(15);
    expect(deviationPct(book.chaosPerDivine, snapshot.hubRatesPerDivine.chaos!)!).toBeLessThan(15);
  });
});

describe("the bridge never renames an item on price alone", () => {
  it("only accepts identities that came from the shared art file or a curated hypothesis", () => {
    const entries = Object.entries(NINJA_BRIDGE_MAPPING);
    expect(entries.length).toBeGreaterThan(15);
    for (const [path, record] of entries) {
      expect(record.entry.gggPath).toBe(path);
      expect(record.entry.displayName.startsWith("Metadata/")).toBe(false);
      // Every accepted identity is corroborated by both prices.
      expect(record.deviationPct).toBeLessThanOrEqual(25);
      // And none of them may claim a verified gold fee: poe.ninja does not
      // publish Currency Exchange fees.
      expect(record.entry.goldCostPerUnit).toBe(-1);
    }
  });

  it("keeps rejected candidates auditable rather than silently dropping them", () => {
    expect(NINJA_BRIDGE_QUARANTINE.length).toBeGreaterThan(0);
    for (const row of NINJA_BRIDGE_QUARANTINE) expect(row.reason.length).toBeGreaterThan(0);
  });

  it("does not let a fee-unverified bridge entry masquerade as executable", () => {
    for (const path of Object.keys(NINJA_BRIDGE_MAPPING)) {
      const item = ITEM_MAP[path];
      if (!item) continue;
      if (item.mappingSource === "poe-ninja") expect(item.goldCostPerUnit).toBeLessThan(0);
    }
  });
});

describe("cross-source agreement", () => {
  it("never reports a missing second opinion as agreement", () => {
    const alone = crossSourcePrice(0.01, null);
    expect(alone.agreement).toBe("single-source");
    expect(alone.deviationPct).toBeNull();
    expect(alone.sources).toEqual(["ggg-completed-hour"]);
  });

  it("bands deviation from confirmed through conflicting", () => {
    expect(classifyAgreement(0)).toBe("confirmed");
    expect(classifyAgreement(10)).toBe("confirmed");
    expect(classifyAgreement(24)).toBe("close");
    expect(classifyAgreement(40)).toBe("diverging");
    expect(classifyAgreement(80)).toBe("conflicting");
    expect(classifyAgreement(null)).toBe("single-source");
  });

  it("carries both prices so neither source is averaged away", () => {
    const divine = quoteById.get("divine")!;
    const cross = crossSourcePrice(1, divine);
    expect(cross.gggDivine).toBe(1);
    expect(cross.ninjaDivine).toBe(divine.divinePrice);
    expect(cross.sources).toEqual(["ggg-completed-hour", "poe-ninja"]);
  });
});

describe("hub identity", () => {
  it("pins the three hubs to their poe.ninja ids", () => {
    expect(ITEM_MAP[GGG_HUB_PATHS.DIVINE]!.ninjaId).toBe("divine");
    expect(ITEM_MAP[GGG_HUB_PATHS.EXALTED]!.ninjaId).toBe("exalted");
    expect(ITEM_MAP[GGG_HUB_PATHS.CHAOS]!.ninjaId).toBe("chaos");
  });
});
