// Ranks what is worth trading by GOLD, not by spread.
//
// The Currency Exchange fee is a flat number of gold per unit received, so
// gold intensity — the gold it costs to move one Divine of value through an
// item — is that fee divided by the item's Divine price. It is the same
// arithmetic for every item and it varies by five orders of magnitude across
// the exchange, which makes it the first filter on whether a route is worth
// running at all, ahead of how wide its spread looks.
//
// Run: npx tsx scripts/audit-gold-intensity.ts [fixture.json] [league]

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { deriveEdges } from "../src/domain/edges.ts";
import { parseGggPayload } from "../src/domain/ggg.ts";
import { EXCHANGE_FEES } from "../src/domain/fees.generated.ts";
import { GGG_HUB_PATHS } from "../src/domain/mapping.ts";
import type { DirectedEdge } from "../src/domain/types.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const fixture = process.argv[2] ?? join(ROOT, "fixtures/ggg-currency-exchange-1787274000.json");
const league = process.argv[3] ?? "Runes of Aldur";

const payload = parseGggPayload(JSON.parse(readFileSync(fixture, "utf8")));
const markets = payload.markets.filter((m) => m.league === league);
const edges = deriveEdges(markets, "audit");

/**
 * Divine price per unit. Taken from the item's own Divine market where one
 * traded, else one hop through Exalted. Both are direct observations of the
 * hour; nothing is inferred from a similar-looking price.
 */
function divinePrices(): Map<string, number> {
  const price = new Map<string, number>([[GGG_HUB_PATHS.DIVINE, 1]]);
  const traded = (e: DirectedEdge) => e.volumeFrom > 0 && e.volumeTo > 0 && e.rate > 0;
  for (const edge of edges) {
    if (edge.to === GGG_HUB_PATHS.DIVINE && traded(edge)) price.set(edge.from, edge.rate);
  }
  const perExalted = price.get(GGG_HUB_PATHS.EXALTED);
  if (perExalted) {
    for (const edge of edges) {
      if (edge.to !== GGG_HUB_PATHS.EXALTED || price.has(edge.from) || !traded(edge)) continue;
      price.set(edge.from, edge.rate * perExalted);
    }
  }
  return price;
}

const price = divinePrices();
const volume = new Map<string, number>();
for (const market of markets) {
  for (const [path, units] of Object.entries(market.volumeTraded)) {
    volume.set(path, (volume.get(path) ?? 0) + units);
  }
}

const ranked = [...price]
  .flatMap(([path, divine]) => {
    const fee = EXCHANGE_FEES[path];
    const units = volume.get(path) ?? 0;
    if (!fee || divine <= 0 || units <= 0) return [];
    return [{
      name: fee.displayName,
      section: fee.section,
      fee: fee.goldCostPerUnit,
      divine,
      goldPerDivine: fee.goldCostPerUnit / divine,
      throughputDivine: units * divine,
    }];
  })
  .sort((a, b) => a.goldPerDivine - b.goldPerDivine);

const gold = (n: number) => Math.round(n).toLocaleString("en-US");
function table(title: string, rows: typeof ranked) {
  console.log(`\n${title}`);
  console.log("item".padEnd(34) + "section".padEnd(14) + "fee".padStart(8) +
    "gold/divine".padStart(14) + "hour (divine)".padStart(16));
  for (const r of rows) {
    console.log(
      r.name.slice(0, 33).padEnd(34) + r.section.slice(0, 13).padEnd(14) +
      gold(r.fee).padStart(8) + gold(r.goldPerDivine).padStart(14) +
      gold(r.throughputDivine).padStart(16),
    );
  }
}

console.log(`${fixture.split("/").pop()} · ${league} · ${ranked.length} priced, fee-verified items`);
const liquid = ranked.filter((r) => r.throughputDivine >= 200);
table("Cheapest to move value through (>= 200 Divine traded this hour)", liquid.slice(0, 20));
table("Gold traps — same list, worst end", liquid.slice(-10));
