// Single shared projection of a scored Route -> persisted opportunity row
// (including the embedded TwoLegFlip product projection).
//
// PRODUCTION-PATH PARITY: both the Supabase Edge Function (Deno) and the Node
// ingestion worker call THIS function to turn a scored Route into the row that
// is persisted and (via route.flip) served to the browser. There is exactly ONE
// implementation, so the two runtimes cannot drift.
//
// Rules enforced here (reflected in the field shape):
//   - The TwoLegFlip product projection is resolved from the checked-in mapping;
//     an unresolved or ambiguous item NEVER surfaces as a raw GGG id. A route
//     that is not a clean same-item two-leg flip gets NO flip and is dropped
//     from the public dashboard by the table renderer.
//   - The audited Route is never mutated; we attach `flip` on a shallow copy.
//   - Phase B/C fields (trend, recommendation) are always absent (null/undefined)
//     until deterministic hourly history exists — never fabricated.

import type { Route } from "./types.ts";
import { toTwoLegFlip, toClosedFlipCycle } from "./flips.ts";

/** The persisted opportunity row (ProjectView) shared by Edge + Node. */
export interface OpportunityRow {
  strategy: Route["strategy"];
  route: Route & { flip?: ReturnType<typeof toTwoLegFlip> };
  cycle?: ReturnType<typeof toClosedFlipCycle>;
  playbook: unknown[];
  startCurrency: string;
  endCurrency: string;
  startUnits: number;
  endUnits: number;
  grossProfitBase: number;
  conservativeProfitBase: number;
  expectedProfitBase: number;
  goldCost: number;
  legCount: number;
  bottleneckVolumeShare: number;
  ratioRangePct: number;
  movementHaircutPct: number;
  fillConfidence: number;
  score: number;
  profitKind: Route["profitKind"];
  profitClass: Route["profitClass"];
  realizedCurrency: string | null;
  realizedProfitStart: number | null;
  realizedProfitBase: number | null;
  sourceHour: string;
  payloadSha256: string;
}

/**
 * Project a scored Route into a persisted opportunity row.
 * `league` and `sourceHourUtc` come from the run context (the Route object
 * does not carry them). Pass a reference time for live source-age if known;
 * defaults to now.
 */
export function projectRoute(
  route: Route,
  league: string,
  sourceHourUtc: string,
  payloadSha256: string,
  referenceTimeMs: number = Date.now(),
): OpportunityRow | null {
  if (!route) return null;
  // Product projection: resolve the two-leg flip to executable readable
  // identities. Unresolved/ambiguous items, or a route that is not a clean
  // same-item two-leg flip, get NO flip here (never a raw GGG id).
  const flip = toTwoLegFlip(route, league, sourceHourUtc, referenceTimeMs);
  const cycle = toClosedFlipCycle(route, league, sourceHourUtc, referenceTimeMs);
  const routeWithFlip = flip ? { ...route, flip } : route;
  return {
    strategy: route.strategy,
    route: routeWithFlip,
    cycle: cycle ?? undefined,
    playbook: route.legs.map((leg) => leg.playbook),
    startCurrency: route.startCurrency,
    endCurrency: route.endCurrency,
    startUnits: route.startUnits,
    endUnits: route.endUnits,
    grossProfitBase: route.grossProfitBase,
    conservativeProfitBase: route.conservativeProfitBase,
    expectedProfitBase: route.expectedProfitBase,
    goldCost: route.goldCostTotal,
    legCount: route.legs.length,
    bottleneckVolumeShare: route.bottleneckVolumeShare,
    ratioRangePct: route.ratioRangePct,
    movementHaircutPct: route.movementHaircutPct,
    fillConfidence: route.fillConfidence,
    score: route.score,
    profitKind: route.profitKind,
    profitClass: route.profitClass,
    realizedCurrency: route.realizedCurrency,
    realizedProfitStart: route.realizedProfitStart,
    realizedProfitBase: route.realizedProfitBase,
    sourceHour: sourceHourUtc,
    payloadSha256,
  };
}
