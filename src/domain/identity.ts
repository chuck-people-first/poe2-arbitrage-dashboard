// Deterministic route identity and valuation disclosure.
// Route family identity is strategy + canonical ordered observation/path
// identity. Opportunity identity adds league, source hour and execution sizing.
// Both use stable SHA-256 over canonical deterministic serialization so that
// collisions cannot come from shortened currency display names.

import { createHash } from "node:crypto";
import type { DirectedEdge, Route, ValuationDisclosure } from "./types.ts";

export function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

/** Canonical ordered path identity used for the route family + opportunity. */
export function pathObsKey(edges: DirectedEdge[]): string {
  return edges
    .map((e) => `${e.observationId}>${e.from}>${e.to}`)
    .join("|");
}

/**
 * The route family: the strategy plus the canonical ordered observation/path
 * identity. Two historical hours that re-observe the same currency path with
 * the same legs share this id; sizing differences do not split it.
 */
export function routeFamilyId(strategy: Route["strategy"], edges: DirectedEdge[]): string {
  return sha256Hex(`family|${strategy}|${pathObsKey(edges)}`);
}

/**
 * The opportunity id: route family + league + source hour + execution sizing.
 * Distinct source hours or distinct start units produce distinct opportunities.
 */
export function opportunityId(
  familyId: string,
  league: string,
  sourceHourUtc: string,
  startUnits: number,
): string {
  return sha256Hex(`opp|${familyId}|${league}|${sourceHourUtc}|${startUnits}`);
}

/** Build the valuation disclosure for a route leg. */
export function disclosureForLegs(
  inputPath: DirectedEdge[],
  outputPath: DirectedEdge[],
  returnToBaseLegs: DirectedEdge[],
  returnToBaseIncluded: boolean,
): ValuationDisclosure {
  const valuationEdges = (edges: DirectedEdge[]) =>
    edges.map((e) => ({ observationId: e.observationId, from: e.from, to: e.to, rate: e.rate }));
  const obsIds = new Set<string>([
    ...inputPath.map((e) => e.observationId),
    ...outputPath.map((e) => e.observationId),
    ...returnToBaseLegs.map((e) => e.observationId),
  ]);
  return {
    profitKind: returnToBaseIncluded ? "closed-realized" : "mark-to-market",
    inputValuationPath: valuationEdges(inputPath),
    outputValuationPath: valuationEdges(outputPath),
    observationIds: [...obsIds],
    valuationRates: [...inputPath, ...outputPath].map((e) => e.rate),
    returnToBaseLegs: valuationEdges(returnToBaseLegs),
    returnToBaseIncluded,
  };
}
