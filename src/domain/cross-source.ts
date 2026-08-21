// Cross-source price reconciliation: GGG completed-hour vs poe.ninja.
//
// The two sources see the same economy through different instruments. GGG
// publishes what actually traded in one completed hour, as a low/high ratio
// band. poe.ninja publishes a smoothed per-item Divine price with a short
// history. Neither is "the" price.
//
// The product does NOT average them. Averaging hides the one thing worth
// knowing: whether the hour you are about to trade on looks like the rest of
// the economy. So both numbers are carried side by side, with their deviation
// and a plain confidence label, and the player decides.
//
// A missing second opinion is never treated as agreement.

import { GGG_HUB_PATHS } from "./mapping.ts";
import type { NinjaQuote, NinjaSnapshot } from "../integrations/poe-ninja.ts";

/** How well the two independent sources agree on one price. */
export type SourceAgreement = "confirmed" | "close" | "diverging" | "conflicting" | "single-source";

export interface CrossSourcePrice {
  /** Divine-equivalent price implied by the GGG completed hour. */
  gggDivine: number | null;
  /** Divine price published by poe.ninja for the same item. */
  ninjaDivine: number | null;
  /** |a-b| / max(a,b) as a percentage; null when only one source has a price. */
  deviationPct: number | null;
  agreement: SourceAgreement;
  /** poe.ninja's short-history net change, when available. */
  ninjaTrendPct: number | null;
  ninjaSparkline: number[];
  /** Which sources contributed, for display and for audit. */
  sources: Array<"ggg-completed-hour" | "poe-ninja">;
}

/**
 * Deviation bands. These are deliberately wide: the two instruments measure
 * different things (one completed hour vs a smoothed recent price), so a
 * modest gap is normal and only a large one is informative.
 */
const CONFIRMED_PCT = 10;
const CLOSE_PCT = 25;
const DIVERGING_PCT = 60;

export function classifyAgreement(deviationPct: number | null): SourceAgreement {
  if (deviationPct === null || !Number.isFinite(deviationPct)) return "single-source";
  if (deviationPct <= CONFIRMED_PCT) return "confirmed";
  if (deviationPct <= CLOSE_PCT) return "close";
  if (deviationPct <= DIVERGING_PCT) return "diverging";
  return "conflicting";
}

export const AGREEMENT_LABELS: Record<SourceAgreement, string> = {
  confirmed: "Both sources agree",
  close: "Sources close",
  diverging: "Sources diverge",
  conflicting: "Sources conflict",
  "single-source": "GGG only",
};

/** Relative gap between two positive prices, as a percentage of the larger. */
export function deviationPct(a: number | null, b: number | null): number | null {
  if (a === null || b === null || !(a > 0) || !(b > 0)) return null;
  return Math.abs(a - b) / Math.max(a, b) * 100;
}

/** Index a snapshot by the GGG path each quote has been mapped to. */
export function indexByGggPath(
  snapshot: NinjaSnapshot | null,
  resolve: (quote: NinjaQuote) => string | null,
): Map<string, NinjaQuote> {
  const index = new Map<string, NinjaQuote>();
  if (!snapshot) return index;
  for (const quote of snapshot.quotes) {
    const path = resolve(quote);
    if (path && !index.has(path)) index.set(path, quote);
  }
  return index;
}

export function crossSourcePrice(
  gggDivine: number | null,
  quote: NinjaQuote | null | undefined,
): CrossSourcePrice {
  const ninjaDivine = quote?.divinePrice ?? null;
  const deviation = deviationPct(gggDivine, ninjaDivine);
  const sources: CrossSourcePrice["sources"] = [];
  if (gggDivine !== null && gggDivine > 0) sources.push("ggg-completed-hour");
  if (ninjaDivine !== null && ninjaDivine > 0) sources.push("poe-ninja");
  return {
    gggDivine,
    ninjaDivine,
    deviationPct: deviation,
    agreement: classifyAgreement(deviation),
    ninjaTrendPct: quote?.totalChangePct ?? null,
    ninjaSparkline: quote?.sparkline ?? [],
    sources,
  };
}

/** Agreement on the hub rates themselves — a health check on the whole hour. */
export interface HubAgreement {
  currency: "exalted" | "chaos";
  gggPerDivine: number | null;
  ninjaPerDivine: number | null;
  deviationPct: number | null;
  agreement: SourceAgreement;
}

export function hubAgreements(
  gggPerDivine: { exalted: number | null; chaos: number | null },
  snapshot: NinjaSnapshot | null,
): HubAgreement[] {
  const ninja = snapshot?.hubRatesPerDivine ?? {};
  return (["exalted", "chaos"] as const).map((currency) => {
    const ggg = gggPerDivine[currency];
    const nin = typeof ninja[currency] === "number" ? ninja[currency]! : null;
    const deviation = deviationPct(ggg, nin);
    return { currency, gggPerDivine: ggg, ninjaPerDivine: nin, deviationPct: deviation, agreement: classifyAgreement(deviation) };
  });
}

/** GGG hub path -> the ninja id used for the same hub currency. */
export const HUB_NINJA_IDS: Record<string, string> = {
  [GGG_HUB_PATHS.DIVINE]: "divine",
  [GGG_HUB_PATHS.EXALTED]: "exalted",
  [GGG_HUB_PATHS.CHAOS]: "chaos",
};
