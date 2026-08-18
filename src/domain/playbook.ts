// Integer playbook math — exactly as the in-game order will use it.
// In PoE2's Currency Exchange, orders are integer stacks and gold is charged
// per unit of the item on the RECEIVED (want) side.

import type { DirectedEdge, RouteLeg } from "./types";
import { goldCostPerUnit } from "./mapping";

/**
 * Compute an integer trade for one directed edge.
 *
 * giveFullUnits: how many units of `from` the player offers.
 * Returns the integer units received (rounded DOWN — the player never receives
 * more than the exact ratio implies) and the gold cost.
 *
 * Gold = integer_received_units × gold_cost_per_unit(received item).
 * A zero/negative intake yields a zero (dead) leg — the caller's hard filters
 * reject routes that collapse; this never throws for a legitimate zero.
 */
export function planLeg(
  edge: DirectedEdge,
  giveFullUnits: number,
): { leg: Omit<RouteLeg, "volumeShare">; receivedUnits: number; goldCost: number } {
  if (giveFullUnits < 0) throw new Error("giveFullUnits must be non-negative");
  const receivedUnits = Math.max(0, Math.floor(giveFullUnits * edge.rate));
  if (receivedUnits === 0) {
    return {
      leg: {
        edgeKey: edge.key,
        from: edge.from,
        to: edge.to,
        fromUnits: giveFullUnits,
        toUnits: 0,
        playbook: { give: giveFullUnits, pay: edge.from, receive: 0, want: edge.to },
        goldCost: 0,
      },
      receivedUnits: 0,
      goldCost: 0,
    };
  }
  const { cost, verified } = goldCostPerUnit(edge.to);
  if (!verified) {
    throw new Error(`gold cost unverified for received item ${edge.to}`);
  }
  const goldCost = receivedUnits * cost;
  return {
    leg: {
      edgeKey: edge.key,
      from: edge.from,
      to: edge.to,
      fromUnits: giveFullUnits,
      toUnits: receivedUnits,
      playbook: {
        give: giveFullUnits,
        pay: edge.from,
        receive: receivedUnits,
        want: edge.to,
      },
      goldCost,
    },
    receivedUnits,
    goldCost,
  };
}

/**
 * Walk a chain of edges from a starting quantity. All units are integers after
 * each step (floor on receipt). Throws if gold cost of any received item is
 * unverified — an unmapped fee must never be silently treated as zero.
 */
export function walkChain(
  edges: DirectedEdge[],
  startUnits: number,
): { legs: Omit<RouteLeg, "volumeShare">[]; endUnits: number; totalGold: number } {
  const legs: Omit<RouteLeg, "volumeShare">[] = [];
  let units = startUnits;
  let totalGold = 0;
  for (const edge of edges) {
    const { leg, receivedUnits, goldCost } = planLeg(edge, units);
    legs.push(leg);
    units = receivedUnits;
    totalGold += goldCost;
  }
  return { legs, endUnits: units, totalGold };
}

/** Validate that a chain doesn't reference the same market twice (or its reverse). */
export function chainUsesIndependentObservations(edges: DirectedEdge[]): boolean {
  const seen = new Set<string>();
  for (const e of edges) {
    if (seen.has(e.key) || seen.has(e.reverseEdgeKey)) return false;
    seen.add(e.key);
  }
  return true;
}