// The Currency Exchange gold fee, and what it costs to be wrong about it.
//
// The fee is a static per-item constant from the game's own exchange table,
// and an order's gold cost is that constant times the number of units bought
// on the "I want" side. Everything here is asserted against the generated
// table and the checked-in real GGG hour, so a bad regeneration fails loudly.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { EXCHANGE_FEES } from "../src/domain/fees.generated.ts";
import { deriveEdges } from "../src/domain/edges.ts";
import { parseGggPayload } from "../src/domain/ggg.ts";
import { GGG_HUB_PATHS, goldCostPerUnit, lookupItem } from "../src/domain/mapping.ts";

const LEAGUE = "Runes of Aldur";
const HOUR = "2026-08-21T01:00:00Z";
const FIXTURE = "ggg-currency-exchange-1787274000.json";

const payload = parseGggPayload(
  JSON.parse(readFileSync(join(process.cwd(), "fixtures", FIXTURE), "utf8")),
);
const markets = payload.markets.filter((m) => m.league === LEAGUE);

/** Every path that actually moved units in the completed hour. */
function tradedPaths(): Map<string, number> {
  const volume = new Map<string, number>();
  for (const market of markets) {
    for (const [path, units] of Object.entries(market.volumeTraded)) {
      volume.set(path, (volume.get(path) ?? 0) + units);
    }
  }
  return new Map([...volume].filter(([, units]) => units > 0));
}

describe("currency exchange gold fees", () => {
  it("covers every path that traded in the completed hour", () => {
    const traded = tradedPaths();
    const missing = [...traded.keys()].filter((path) => !EXCHANGE_FEES[path]);
    expect(traded.size).toBeGreaterThan(500);
    expect(missing).toEqual([]);
    for (const path of traded.keys()) {
      expect(goldCostPerUnit(path)).toEqual({
        cost: EXCHANGE_FEES[path]!.goldCostPerUnit,
        verified: true,
      });
    }
  });

  it("agrees with every fee that was verified by hand from the wiki", () => {
    // The ten hand-entered values plus the three hub currencies. The generated
    // table replaced them wholesale, so this is the check that the scrape
    // reads the same numbers a human read off the published table.
    const byHand: Record<string, number> = {
      "Orb of Annulment": 1000,
      "Artificer's Shard": 100,
      "Glassblower's Bauble": 750,
      "Lesser Jeweller's Orb": 200,
      "Greater Jeweller's Orb": 600,
      "Perfect Jeweller's Orb": 1000,
      "Orb of Chance": 1000,
      "Vaal Orb": 160,
      "Arcanist's Etcher": 500,
      "Blacksmith's Whetstone": 500,
      "Divine Orb": 800,
      "Exalted Orb": 120,
      "Chaos Orb": 160,
    };
    const generated = new Map(
      Object.values(EXCHANGE_FEES).map((fee) => [fee.displayName, fee.goldCostPerUnit]),
    );
    for (const [name, gold] of Object.entries(byHand)) {
      expect([name, generated.get(name)]).toEqual([name, gold]);
    }
  });

  it("keeps the hub currencies' fees consistent between the table and the item map", () => {
    for (const path of Object.values(GGG_HUB_PATHS)) {
      expect(lookupItem(path)!.goldCostPerUnit).toBe(EXCHANGE_FEES[path]!.goldCostPerUnit);
    }
  });

  it("prices a path that is not on the exchange as unverified rather than free", () => {
    expect(EXCHANGE_FEES["Metadata/Items/Armours/BodyArmours/BodyStr1"]).toBeUndefined();
    expect(goldCostPerUnit("Metadata/Items/Armours/BodyArmours/BodyStr1"))
      .toEqual({ cost: 0, verified: false });
  });

  it("shows why the denomination a leg lands in decides its gold cost", () => {
    // The fee is per unit, so buying a Divine's worth of a cheap currency
    // costs a multiple of what buying the Divine costs. This is the single
    // biggest lever on whether a route is worth running, and it is a property
    // of the fee table rather than of any hour's prices.
    const edges = deriveEdges(markets, HOUR);
    const divPerExalt = edges.find(
      (e) => e.from === GGG_HUB_PATHS.EXALTED && e.to === GGG_HUB_PATHS.DIVINE,
    );
    expect(divPerExalt).toBeDefined();

    const exaltedPerDivine = 1 / ((divPerExalt!.rateLow + divPerExalt!.rateHigh) / 2);
    expect(exaltedPerDivine).toBeGreaterThan(300);

    const goldForOneDivine = EXCHANGE_FEES[GGG_HUB_PATHS.DIVINE]!.goldCostPerUnit;
    const goldForItsWorthInExalted =
      exaltedPerDivine * EXCHANGE_FEES[GGG_HUB_PATHS.EXALTED]!.goldCostPerUnit;

    expect(goldForOneDivine).toBe(800);
    expect(goldForItsWorthInExalted).toBeGreaterThan(40_000);
    expect(goldForItsWorthInExalted / goldForOneDivine).toBeGreaterThan(45);
  });
});
