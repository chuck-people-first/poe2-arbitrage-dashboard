import type { Route } from "./types.ts";

/** Deduplicate only sizing variants within one source-hour route set. */
export function dedupeSizingVariants(routes: Route[]): Route[] {
  const groups = new Map<string, Route[]>();
  for (const route of routes) {
    const key = [route.strategy, route.startCurrency, route.endCurrency, ...route.legs.map((leg) => leg.edgeKey)].join("|");
    groups.set(key, [...(groups.get(key) ?? []), route]);
  }
  return [...groups.values()].map((group) => [...group].sort(compareSizePareto)[0]!);
}

function compareSizePareto(a: Route, b: Route): number {
  return b.profitPer1mGold - a.profitPer1mGold
    || b.profitPerTrade - a.profitPerTrade
    || a.startUnits - b.startUnits
    || a.movementHaircutPct - b.movementHaircutPct
    || a.bottleneckVolumeShare - b.bottleneckVolumeShare
    || a.id.localeCompare(b.id);
}
