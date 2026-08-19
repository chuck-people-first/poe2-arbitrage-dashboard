import type { Route } from "./types.ts";

/**
 * Deduplicate only sizing variants within one source-hour route set.
 *
 * The comparison is a deterministic LEXICOGRAPHIC ordering — it picks the
 * single best route by a fixed priority sequence (profit-per-Divine-per-Gold, then
 * profit-per-trade, then smaller start, then lower movement, then lower
 * bottleneck, then id). It is NOT a Pareto-front selection: it does not
 * return the full set of mutually-non-dominated variants. Callers must treat
 * it as the one-chosen-variant tier and must not describe it as Pareto.
 *
 * The caller is responsible for confining each invocation to a single
 * league / source-hour set; mixing hours here would collapse otherwise
 * distinct alternative-hour observations of the same route family.
 */
export function dedupeSizingVariants(routes: Route[], league?: string, sourceHourUtc?: string): Route[] {
  const groups = new Map<string, Route[]>();
  for (const route of routes) {
    const key = [route.strategy, route.startCurrency, route.endCurrency, ...route.legs.map((leg) => leg.edgeKey)].join("|");
    // Scope the group to the supplied league/source hour when given, so an
    // identical currency path at different hours stays a separate observation.
    const scopedKey = [league ?? "", sourceHourUtc ?? "", key].join("~");
    groups.set(scopedKey, [...(groups.get(scopedKey) ?? []), route]);
  }
  return [...groups.values()].map((group) => [...group].sort(compareLexicographic)[0]!);
}

/**
 * Deduplicate persisted opportunities within one league/source-hour set.
 * Groups by the route's deterministic `routeFamilyId` (strategy + canonical
 * observation identity) and keeps the single lexicographically-best sizing
 * variant per family. Pure module (no node imports) so it can run in the
 * Supabase Edge Function.
 */
export function dedupeOpportunityRows<T extends { route: unknown }>(
  opportunities: T[],
  familyOf?: (row: T) => string,
  scoreOf?: (row: T) => number,
): T[] {
  const groups = new Map<string, T[]>();
  for (const opp of opportunities) {
    const family = familyOf
      ? familyOf(opp)
      : ((opp.route as { routeFamilyId?: string } | null | undefined)?.routeFamilyId ?? "");
    const key = family || JSON.stringify([opp.route]);
    groups.set(key, [...(groups.get(key) ?? []), opp]);
  }
  return [...groups.values()].map((group) => [...group].sort((a, b) => {
    const diff = (scoreOf ? scoreOf(b) - scoreOf(a) : 0);
    return diff;
  })[0]!);
}

/** Deterministic lexicographic ranking (NOT a Pareto front). */
function compareLexicographic(a: Route, b: Route): number {
  return b.divineProfitPerGold - a.divineProfitPerGold
    || b.profitPerTrade - a.profitPerTrade
    || a.startUnits - b.startUnits
    || a.movementHaircutPct - b.movementHaircutPct
    || a.bottleneckVolumeShare - b.bottleneckVolumeShare
    || a.id.localeCompare(b.id);
}
