// Generates fixtures/poe2db/currency-exchange-fees.json and
// src/domain/fees.generated.ts — the Currency Exchange gold fee for every
// tradeable item, keyed by GGG metadata path.
//
// Why this is a READ, not an inference:
//   The gold fee is not a market quantity. It is a static per-item constant
//   that ships in the game's own data (the Currency Exchange table), and the
//   in-game cost of an order is that constant multiplied by the number of
//   units received on the "I want" side. poe2db publishes the table verbatim:
//   the exchange index lists every tradeable item with its fee, and each
//   item's own page carries its `Metadata/Items/...` path. Identity and fee
//   therefore arrive together off the same page — no name matching, no price
//   similarity, nothing guessed.
//
//   Two independent player observations corroborate the multiplication rule:
//   an 80k gold fee quoted for buying ~660 Exalted Orbs (660 x 120 = 79,200)
//   and 39k for one Divine's worth of Exalted at a ~325:1 rate
//   (325 x 120 = 39,000).
//
// Run: npx tsx scripts/generate-exchange-fees.ts          (uses the fixture)
//      npx tsx scripts/generate-exchange-fees.ts --refetch (re-scrapes poe2db)
//
// --refetch issues ~670 requests at 3 concurrent. Be polite; the table only
// changes when GGG ships a patch that adds or reprices exchangeable items.

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURE = join(ROOT, "fixtures/poe2db/currency-exchange-fees.json");
const GGG_FIXTURES = join(ROOT, "fixtures");
const OUTPUT = join(ROOT, "src/domain/fees.generated.ts");
const INDEX_URL = "https://poe2db.tw/us/Currency_Exchange";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

export interface FeeEntry {
  gggPath: string;
  displayName: string;
  goldCostPerUnit: number;
  section: string;
  art: string;
  slug: string;
}

interface FeeFixture {
  source: string;
  realm: string;
  capturedUtc: string;
  entries: FeeEntry[];
}

async function get(url: string): Promise<string> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const res = await fetch(url, { headers: { "user-agent": UA } });
      if (res.ok) return await res.text();
    } catch {
      /* retried below */
    }
    await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
  }
  throw new Error(`could not fetch ${url}`);
}

/** One row of the exchange index: art file, item page slug, name, gold fee. */
const ROW =
  /<img loading="lazy" src="https:\/\/cdn\.poe2db\.tw\/image\/(Art\/[^"]+)\.webp" alt="[^"]*"[^>]*\/><\/a><\/div>.*?href="([^"]+)">([^<]+)<\/a><span>(\d+)<\/span>/gs;

/**
 * Paths the GGG exchange feed has actually quoted, read off the checked-in
 * hours. Used only to disambiguate an item page that names more than one
 * metadata path — e.g. the Ancient Crisis Fragment page carries both
 * `Pinnacle/BurningMonolithKey1` and `Pinnacle/PinnacleKey1`, and only the
 * first is the one the exchange trades.
 */
function pathsTheFeedTrades(): Set<string> {
  const traded = new Set<string>();
  for (const file of readdirSync(GGG_FIXTURES)) {
    if (!file.startsWith("ggg-currency-exchange-")) continue;
    const raw = JSON.parse(readFileSync(join(GGG_FIXTURES, file), "utf8")) as {
      markets: { market_pair: [string, string] }[];
    };
    for (const market of raw.markets) for (const path of market.market_pair) traded.add(path);
  }
  return traded;
}

/**
 * The metadata path for one item page. Quest-item variants share a page with
 * the real item and are never the exchange entry; where a genuine ambiguity
 * remains, the path the feed quotes wins, and failing that the choice is
 * lexicographic so regeneration is reproducible.
 */
function resolvePath(page: string, traded: Set<string>): string | null {
  // The quest filter matches a path SEGMENT that begins with "Quest"
  // (Metadata/Items/Quest/..., Metadata/Items/QuestItems/...). A looser
  // case-insensitive search for "quest" anywhere silently eats real items:
  // "CurrencyVerisiumOreUniqueStolvarheim" contains "queSt".
  const candidates = [...new Set(page.match(/Metadata\/Items\/[A-Za-z0-9/_]+/g) ?? [])]
    .filter((path) => !/\/Quest/.test(path))
    .sort();
  if (candidates.length <= 1) return candidates[0] ?? null;
  return candidates.find((path) => traded.has(path)) ?? candidates[0];
}

async function refetch(): Promise<FeeFixture> {
  const index = await get(INDEX_URL);
  const sections = [...index.matchAll(/<h5[^>]*>(.*?)<\/h5>/gs)].map(
    (m) => [m.index ?? 0, m[1].replace(/<[^>]+>/g, "").trim()] as const,
  );
  const sectionAt = (pos: number) => {
    let current = "";
    for (const [at, name] of sections) {
      if (at < pos) current = name;
      else break;
    }
    return current;
  };

  const rows = [...index.matchAll(ROW)].map((m) => ({
    art: m[1],
    slug: m[2].replace(/^\/?(us\/)?/, ""),
    displayName: m[3],
    goldCostPerUnit: Number(m[4]),
    section: sectionAt(m.index ?? 0),
  }));
  if (rows.length < 500) throw new Error(`exchange index parsed only ${rows.length} rows`);

  const traded = pathsTheFeedTrades();
  const entries: FeeEntry[] = [];
  const queue = [...rows];
  const retry: typeof rows = [];
  const workers = Array.from({ length: 3 }, async () => {
    for (let row = queue.shift(); row; row = queue.shift()) {
      const gggPath = resolvePath(await get(`https://poe2db.tw/us/${row.slug}`), traded);
      if (gggPath) entries.push({ gggPath, ...row });
      else retry.push(row);
    }
  });
  await Promise.all(workers);

  // Under concurrency poe2db sometimes answers 200 with a page carrying no
  // item data — indistinguishable from success by status code. The same page
  // fetched on its own comes back complete, so anything that came up empty is
  // retried serially rather than believed.
  const unresolved: string[] = [];
  for (const row of retry) {
    let gggPath: string | null = null;
    for (let attempt = 0; attempt < 4 && gggPath === null; attempt += 1) {
      await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
      gggPath = resolvePath(await get(`https://poe2db.tw/us/${row.slug}`), traded);
    }
    if (gggPath) entries.push({ gggPath, ...row });
    else unresolved.push(row.slug);
  }

  // A page that still has no metadata path is a fetch that went wrong, not an
  // item without one. Dropping it silently would quietly remove a fee and turn
  // a priced route into an unpriceable one, so fail instead.
  if (unresolved.length > 0) {
    throw new Error(`no metadata path on ${unresolved.length} page(s): ${unresolved.join(", ")}`);
  }

  const seen = new Set<string>();
  const unique = entries
    .filter((e) => (seen.has(e.gggPath) ? false : (seen.add(e.gggPath), true)))
    .sort((a, b) => a.gggPath.localeCompare(b.gggPath));
  if (unique.length !== rows.length) {
    throw new Error(`${rows.length} exchange rows collapsed to ${unique.length} distinct paths`);
  }

  return {
    source: INDEX_URL,
    realm: "us",
    capturedUtc: new Date().toISOString(),
    entries: unique,
  };
}

function emit(fixture: FeeFixture): string {
  const lines = fixture.entries.map(
    (e) =>
      `  ${JSON.stringify(e.gggPath)}: { displayName: ${JSON.stringify(e.displayName)}, ` +
      `goldCostPerUnit: ${e.goldCostPerUnit}, section: ${JSON.stringify(e.section)} },`,
  );
  return `// GENERATED by scripts/generate-exchange-fees.ts — do not edit by hand.
// Source: ${fixture.source} (realm ${fixture.realm}), captured ${fixture.capturedUtc}.
//
// The Currency Exchange gold fee is a static per-item constant from the game's
// own data, NOT a market observation and NOT an estimate. The gold an order
// costs is this constant times the number of units received on the "I want"
// side. Both the fee and the GGG metadata path are read off the same poe2db
// page, so identity here is structural rather than inferred.
//
// ${fixture.entries.length} entries.

export interface ExchangeFee {
  displayName: string;
  /** gold per unit received on the "I want" side */
  goldCostPerUnit: number;
  /** the Currency Exchange tab the item appears under */
  section: string;
}

export const EXCHANGE_FEES: Record<string, ExchangeFee> = {
${lines.join("\n")}
};
`;
}

const shouldRefetch = process.argv.includes("--refetch");
const fixture: FeeFixture = shouldRefetch
  ? await refetch()
  : (JSON.parse(readFileSync(FIXTURE, "utf8")) as FeeFixture);

if (shouldRefetch) {
  writeFileSync(FIXTURE, `${JSON.stringify(fixture, null, 1)}\n`);
  console.log(`wrote ${FIXTURE} (${fixture.entries.length} entries)`);
}
writeFileSync(OUTPUT, emit(fixture));
console.log(`wrote ${OUTPUT} (${fixture.entries.length} entries)`);
