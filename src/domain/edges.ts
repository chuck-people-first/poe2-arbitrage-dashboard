// Directed-edge derivation with the anti-fabrication invariant:
// every directed edge traces back to ONE independently observed market pair.
// A rate and its reciprocal are the SAME observation — no route may use both
// an edge and its reverse edge, or it manufactures profit from a single price.

import type { DirectedEdge, GggMarket } from "./types.ts";

/**
 * Derive the full directed-edge set from one completed hour of GGG markets.
 *
 * For each market pair (A, B) observed in the hour we create exactly TWO edges
 * (A→B and B→A) from the same observation. They are linked via
 * `reverseEdgeKey`. Route generation rejects any path that uses an edge whose
 * reverse is already in the path.
 *
 * IMPORTANT: edge direction here is *generic*. For arbitrage detection what
 * matters is using independent markets; direction is decided by the route
 * searcher. A→B and B→A both exist because either direction may be the one the
 * route needs — but never both in the same route.
 */
export function deriveEdges(markets: GggMarket[], hourUtc: string): DirectedEdge[] {
  const edges: DirectedEdge[] = [];
  for (const m of markets) {
    const [a, b] = m.pair;
    if (!a || !b) continue;
    const raLow = m.lowestRatio[a] ?? 0;
    const raHigh = m.highestRatio[a] ?? 0;
    const rbLow = m.lowestRatio[b] ?? 0;
    const rbHigh = m.highestRatio[b] ?? 0;
    // Rate = units of second item per 1 unit of first.
    // (lowest_ratio[a]:lowest_ratio[b]) => ratioB/ratioA units of B per unit A
    if (raLow <= 0 || rbLow <= 0 || raHigh <= 0 || rbHigh <= 0) continue;

    const loAB = Math.min(rbLow / raLow, rbHigh / raHigh); // worst case A->B
    const hiAB = Math.max(rbLow / raLow, rbHigh / raHigh); // best case A->B
    const rateAB = (loAB + hiAB) / 2;
    const volumeA = m.volumeTraded[a] ?? 0;
    const volumeB = m.volumeTraded[b] ?? 0;

    const edgeAB: DirectedEdge = {
      observationId: m.marketId,
      key: `${m.marketId}:${a}->${b}`,
      reverseEdgeKey: `${m.marketId}:${b}->${a}`,
      from: a,
      to: b,
      rate: rateAB,
      rateLow: loAB,
      rateHigh: hiAB,
      volumeFrom: volumeA,
      volumeTo: volumeB,
      hourUtc,
      source: "ggg-hourly",
      confidence: null,
    };
    const edgeBA: DirectedEdge = {
      observationId: m.marketId,
      key: `${m.marketId}:${b}->${a}`,
      reverseEdgeKey: `${m.marketId}:${a}->${b}`,
      from: b,
      to: a,
      rate: 1 / rateAB,
      rateLow: 1 / hiAB,
      rateHigh: 1 / loAB,
      volumeFrom: volumeB,
      volumeTo: volumeA,
      hourUtc,
      source: "ggg-hourly",
      confidence: null,
    };
    edges.push(edgeAB, edgeBA);
  }
  return edges;
}

/** Look up edges by their key for quick route search. */
export class EdgeIndex {
  private readonly byKey = new Map<string, DirectedEdge[]>();
  private readonly all: DirectedEdge[];
  constructor(edges: DirectedEdge[]) {
    this.all = [...edges];
    for (const e of edges) {
      const list = this.byKey.get(e.key) ?? [];
      list.push(e);
      this.byKey.set(e.key, list);
    }
  }
  get(key: string): DirectedEdge | undefined { return this.byKey.get(key)?.[0]; }
  getAll(key: string): DirectedEdge[] { return [...(this.byKey.get(key) ?? [])]; }
  getAllByEndpoints(from: string, to: string): DirectedEdge[] {
    return this.all.filter((edge) => edge.from === from && edge.to === to);
  }
}

export function edgeIndex(edges: DirectedEdge[]): EdgeIndex { return new EdgeIndex(edges); }

/** Does using this edge violate the "one observation per route" rule? */
export function conflictsWith(edge: DirectedEdge, usedKeys: Set<string>): boolean {
  return usedKeys.has(edge.key) || usedKeys.has(edge.reverseEdgeKey);
}