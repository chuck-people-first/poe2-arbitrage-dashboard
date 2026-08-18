// Route generation: two-leg cross-currency flips and closed triangles.
//
// Invariants enforced here (from the spec):
//  1. Every leg uses an independently observed market; no edge and its reverse
//     may appear in the same route (this is THE anti-fabrication rule).
//  2. Routes are generated from the latest completed hour only (or fresher
//     confirmed overrides).
//  3. No route exceeds maxLegs (default 2, i.e. two-leg flip or 3-leg triangle
//     is allowed when maxLegs=3 is chosen; we generate both strategies).
//  4. Two-leg flip: A -> X -> B. Ends in B, valued in base.
//  5. Closed triangle: A -> X -> B -> A. Three legs, ends in A.
//     These are ranked below equally-profitable two-leg flips (extra fill risk).

import type { DirectedEdge, Route, RouteLeg, RunSettings } from "./types.ts";
import { conflictsWith, edgeIndex } from "./edges.ts";
import { walkChain } from "./playbook.ts";

export interface RouteCandidate {
  strategy: Route["strategy"];
  edges: DirectedEdge[];
  startCurrency: string;
  endCurrency: string;
  startUnits: number;
  settings: RunSettings;
}

export function enumerateTwoLegFlips(
  edges: DirectedEdge[],
  settings: RunSettings,
): RouteCandidate[] {
  const out: RouteCandidate[] = [];
  const byFrom = new Map<string, DirectedEdge[]>();
  for (const e of edges) {
    if (e.from === e.to) continue;
    const list = byFrom.get(e.from) ?? [];
    list.push(e);
    byFrom.set(e.from, list);
  }

  const start = settings.startCurrency;
  const firstLegs = byFrom.get(start) ?? [];
  for (const leg1 of firstLegs) {
    const x = leg1.to;
    if (x === start) continue;
    // Must be able to value X in base currency via a mapped gold cost / display.
    const secondLegs = byFrom.get(x) ?? [];
    for (const leg2 of secondLegs) {
      if (leg2.to === start) continue; // that's a round trip of the same pair
      if (conflictsWith(leg2, new Set([leg1.key]))) continue; // same market twice
      out.push({
        strategy: "two-leg-cross",
        edges: [leg1, leg2],
        startCurrency: start,
        endCurrency: leg2.to,
        startUnits: settings.capitalUnits,
        settings,
      });
    }
  }
  return out;
}

export function enumerateClosedTriangles(
  edges: DirectedEdge[],
  settings: RunSettings,
): RouteCandidate[] {
  if (settings.maxLegs < 3) return [];
  const out: RouteCandidate[] = [];
  const byFrom = new Map<string, DirectedEdge[]>();
  for (const e of edges) {
    if (e.from === e.to) continue;
    const list = byFrom.get(e.from) ?? [];
    list.push(e);
    byFrom.set(e.from, list);
  }

  const start = settings.startCurrency;
  const firstLegs = byFrom.get(start) ?? [];
  for (const leg1 of firstLegs) {
    const x = leg1.to;
    if (x === start) continue;
    const used1 = new Set([leg1.key]);
    const secondLegs = byFrom.get(x) ?? [];
    for (const leg2 of secondLegs) {
      if (leg2.to === x || leg2.to === start) continue; // no self/backtracking
      if (conflictsWith(leg2, used1)) continue; // same market as leg1
      const y = leg2.to;
      const used2 = new Set([...used1, leg2.key]);
      // third leg must return to start
      const thirdLegs = byFrom.get(y) ?? [];
      for (const leg3 of thirdLegs) {
        if (leg3.to !== start) continue;
        if (conflictsWith(leg3, used2)) continue; // same market as leg1 or leg2
        out.push({
          strategy: "closed-triangle",
          edges: [leg1, leg2, leg3],
          startCurrency: start,
          endCurrency: start,
          startUnits: settings.capitalUnits,
          settings,
        });
      }
    }
  }
  return out;
}

export interface EvaluatedRoute {
  route: RouteCandidate;
  legs: RouteLeg[];
  endUnits: number;
  goldTotal: number;
  error: string | null;
}

/** Execute the integer playbook for a candidate, evaluating every leg. */
export function evaluateCandidate(c: RouteCandidate): EvaluatedRoute {
  try {
    const { legs, endUnits, totalGold } = walkChain(c.edges, c.startUnits);
    const withShare = legs.map((leg, i) => ({
      ...leg,
      volumeShare: c.edges[i]!.hourlyVolume > 0 ? leg.toUnits / c.edges[i]!.hourlyVolume : 0,
    }));
    return { route: c, legs: withShare, endUnits, goldTotal: totalGold, error: null };
  } catch (e) {
    return {
      route: c,
      legs: [],
      endUnits: 0,
      goldTotal: 0,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

/**
 * Convert any item quantity into the chosen base currency.
 * For Phase 0 we value via GGG cross-rate to the base hub when the pair
 * exists in the same hour; otherwise the route is dropped (no fabricated
 * pricing). Live-confirmed quotes are honored when present.
 */
export function valueInBase(
  itemPath: string,
  units: number,
  basePath: string,
  edges: DirectedEdge[],
  usedEdgeKeys: Set<string> = new Set(),
): number | null {
  if (itemPath === basePath) return units;
  const idx = edgeIndex(edges);
  const direct = idx.getAllByEndpoints(itemPath, basePath).find((e) => !conflictsWith(e, usedEdgeKeys));
  if (direct) return units * direct.rate;
  // try via an intermediate hub (two hops) — only when both legs are independent
  const viaCandidates = edges.filter((e) => e.from === itemPath);
  for (const e of viaCandidates) {
    if (conflictsWith(e, usedEdgeKeys)) continue;
    const second = idx.getAllByEndpoints(e.to, basePath).find(
      (candidate) => !conflictsWith(candidate, new Set([...usedEdgeKeys, e.key])),
    );
    if (second) {
      return units * e.rate * second.rate;
    }
  }
  return null;
}