// Automatic opportunity scanner shared by Node tests and the Supabase Edge
// Function. The product never asks the player to choose a starting currency:
// every completed hour is scanned from each liquid hub independently.

import { dedupeOpportunityRows } from "./dedupe.ts";
import { GGG_HUB_PATHS } from "./mapping.ts";
import { projectRoute, type OpportunityRow } from "./opportunity.ts";
import {
  enumerateClosedTriangles,
  enumerateTwoLegFlips,
  evaluateCandidate,
  type RouteCandidate,
} from "./routes.ts";
import { rankDefault, scoreCandidate, toRoute } from "./scoring.ts";
import type { DirectedEdge, RunSettings } from "./types.ts";

/** All liquid hub currencies are scanned automatically; order is product priority. */
export const DEFAULT_START_CURRENCIES = [
  GGG_HUB_PATHS.EXALTED,
  GGG_HUB_PATHS.CHAOS,
  GGG_HUB_PATHS.DIVINE,
] as const;

const HUB_CURRENCIES = new Set<string>(DEFAULT_START_CURRENCIES);

/** Product route shape: buy a non-hub item, then sell it into a liquid hub. */
export function isItemArbitrageCandidate(candidate: RouteCandidate): boolean {
  const [buyLeg, sellLeg, returnLeg] = candidate.edges;
  if (!buyLeg || !sellLeg) return false;
  if (HUB_CURRENCIES.has(buyLeg.to)) return false;
  if (!HUB_CURRENCIES.has(sellLeg.to)) return false;
  if (candidate.strategy === "closed-triangle") {
    return Boolean(returnLeg && returnLeg.from === sellLeg.to && returnLeg.to === candidate.startCurrency);
  }
  return candidate.edges.length === 2;
}

/** Enumerate routes from every configured starting currency. */
export function enumerateAllCurrencyRoutes(
  edges: DirectedEdge[],
  settings: RunSettings,
  startCurrencies: readonly string[] = DEFAULT_START_CURRENCIES,
): RouteCandidate[] {
  return startCurrencies.flatMap((startCurrency) => {
    const scopedSettings: RunSettings = { ...settings, startCurrency };
    return [
      ...enumerateTwoLegFlips(edges, scopedSettings),
      ...enumerateClosedTriangles(edges, scopedSettings),
    ].filter(isItemArbitrageCandidate);
  });
}

/** Score, project, deduplicate and rank one completed-hour market graph. */
export function scanOpportunityRows(
  edges: DirectedEdge[],
  settings: RunSettings,
  league: string,
  sourceHourUtc: string,
  payloadSha256: string,
  referenceTimeMs: number = Date.now(),
  startCurrencies: readonly string[] = DEFAULT_START_CURRENCIES,
): OpportunityRow[] {
  const rows = enumerateAllCurrencyRoutes(edges, settings, startCurrencies)
    .map((candidate) => {
      const evaluation = evaluateCandidate(candidate);
      const scoring = scoreCandidate(
        candidate,
        evaluation,
        edges,
        candidate.settings,
        referenceTimeMs,
      );
      const route = toRoute(
        candidate,
        scoring,
        evaluation,
        sourceHourUtc,
        edges,
        referenceTimeMs,
      );
      if (!route || scoring.score === null) return null;
      const projected = projectRoute(route, league, sourceHourUtc, payloadSha256, referenceTimeMs);
      // Candidate counts and public rows must describe actual user-facing
      // options. Unresolved identities remain rejected rather than appearing
      // as raw internal paths or inflating the dashboard count.
      if (!projected?.cycle && !projected?.route.flip) return null;
      return projected;
    })
    .filter((row): row is OpportunityRow => row !== null);

  return dedupeOpportunityRows(
    rows,
    (row) => row.route.routeFamilyId,
    (row) => row.score,
  ).sort((a, b) => rankDefault(a.route, b.route));
}
