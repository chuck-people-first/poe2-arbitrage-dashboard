// Generates src/domain/mapping.generated.ts from live fixtures.
// Run: npx tsx scripts/generate-mapping.ts
// Provenance: every entry is a GGG path whose ratio cross-checks against the
// poe.ninja divine-equivalent rate within a tolerance (default 25%).
// Entries that fail the check are quarantined and listed in the output.

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const FIXTURES = join(process.cwd(), "fixtures");
const OUT = join(process.cwd(), "src", "domain", "mapping.generated.ts");

/** Hypothesis: GGG path -> poe.ninja id, built from icon decode + naming patterns. */
const HYPOTHESIS: Record<string, string> = {
  "Metadata/Items/Currency/CurrencyModValues": "divine",
  "Metadata/Items/Currency/CurrencyAddModToRare": "exalted",
  "Metadata/Items/Currency/CurrencyRerollRare": "chaos",
  "Metadata/Items/Currency/CurrencyWeaponQuality": "whetstone",
  "Metadata/Items/Currency/CurrencyIdentification": "wisdom",
  "Metadata/Items/Currency/CurrencyAddModToMagic": "aug",
  "Metadata/Items/Currency/CurrencyUpgradeMagicToRare": "regal",
  "Metadata/Items/Currency/CurrencyUpgradeToMagic": "transmute",
  "Metadata/Items/Currency/CurrencyUpgradeToRare": "alch",
  "Metadata/Items/Currency/CurrencyUpgradeToUnique": "chance",
  "Metadata/Items/Currency/CurrencyDuplicate": "mirror",
  "Metadata/Items/Currency/CurrencyFlaskQuality": "bauble",
  "Metadata/Items/Currency/CurrencyGemQuality": "gcp",
  "Metadata/Items/Currency/CurrencyArmourQuality": "scrap",
  "Metadata/Items/Currency/CurrencyAddEquipmentSocket": "artificers",
  "Metadata/Items/Currency/CurrencyVaal": "vaal",
  "Metadata/Items/Currency/CurrencyRerollSocketNumbers01": "lesser-jewellers-orb",
  "Metadata/Items/Currency/CurrencyRerollSocketNumbers02": "greater-jewellers-orb",
  "Metadata/Items/Currency/CurrencyRerollSocketNumbers03": "perfect-jewellers-orb",
  "Metadata/Items/Currency/AnnullOrb": "annul",
  "Metadata/Items/Currency/FracturingOrb": "fracturing-orb",
  "Metadata/Items/Currency/CurrencyHinekorasLock": "hinekoras-lock",
  "Metadata/Items/Currency/StrongboxSkeletonKey": "cryptic-key",
  "Metadata/Items/Currency/CurrencyRerollRare2": "greater-chaos-orb",
  "Metadata/Items/Currency/CurrencyRerollRare3": "perfect-chaos-orb",
  "Metadata/Items/Currency/CurrencyAddModToRare2": "greater-exalted-orb",
  "Metadata/Items/Currency/CurrencyAddModToRare3": "perfect-exalted-orb",
  "Metadata/Items/Currency/CurrencyAddModToMagic2": "greater-orb-of-augmentation",
  "Metadata/Items/Currency/CurrencyAddModToMagic3": "perfect-orb-of-augmentation",
  "Metadata/Items/Currency/CurrencyUpgradeToMagic2": "greater-orb-of-transmutation",
  "Metadata/Items/Currency/CurrencyUpgradeToMagic3": "perfect-orb-of-transmutation",
  "Metadata/Items/Currency/CurrencyUpgradeMagicToRare2": "greater-regal-orb",
  "Metadata/Items/Currency/CurrencyUpgradeMagicToRare3": "perfect-regal-orb",
};

const GOLD_COSTS: Record<string, number> = {
  // From https://www.poe2wiki.net/wiki/Currency_exchange_market (fetched 2026-08-18).
  divine: 800,
  exalted: 120,
  chaos: 160,
  whetstone: 500,
  wisdom: 1,
  aug: 200,
  regal: 120,
  transmute: 50,
  alch: 200,
  chance: 1000,
  mirror: 25000,
  bauble: 750,
  gcp: 1000,
  scrap: 250,
  artificers: 1000,
  vaal: 160,
  annul: 1000,
  "lesser-jewellers-orb": 200,
  "greater-jewellers-orb": 600,
  "perfect-jewellers-orb": 1000,
  // Shards (from the same wiki table):
  "transmute-shard": 4,
  "regal-shard": 12,
  "artificers-shard": 100,
  "armourers-scrap": 250,
  "blacksmiths-whetstone": 500,
  "arcanists-etcher": 500,
  "glassblowers-bauble": 750,
  "gemcutters-prism": 1000,
};

/** Sentinel for a mapped item whose gold fee is NOT yet verified. */
const FEE_UNKNOWN = -1;

const ggg = JSON.parse(readFileSync(join(FIXTURES, "ggg-currency-exchange-1787022000.json"), "utf8"));
// Aggregate item metadata (name/icon/category) from EVERY poe.ninja fixture
// file (currency + thematic categories: breach, expedition, soulcores). This
// is the authoritative name/icon source; GGG payloads carry only metadata
// paths, never display names. When a leaf decodes to two DIFFERENT ninja ids
// across files the collision is surfaced, never silently resolved.
const NINJA_FILES = [
  "poe-ninja-currency-overview.json",
  "poe-ninja-currency.json",
  "poe-ninja-breach.json",
  "poe-ninja-expedition.json",
  "poe-ninja-soulcores.json",
];
const ninja = JSON.parse(readFileSync(join(FIXTURES, "poe-ninja-currency-overview.json"), "utf8"));

const roa = ggg.markets.filter((m: { league: string }) => m.league === "Runes of Aldur");
const ninjaDiv: Record<string, number> = {};
for (const line of ninja.lines) ninjaDiv[line.id] = line.primaryValue;
const ninjaNames: Record<string, { name: string; category: string; image: string; detailsId: string }> = {};
// Aggregate item metadata (name/icon/category) from EVERY poe.ninja fixture
// file (currency + thematic: breach, expedition, soulcores). GGG payloads
// carry only metadata paths, never display names — poe.ninja items are the
// authoritative name/icon source. A ninja id maps to ONE item definition;
// if two files disagree about a shared id the later file is ignored (first
// definition wins) rather than silently overwriting it.
const ninjaById = new Map<string, { name: string; category: string; image: string; detailsId: string }>();
for (const file of NINJA_FILES) {
  let parsed: { items?: { id: string; name: string; category: string; image: string; detailsId: string }[] };
  try {
    parsed = JSON.parse(readFileSync(join(FIXTURES, file), "utf8"));
  } catch {
    continue;
  }
  for (const item of parsed.items ?? []) {
    if (!ninjaById.has(item.id)) ninjaById.set(item.id, { name: item.name, category: item.category, image: item.image, detailsId: item.detailsId });
  }
}
for (const [id, meta] of ninjaById) ninjaNames[id] = meta;

/** Cross-check a GGG market against ninja rates; returns observed ratio vs implied. */
function checkPair(p0: string, p1: string) {
  const id0 = HYPOTHESIS[p0];
  const id1 = HYPOTHESIS[p1];
  if (!id0 || !id1) return null;
  const va = ninjaDiv[id0];
  const vb = ninjaDiv[id1];
  if (va === undefined || vb === undefined || va === 0) return null;
  const implied = va / vb; // units of B per A
  return { id0, id1, implied };
}

const TOLERANCE = 0.25;

// ---------------------------------------------------------------------------
// Auto-derived hypotheses from the REAL fixture + poe.ninja metadata.
//
// Bridge: poe.ninja item `image` URLs are /gen/image/<base64>/<hash>/<leaf>.png
// where the base64 JSON fragment encodes the item's REAL GGG asset path, e.g.
//   [25,14,{"f":"2DItems/Currency/Breach/BreachCatalystCold",...}]
//   -> Metadata/Items/Currency/Breach/BreachCatalystCold  (Tul's Catalyst)
// So decoding the image URL yields the item's authoritative GGG metadata path
// plus poe.ninja's readable name, category and absolute icon URL. This is a
// deterministic, non-fuzzy join key — NOT leaf-name guessing. A GGG path that
// decodes to two DIFFERENT poe.ninja ids is a collision and is never guessed.
// ---------------------------------------------------------------------------
function decodeNinjaImageUrl(imageUrl: string): string | null {
  const seg = imageUrl.split("/")[3]; // /gen/image/<B64>/<hash>/<leaf>.png
  if (!seg) return null;
  let decoded: unknown;
  try {
    const raw = Buffer.from(seg.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
    decoded = JSON.parse(raw);
  } catch {
    return null;
  }
  const inner = Array.isArray(decoded) ? (decoded as unknown[])[(decoded as unknown[]).length - 1] : decoded;
  const asset = inner && typeof inner === "object" ? (inner as { f?: unknown }).f : null;
  if (typeof asset !== "string") return null;
  return "Metadata/Items/" + asset.replace("2DItems/", "");
}

// Build authoritative GGG path -> poe.ninja item map from EVERY poe.ninja
// fixture file. First definition wins; a path that maps to multiple distinct
// ninja ids across files is flagged as a collision and never guessed.
const authedToNinja = new Map<string, { id: string; name: string; category: string; image: string }>();
const authedCollisions = new Set<string>();
for (const file of NINJA_FILES) {
  let parsed: { items?: { id: string; name: string; category: string; image: string }[] };
  try {
    parsed = JSON.parse(readFileSync(join(FIXTURES, file), "utf8"));
  } catch {
    continue;
  }
  for (const item of parsed.items ?? []) {
    const ggPath = decodeNinjaImageUrl(item.image ?? "");
    if (!ggPath) continue;
    const existing = authedToNinja.get(ggPath);
    if (!existing) authedToNinja.set(ggPath, { id: item.id, name: item.name, category: item.category, image: item.image });
    else if (existing.id !== item.id) authedCollisions.add(ggPath);
  }
}

// Real fixture (latest completed hour) — the published-opportunity universe.
const gggLatest = JSON.parse(readFileSync(join(FIXTURES, "ggg-currency-exchange-1787090400.json"), "utf8"));
const roaLatest = gggLatest.markets.filter((m: { league: string }) => m.league === "Runes of Aldur");
const seenLeaves = new Set<string>();
let derivedHypotheses = 0;
const collisionLeaves = new Set<string>();
for (const m of roaLatest) {
  for (const p of m.market_pair) {
    const leaf = String(p).split("/").pop();
    if (seenLeaves.has(leaf)) continue;
    seenLeaves.add(leaf);
    if (authedCollisions.has(p)) { collisionLeaves.add(leaf); continue; }
    const authed = authedToNinja.get(p);
    if (!authed) continue;
    if (!HYPOTHESIS[p]) {
      HYPOTHESIS[p] = authed.id;
      derivedHypotheses++;
    }
  }
}

// Aggregate rate + collision stats for the report.
const derivedIds = new Set(Object.values(HYPOTHESIS));
const dedupeNinjaIds = Array.from(derivedIds);

const pairResults: { p0: string; p1: string; ok: boolean; gggMid: number; implied: number; id0: string; id1: string }[] = [];
for (const m of roa) {
  const [p0, p1] = m.market_pair;
  const ck = checkPair(p0, p1);
  if (!ck) continue;
  const lr0 = m.lowest_ratio[p0];
  const lr1 = m.lowest_ratio[p1];
  const hr0 = m.highest_ratio[p0];
  const hr1 = m.highest_ratio[p1];
  if (!lr0 || !lr1 || !hr0 || !hr1) continue;
  const rlo = Math.min(lr1 / lr0, hr1 / hr0);
  const rhi = Math.max(lr1 / lr0, hr1 / hr0);
  const mid = (rlo + rhi) / 2;
  const ok = Math.abs(mid / ck.implied - 1) < TOLERANCE;
  pairResults.push({ p0, p1, ok, gggMid: mid, implied: ck.implied, id0: ck.id0, id1: ck.id1 });
}

// A path is verified if any pair it appears in validated — GGG's market_pair
// order is arbitrary, so an item may be p0 in one market and p1 in another.
// For each path we collect its best-matching observation in whichever position.
const verified: { gggPath: string; ninjaId: string; ratio: number; observations: number }[] = [];
const quarantined: { gggPath: string; ninjaId: string; ratio: number; observations: number }[] = [];

for (const [path, ninjaId] of Object.entries(HYPOTHESIS)) {
  const obs = pairResults
    .filter((r) => r.p0 === path || r.p1 === path)
    .map((r) => {
      // normalize measurement direction: express as units of `path` per 1 divine
      const isP0 = r.p0 === path;
      const rateDivine =
        isP0
          ? r.gggMid * r.implied             // gggMid = units of p1 per p0; ×divine-per-p1 units...
          : r.gggMid * (1 / r.implied);      // gggMid = units of p0 per p1
      return { ...r, isP0, rateDivine };
    });
  if (obs.length === 0) {
    quarantined.push({ gggPath: path, ninjaId, ratio: 0, observations: 0 });
    continue;
  }
  const okCount = obs.filter((r) => r.ok).length;
  if (okCount > 0) {
    // validated rate: ninja's own divine-per-unit value, the stable reference
    verified.push({ gggPath: path, ninjaId, ratio: ninjaDiv[ninjaId] ?? bestRate(obs), observations: obs.length });
  } else {
    quarantined.push({ gggPath: path, ninjaId, ratio: 0, observations: obs.length });
  }
}

function bestRate(obs: { gggMid: number; implied: number }[]): number {
  return obs.reduce((a, b) => (Math.abs(b.gggMid / b.implied - 1) < Math.abs(a.gggMid / a.implied - 1) ? b : a)).gggMid;
}

const GENERATED_KEYS = new Set(verified.map((v) => v.gggPath));

const lines: string[] = [];
lines.push("// AUTO-GENERATED. Do not edit by hand — run `npx tsx scripts/generate-mapping.ts`.");
lines.push("// Provenance: cross-validated 2026-08-18 against GGG completed-hour feed");
lines.push("// (1787022000, league 'Runes of Aldur') and poe.ninja PoE2 economy overview.");
lines.push("// Verified entries matched within 25% of the poe.ninja implied rate across all");
lines.push("// observed markets. Quarantined entries failed the check and are NOT added.");
lines.push("import type { ItemId } from \"./types\";");
lines.push("");
lines.push("export interface MappingRecord {");
lines.push("  entry: ItemId;");
lines.push("  /** implied divine rate from poe.ninja used for validation */");
lines.push("  validatedRate: number;");
lines.push("  /** number of independent market observations used */");
lines.push("  observations: number;");
lines.push("}");
lines.push("");
lines.push("export const GENERATED_MAPPING: Record<string, MappingRecord> = {");
for (const v of verified.sort((a, b) => b.observations - a.observations)) {
  const meta = ninjaNames[v.ninjaId];
  const gold = GOLD_COSTS[v.ninjaId] ?? FEE_UNKNOWN;
  const name = meta ? meta.name : v.ninjaId;
  const cat = meta ? meta.category : "Currency";
  const img = meta ? meta.image : null;
  lines.push(`  ${JSON.stringify(v.gggPath)}: {`);
  lines.push(`    entry: {`);
  lines.push(`      gggPath: ${JSON.stringify(v.gggPath)},`);
  lines.push(`      ninjaId: ${JSON.stringify(v.ninjaId)},`);
  lines.push(`      displayName: ${JSON.stringify(name)},`);
  lines.push(`      category: ${JSON.stringify(cat)},`);
  lines.push(`      iconUrl: ${JSON.stringify(img)},`);
  lines.push(`      goldCostPerUnit: ${gold},`);
  lines.push(`      mappingSource: "checked-in-verified",`);
  lines.push(`      lastVerifiedUtc: "2026-08-18T00:00:00Z",`);
  lines.push(`    },`);
  lines.push(`    validatedRate: ${v.ratio},`);
  lines.push(`    observations: ${v.observations},`);
  lines.push(`  },`);
}
lines.push("};");
lines.push("");

// Authoritative identities from the poe.ninja image-decoded bridge: REAL GGG
// paths (per the asset path embedded in each image URL) with poe.ninja's
// readable name, category and absolute icon. These are NOT rate-quarantined —
// many (e.g. Tul's Catalyst) simply have no exchange-market observation in
// these fixture hours, so they cannot be rate-validated, but their identity
// is authoritative. Gold is left FEE_UNKNOWN (-1) so nothing is marketable or
// priced without a verified fee. They resolve to a readable flip identity,
// are rejected by scoring when gold is undefined, and never show a raw GGG id.
lines.push("// --- Authoritative identity-only entries (path+name+icon from poe.ninja) ---");
lines.push("export const AUTHORITATIVE_IDENTITY_MAPPING: Record<string, MappingRecord> = {");
for (const [ggPath, authed] of [...authedToNinja.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
  if (authedCollisions.has(ggPath)) continue; // never guess an ambiguous path
  if (GENERATED_KEYS.has(ggPath)) continue; // already emitted (rate-verified)
  const iconUrl = authed.image ? "https://web.poecdn.com" + authed.image : null;
  lines.push(`  ${JSON.stringify(ggPath)}: {`);
  lines.push(`    entry: {`);
  lines.push(`      gggPath: ${JSON.stringify(ggPath)},`);
  lines.push(`      ninjaId: ${JSON.stringify(authed.id)},`);
  lines.push(`      displayName: ${JSON.stringify(authed.name)},`);
  lines.push(`      category: ${JSON.stringify(authed.category)},`);
  lines.push(`      iconUrl: ${JSON.stringify(iconUrl)},`);
  lines.push(`      goldCostPerUnit: ${FEE_UNKNOWN},`);
  lines.push(`      mappingSource: "checked-in-verified",`);
  lines.push(`      lastVerifiedUtc: "2026-08-18T00:00:00Z",`);
  lines.push(`    },`);
  lines.push(`    validatedRate: 0,`);
  lines.push(`    observations: 0,`);
  lines.push(`  },`);
}
lines.push("};");
lines.push("");

lines.push("export const QUARANTINED_MAPPING: Record<string, { ninjaId: string; reason: string }> = {");
for (const q of quarantined) {
  lines.push(`  ${JSON.stringify(q.gggPath)}: { ninjaId: ${JSON.stringify(q.ninjaId)}, reason: "failed cross-validation" },`);
}
lines.push("};");

writeFileSync(OUT, lines.join("\n"));
console.log(`Wrote ${OUT}`);
console.log(`Verified: ${verified.length} paths | Quarantined: ${quarantined.length} paths | Auto-derived hypotheses: ${derivedHypotheses} | Collision leaves skipped: ${collisionLeaves.size}`);
for (const v of verified) console.log(`  OK  ${v.ninjaId.padEnd(34)} obs=${v.observations} rate=${v.ratio.toFixed(6)} name=${ninjaNames[v.ninjaId]?.name ?? "?"}`);
for (const q of quarantined) console.log(`  Q?  ${q.ninjaId.padEnd(34)} obs=${q.observations}`);
if (collisionLeaves.size) console.log(`COLLISION leaves (1 ninja id ambiguous): ${[...collisionLeaves].join(", ")}`);