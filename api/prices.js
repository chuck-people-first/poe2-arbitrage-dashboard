// Vercel serverless function: one flat poe.ninja price book for the Tools page.
//
// poe.ninja sends no CORS headers, so the browser cannot read it directly.
// This proxies the same 12 exchange categories the ingest uses
// (src/integrations/poe-ninja.ts) and flattens them to name -> Divine price.
// The CDN caches each league for 15 minutes; a failed category is reported,
// never fatal.

const BASE = "https://poe.ninja/poe2/api/economy/exchange/current/overview";
const CATEGORIES = [
  "Currency", "Essences", "Runes", "UncutGems", "Idols", "Ritual",
  "Fragments", "Breach", "SoulCores", "Delirium", "Expedition", "Abyss",
];
const DEFAULT_LEAGUE = "Runes of Aldur";

export function flatten(league, payloads, fetchedAtUtc, failedCategories = []) {
  const items = [];
  const seen = new Set();
  const hubRatesPerDivine = {};
  for (const { category, raw } of payloads) {
    const meta = new Map();
    for (const item of [...(raw.items ?? []), ...(raw.core?.items ?? [])]) meta.set(item.id, item);
    for (const [currency, rate] of Object.entries(raw.core?.rates ?? {})) {
      if (typeof rate === "number" && rate > 0 && hubRatesPerDivine[currency] === undefined) hubRatesPerDivine[currency] = rate;
    }
    for (const line of raw.lines ?? []) {
      const item = meta.get(line.id);
      const price = line.primaryValue;
      if (!item?.name || typeof price !== "number" || !(price > 0) || seen.has(line.id)) continue;
      seen.add(line.id);
      items.push({
        id: line.id,
        name: item.name,
        category,
        divine: price,
        volumeDivine: typeof line.volumePrimaryValue === "number" ? line.volumePrimaryValue : null,
        icon: item.image ? `https://web.poecdn.com${item.image}` : null,
        changePct: typeof line.sparkline?.totalChange === "number" ? line.sparkline.totalChange : null,
        sparkline: (line.sparkline?.data ?? []).filter((n) => typeof n === "number"),
      });
    }
  }
  return { league, fetchedAtUtc, source: "poe.ninja", hubRatesPerDivine, items, failedCategories };
}

export default async function handler(req, res) {
  const league = String(req.query?.league || DEFAULT_LEAGUE).slice(0, 80);
  const payloads = [];
  const failed = [];
  await Promise.all(CATEGORIES.map(async (category) => {
    const url = `${BASE}?league=${encodeURIComponent(league)}&type=${category}`;
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(8000), headers: { accept: "application/json" } });
      if (!response.ok) throw new Error(String(response.status));
      payloads.push({ category, raw: await response.json() });
    } catch {
      failed.push(category);
    }
  }));
  // Keep category order stable regardless of which fetch finished first.
  payloads.sort((a, b) => CATEGORIES.indexOf(a.category) - CATEGORIES.indexOf(b.category));
  const book = flatten(league, payloads, new Date().toISOString(), failed);
  if (!book.items.length) {
    res.status(502).json({ error: "poe.ninja returned no prices", league, failedCategories: failed });
    return;
  }
  res.setHeader("Cache-Control", "public, s-maxage=900, stale-while-revalidate=3600");
  res.status(200).json(book);
}
