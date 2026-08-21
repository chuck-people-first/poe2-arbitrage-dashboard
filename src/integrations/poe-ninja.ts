// poe.ninja PoE2 economy exchange — the second, independent price source.
//
// WHY A SECOND SOURCE. The official GGG feed publishes completed-hour
// aggregates: a low and a high ratio per market, and nothing about the live
// book. It is authoritative for what traded, but a single hour's boundary on a
// thin market can be far from the going rate. poe.ninja observes the same
// economy independently and publishes a per-item Divine price plus a short
// history. Where the two agree, confidence is high; where they diverge, that
// divergence is itself the signal — and it is shown rather than averaged away.
//
// WHAT THIS MODULE DOES NOT DO. It never renames a GGG item. Identity comes
// from the checked-in mapping; this module only supplies prices, volume and
// trend for items already identified. Price similarity is far too weak to
// establish identity (measured: 25-44% accuracy against a known holdout), so
// it is used only to *validate* an identity established structurally.
//
// Runtime: plain fetch + JSON. Runs unchanged in Node tests and Deno (Edge).

/** Categories the exchange endpoint serves. Probed 2026-08-21; 532 priced lines. */
export const NINJA_CATEGORIES = [
  "Currency", "Essences", "Runes", "UncutGems", "Idols", "Ritual",
  "Fragments", "Breach", "SoulCores", "Delirium", "Expedition", "Abyss",
] as const;

export type NinjaCategory = typeof NINJA_CATEGORIES[number];

const BASE = "https://poe.ninja/poe2/api/economy/exchange/current/overview";

/** Raw shape of one priced line in the overview response. */
interface RawLine {
  id: string;
  primaryValue?: number;
  volumePrimaryValue?: number;
  maxVolumeCurrency?: string;
  maxVolumeRate?: number;
  sparkline?: { totalChange?: number; data?: number[] };
}

interface RawItem { id: string; name: string; image?: string; category?: string; detailsId?: string }

export interface RawOverview {
  core?: { items?: RawItem[]; rates?: Record<string, number>; primary?: string; secondary?: string };
  lines?: RawLine[];
  items?: RawItem[];
}

/** One normalized poe.ninja observation. */
export interface NinjaQuote {
  ninjaId: string;
  name: string;
  category: NinjaCategory;
  /** Art file leaf decoded from the CDN image, e.g. "CurrencyModValues". The
   *  structural join key to a GGG metadata path — same art file, same item. */
  artLeaf: string | null;
  /** Full decoded art path, retained for auditing an ambiguous leaf. */
  artPath: string | null;
  iconUrl: string | null;
  /** Price in the response's primary currency (Divine). */
  divinePrice: number;
  /** The currency this item trades most volume against, and that rate. */
  deepestCurrency: string | null;
  deepestRate: number | null;
  /** poe.ninja's own short history: 7 points plus a net change percentage. */
  sparkline: number[];
  totalChangePct: number | null;
}

export interface NinjaSnapshot {
  league: string;
  fetchedAtUtc: string;
  /** Hub rates in units per 1 Divine, e.g. { exalted: 367.1, chaos: 11.04 }. */
  hubRatesPerDivine: Record<string, number>;
  quotes: NinjaQuote[];
  /** Categories that failed to load; the snapshot stays usable without them. */
  failedCategories: NinjaCategory[];
}

const IMAGE_RE = /\/gen\/image\/([^/]+)\//;

/** Decode the poecdn image token to the item's art path. Pure, no network. */
export function decodeArtPath(image: string | undefined | null): string | null {
  const match = IMAGE_RE.exec(image ?? "");
  if (!match) return null;
  const raw = match[1]!.replace(/-/g, "+").replace(/_/g, "/");
  const padded = raw + "=".repeat((4 - (raw.length % 4)) % 4);
  try {
    const json = typeof atob === "function"
      ? atob(padded)
      : Buffer.from(padded, "base64").toString("binary");
    const decoded = JSON.parse(json) as unknown;
    if (!Array.isArray(decoded)) return null;
    const meta = decoded.find((part): part is { f: string } =>
      typeof part === "object" && part !== null && typeof (part as { f?: unknown }).f === "string");
    return meta?.f ?? null;
  } catch {
    return null;
  }
}

/** Normalize one category payload. Unpriced or unnamed lines are dropped. */
export function normalizeOverview(raw: RawOverview, category: NinjaCategory): NinjaQuote[] {
  const meta = new Map<string, RawItem>();
  for (const item of [...(raw.items ?? []), ...(raw.core?.items ?? [])]) meta.set(item.id, item);
  const quotes: NinjaQuote[] = [];
  for (const line of raw.lines ?? []) {
    const item = meta.get(line.id);
    const price = line.primaryValue;
    if (!item?.name || typeof price !== "number" || !(price > 0)) continue;
    const artPath = decodeArtPath(item.image);
    quotes.push({
      ninjaId: line.id,
      name: item.name,
      category,
      artPath,
      artLeaf: artPath ? artPath.split("/").pop() ?? null : null,
      iconUrl: item.image ? `https://web.poecdn.com${item.image}` : null,
      divinePrice: price,
      deepestCurrency: line.maxVolumeCurrency ?? null,
      deepestRate: typeof line.maxVolumeRate === "number" ? line.maxVolumeRate : null,
      sparkline: (line.sparkline?.data ?? []).filter((n): n is number => typeof n === "number"),
      totalChangePct: typeof line.sparkline?.totalChange === "number" ? line.sparkline.totalChange : null,
    });
  }
  return quotes;
}

/** Merge per-category payloads into one snapshot. Pure — used by tests on fixtures. */
export function buildSnapshot(
  league: string,
  payloads: Array<{ category: NinjaCategory; raw: RawOverview }>,
  fetchedAtUtc: string,
  failedCategories: NinjaCategory[] = [],
): NinjaSnapshot {
  const quotes: NinjaQuote[] = [];
  const hubRatesPerDivine: Record<string, number> = {};
  for (const { category, raw } of payloads) {
    quotes.push(...normalizeOverview(raw, category));
    // Every category echoes the same hub rates; first non-empty wins and the
    // rest must agree, so a partial fetch still yields usable hub rates.
    for (const [currency, rate] of Object.entries(raw.core?.rates ?? {})) {
      if (typeof rate === "number" && rate > 0 && hubRatesPerDivine[currency] === undefined) {
        hubRatesPerDivine[currency] = rate;
      }
    }
  }
  // One id can appear in several categories; keep the first, they carry the
  // same price.
  const seen = new Set<string>();
  const unique = quotes.filter((quote) => !seen.has(quote.ninjaId) && seen.add(quote.ninjaId));
  return { league, fetchedAtUtc, hubRatesPerDivine, quotes: unique, failedCategories };
}

/**
 * Fetch every category. A category that fails is recorded and skipped rather
 * than failing the run: the scanner must still publish from GGG alone, and a
 * partial second opinion is better than none.
 */
export async function fetchNinjaSnapshot(
  league: string,
  options: { fetchImpl?: typeof fetch; timeoutMs?: number; now?: () => Date } = {},
): Promise<NinjaSnapshot> {
  const doFetch = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 15_000;
  const payloads: Array<{ category: NinjaCategory; raw: RawOverview }> = [];
  const failed: NinjaCategory[] = [];
  const results = await Promise.all(NINJA_CATEGORIES.map(async (category) => {
    const url = `${BASE}?type=${encodeURIComponent(category)}&league=${encodeURIComponent(league)}`;
    try {
      const response = await doFetch(url, {
        headers: { accept: "application/json", "user-agent": "poe2-arbitrage-dashboard/0.1" },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return { category, raw: await response.json() as RawOverview };
    } catch {
      return { category, raw: null };
    }
  }));
  for (const result of results) {
    if (result.raw) payloads.push({ category: result.category, raw: result.raw });
    else failed.push(result.category);
  }
  const now = (options.now ?? (() => new Date()))();
  return buildSnapshot(league, payloads, now.toISOString(), failed);
}
