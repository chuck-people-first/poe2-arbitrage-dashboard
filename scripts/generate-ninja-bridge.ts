// Generates src/domain/mapping.ninja-bridge.ts — item identities established
// from the poe.ninja art file and CONFIRMED by two independent prices.
//
// Method, and why it is not guessing:
//   1. IDENTITY comes from the poecdn art path. Two entries that reference the
//      same art file are the same item; the art token is part of the CDN URL
//      and is not something we infer.
//   2. An art leaf claimed by more than one poe.ninja line is ambiguous and is
//      dropped outright.
//   3. Each surviving identity is then VALIDATED: the item's Divine price from
//      the GGG completed hour must agree with poe.ninja's within tolerance.
//      A failed check quarantines the entry.
//
// Price is never used to *find* an identity — only to confirm one. Measured
// against the checked-in known-good table, price-only matching scores 25-44%,
// which is why it is confined to a validation role.
//
// Run: npx tsx scripts/generate-ninja-bridge.ts

import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { deriveEdges } from "../src/domain/edges.ts";
import { parseGggPayload } from "../src/domain/ggg.ts";
import { buildDivinePriceBook } from "../src/domain/divine-price.ts";
import { ITEM_MAP } from "../src/domain/mapping.ts";
import { buildSnapshot, type NinjaCategory, type RawOverview } from "../src/integrations/poe-ninja.ts";

/**
 * Curated semantic hypotheses for paths the art bridge cannot reach, each one
 * still subject to the same price validation below.
 *
 * These exist because the checked-in hand-written table names GGG paths that
 * the live feed no longer trades at all (`CurrencyVaal`, `AnnullOrb`): the
 * game renamed them and the table was never updated, so three high-volume
 * currencies went unnamed. A hypothesis is admitted only when the metadata
 * leaf plainly describes the item AND both sources price it the same.
 *
 * Never add a row here on price proximity alone. Measured on this hour, the
 * price-nearest poe.ninja line is usually the WRONG item — `CurrencyCorrupt`'s
 * nearest is "Greater Essence of Command" at 1.2% while the correct Vaal Orb
 * sits at 1.8%. Semantics select the candidate; price only confirms it.
 */
const SEMANTIC_HYPOTHESES: Record<string, string> = {
  // "Corrupt" is what a Vaal Orb does.
  "Metadata/Items/Currency/CurrencyCorrupt": "vaal",
  // "RemoveMod" is what an Orb of Annulment does.
  "Metadata/Items/Currency/CurrencyRemoveMod": "annul",
  // "UpgradeRandomly" is the Orb of Chance's random-unique upgrade.
  "Metadata/Items/Currency/CurrencyUpgradeRandomly": "chance",
  // Breach shards ARE Breach Splinters; poe.ninja files them under Breach.
  "Metadata/Items/Currency/CurrencyBreachShard": "breach-splinter",
};

const LEAGUE = "Runes of Aldur";
const TOLERANCE_PCT = 25;
const FIXTURES = join(process.cwd(), "fixtures");
const OUT = join(process.cwd(), "src", "domain", "mapping.ninja-bridge.ts");

function latestGggFixture(): { file: string; hourUtc: string } {
  const files = readdirSync(FIXTURES).filter((f) => f.startsWith("ggg-currency-exchange-")).sort();
  const file = files[files.length - 1]!;
  const stamp = Number(file.replace("ggg-currency-exchange-", "").replace(".json", ""));
  return { file, hourUtc: new Date(stamp * 1000).toISOString() };
}

const { file, hourUtc } = latestGggFixture();
const payload = parseGggPayload(JSON.parse(readFileSync(join(FIXTURES, file), "utf8")));
const edges = deriveEdges(payload.markets.filter((m) => m.league === LEAGUE), hourUtc);
const book = buildDivinePriceBook(edges);

const ninjaDir = join(FIXTURES, "poe-ninja");
const snapshot = buildSnapshot(LEAGUE, readdirSync(ninjaDir).map((f) => ({
  category: f.replace(".json", "") as NinjaCategory,
  raw: JSON.parse(readFileSync(join(ninjaDir, f), "utf8")) as RawOverview,
})), hourUtc);

// Step 1-2: art-leaf identity, ambiguous leaves dropped.
const byLeaf = new Map<string, typeof snapshot.quotes>();
for (const quote of snapshot.quotes) {
  if (!quote.artLeaf) continue;
  byLeaf.set(quote.artLeaf, [...(byLeaf.get(quote.artLeaf) ?? []), quote]);
}

const gggPaths = new Set<string>();
for (const market of payload.markets.filter((m) => m.league === LEAGUE)) {
  gggPaths.add(market.pair[0]); gggPaths.add(market.pair[1]);
}

interface Accepted { path: string; ninjaId: string; name: string; iconUrl: string | null; category: string; gggDivine: number; ninjaDivine: number; deviationPct: number }
const accepted: Accepted[] = [];
const quarantined: Array<{ path: string; reason: string }> = [];

const byNinjaId = new Map(snapshot.quotes.map((q) => [q.ninjaId, q]));

for (const path of [...gggPaths].sort()) {
  const leaf = path.split("/").pop()!;
  const hypothesis = SEMANTIC_HYPOTHESES[path];
  const candidates = hypothesis
    ? (byNinjaId.has(hypothesis) ? [byNinjaId.get(hypothesis)!] : [])
    : byLeaf.get(leaf);
  if (!candidates?.length) {
    if (hypothesis) quarantined.push({ path, reason: `hypothesised poe.ninja id "${hypothesis}" not present` });
    continue;
  }
  if (candidates.length > 1) { quarantined.push({ path, reason: `ambiguous art leaf (${candidates.length} poe.ninja lines)` }); continue; }
  const quote = candidates[0]!;
  const gggDivine = book.perUnit.get(path);
  if (!gggDivine || !(gggDivine > 0)) { quarantined.push({ path, reason: "no GGG Divine price this hour" }); continue; }
  const deviation = Math.abs(gggDivine - quote.divinePrice) / Math.max(gggDivine, quote.divinePrice) * 100;
  if (deviation > TOLERANCE_PCT) { quarantined.push({ path, reason: `price disagreement ${deviation.toFixed(1)}% > ${TOLERANCE_PCT}%` }); continue; }
  accepted.push({ path, ninjaId: quote.ninjaId, name: quote.name, iconUrl: quote.iconUrl, category: quote.category, gggDivine, ninjaDivine: quote.divinePrice, deviationPct: Number(deviation.toFixed(2)) });
}

const fresh = accepted.filter((a) => !ITEM_MAP[a.path]);
const header = `// GENERATED by scripts/generate-ninja-bridge.ts — do not edit by hand.
//
// Identity established from the poe.ninja art file, then confirmed by two
// independent Divine prices (GGG completed hour vs poe.ninja) agreeing within
// ${TOLERANCE_PCT}%. Ambiguous art leaves and price disagreements are quarantined,
// never guessed.
//
// Source hour : ${hourUtc}
// Accepted    : ${accepted.length} (${fresh.length} not already in the checked-in map)
// Quarantined : ${quarantined.length}
//
// goldCostPerUnit is deliberately -1 (FEE_UNKNOWN): poe.ninja does not publish
// Currency Exchange gold fees, so these items render a readable identity and a
// price, and remain excluded from any fee-verified claim.

import type { ItemId } from "./types.ts";

export interface NinjaBridgeEntry {
  entry: ItemId;
  ninjaId: string;
  /** Divine price from each source at generation time, and their gap. */
  gggDivine: number;
  ninjaDivine: number;
  deviationPct: number;
}

export const NINJA_BRIDGE_MAPPING: Record<string, NinjaBridgeEntry> = {
`;

const body = accepted.map((a) => `  ${JSON.stringify(a.path)}: {
    entry: {
      gggPath: ${JSON.stringify(a.path)},
      ninjaId: ${JSON.stringify(a.ninjaId)},
      displayName: ${JSON.stringify(a.name)},
      category: ${JSON.stringify(a.category)},
      iconUrl: ${JSON.stringify(a.iconUrl)},
      goldCostPerUnit: -1,
      mappingSource: "poe-ninja",
      lastVerifiedUtc: ${JSON.stringify(hourUtc)},
    },
    ninjaId: ${JSON.stringify(a.ninjaId)},
    gggDivine: ${a.gggDivine},
    ninjaDivine: ${a.ninjaDivine},
    deviationPct: ${a.deviationPct},
  },`).join("\n");

const footer = `
};

/** Paths rejected at generation time, kept so the exclusion is auditable. */
export const NINJA_BRIDGE_QUARANTINE: Array<{ path: string; reason: string }> = ${JSON.stringify(quarantined, null, 2)};
`;

writeFileSync(OUT, header + body + footer);
console.log(`GGG paths traded         : ${gggPaths.size}`);
console.log(`art-leaf identities      : ${[...gggPaths].filter((p) => byLeaf.has(p.split("/").pop()!)).length}`);
console.log(`accepted (price-confirmed): ${accepted.length}  (${fresh.length} new)`);
console.log(`quarantined              : ${quarantined.length}`);
console.log(`wrote ${OUT}`);
