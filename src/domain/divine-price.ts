// Divine-equivalent price for every path traded in one completed GGG hour.
//
// The scanner needs a common yardstick to compare an item's GGG price against
// an independent source. Divine is that yardstick: poe.ninja quotes in it and
// it is the deepest hub.
//
// WHERE THE ITEM TRADED MOST DECIDES, NOT HOP COUNT. An item usually trades
// against several hubs in the same hour and those markets disagree wildly.
// Blacksmith's Whetstone on 2026-08-21T01:00Z: 4.00e-3 Divine through its
// direct Divine market, 2.99e-3 through Chaos, 9.12e-4 through Exalted — a 4x
// spread, where only the Exalted figure is corroborated independently. The
// direct market moved just 10 Divine against 2500 whetstones, so a 250:1 ratio
// rests on ten discrete units and a single trade distorts the midpoint.
//
// Six candidate rules were benchmarked against poe.ninja across the 41 items
// both sources price (scripts/rule-scratch equivalent, pinned in
// test/divine-price.test.ts). Selecting the market where the ITEM ITSELF traded
// the most units wins on every measure:
//
//   rule               mean |dev|   <=10%   <=25%   >60%
//   direct-preferred      18.5%      25      32      4
//   depth-in-divine       17.2%      26      31      2
//   scarcer-side count    18.8%      25      26      2
//   item volume           14.4%      27      32      1   <- chosen
//   median of all         19.3%      21      28      2
//   exalted-first         19.3%      22      26      2
//
// Intuitively: price is best discovered where the thing actually changed hands.
// Note that valuing depth in Divine picks the thin market back up, because ten
// Divine outvalue seven hundred Exalted.
//
// The disagreement is not discarded: `spreadPct` reports how far apart the
// candidates were, which is a real warning about that hour's data quality.
//
// Every rate here is the hour's MIDPOINT. This module answers "what is this
// worth", not "what can I execute" — sizing and executability are decided
// elsewhere, from the conservative boundary.

import { GGG_HUB_PATHS } from "./mapping.ts";
import type { DirectedEdge } from "./types.ts";

export type PriceBasis = "identity" | "direct" | "via-exalted" | "via-chaos";

export interface DivinePriceEntry {
  /** Divine per 1 unit of the item. */
  divine: number;
  basis: PriceBasis;
  /** Units of the item itself traded in the chosen market. */
  itemVolume: number;
  /** Relative spread across every candidate market, as a percentage. */
  spreadPct: number;
  /** How many independent markets offered a price. */
  candidates: number;
}

export interface DivinePriceBook {
  entries: Map<string, DivinePriceEntry>;
  /** Divine per 1 unit — kept as a plain map for hot lookups. */
  perUnit: Map<string, number>;
  exaltedPerDivine: number | null;
  chaosPerDivine: number | null;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

interface Candidate { divine: number; basis: PriceBasis; itemVolume: number }

export function buildDivinePriceBook(edges: DirectedEdge[]): DivinePriceBook {
  const { DIVINE, EXALTED, CHAOS } = GGG_HUB_PATHS;

  // Pass 1: hub prices in Divine, taken from the hub's own direct market.
  const hubDirect = new Map<string, number[]>();
  for (const edge of edges) {
    if (edge.to === DIVINE && edge.rate > 0) {
      hubDirect.set(edge.from, [...(hubDirect.get(edge.from) ?? []), edge.rate]);
    }
  }
  const hubDivine = new Map<string, number>([[DIVINE, 1]]);
  for (const hub of [EXALTED, CHAOS]) {
    const rates = hubDirect.get(hub);
    if (rates?.length) hubDivine.set(hub, median(rates));
  }

  // Pass 2: every candidate price for every path, with its depth in Divine.
  const candidates = new Map<string, Candidate[]>();
  const add = (path: string, candidate: Candidate) => {
    if (!(candidate.divine > 0) || !Number.isFinite(candidate.divine)) return;
    candidates.set(path, [...(candidates.get(path) ?? []), candidate]);
  };

  for (const edge of edges) {
    if (!(edge.rate > 0) || edge.from === DIVINE) continue;
    const hubPrice = hubDivine.get(edge.to);
    if (hubPrice === undefined) continue;
    const basis: PriceBasis = edge.to === DIVINE ? "direct" : edge.to === EXALTED ? "via-exalted" : "via-chaos";
    // volumeFrom is the item's own traded units in this market.
    add(edge.from, { divine: edge.rate * hubPrice, basis, itemVolume: edge.volumeFrom });
  }

  const entries = new Map<string, DivinePriceEntry>();
  const perUnit = new Map<string, number>();
  entries.set(DIVINE, { divine: 1, basis: "identity", itemVolume: Number.POSITIVE_INFINITY, spreadPct: 0, candidates: 1 });
  perUnit.set(DIVINE, 1);

  for (const [path, list] of candidates) {
    if (path === DIVINE) continue;
    // Collapse repeat markets for the same basis first, so one duplicated thin
    // market cannot outvote a genuinely deep one.
    const byBasis = new Map<PriceBasis, Candidate[]>();
    for (const candidate of list) byBasis.set(candidate.basis, [...(byBasis.get(candidate.basis) ?? []), candidate]);
    const collapsed: Candidate[] = [...byBasis.entries()].map(([basis, group]) => ({
      basis,
      divine: median(group.map((c) => c.divine)),
      itemVolume: group.reduce((sum, c) => sum + c.itemVolume, 0),
    }));
    const best = collapsed.reduce((a, b) => (b.itemVolume > a.itemVolume ? b : a));
    const prices = collapsed.map((c) => c.divine);
    const spreadPct = prices.length > 1
      ? (Math.max(...prices) - Math.min(...prices)) / Math.max(...prices) * 100
      : 0;
    entries.set(path, {
      divine: best.divine, basis: best.basis, itemVolume: best.itemVolume,
      spreadPct, candidates: collapsed.length,
    });
    perUnit.set(path, best.divine);
  }

  const exalted = perUnit.get(EXALTED);
  const chaos = perUnit.get(CHAOS);
  return {
    entries, perUnit,
    exaltedPerDivine: exalted && exalted > 0 ? 1 / exalted : null,
    chaosPerDivine: chaos && chaos > 0 ? 1 / chaos : null,
  };
}
