// Core domain types for the PoE2 arbitrage dashboard.
// Pure TypeScript — no framework imports — so this runs in tests,
// the Supabase ingester, and the browser.

/** Canonical item identity. GGG's metadata path is the source of truth. */
export interface ItemId {
  /** GGG metadata path, e.g. "Metadata/Items/Currency/CurrencyModValues" */
  gggPath: string;
  /** poe.ninja detailsId, e.g. "divine" (may be empty if not mapped yet) */
  ninjaId: string;
  displayName: string;
  category: string;
  /** icon URL on poe.ninja CDN (relative path is fine) */
  iconUrl: string | null;
  /** gold cost per unit received on the Currency Exchange (want side) */
  goldCostPerUnit: number;
  /** where the mapping came from; "quarantined" until proven */
  mappingSource: "checked-in-verified" | "poe-ninja" | "ggg-only" | "quarantined";
  /** when the mapping entry was last verified against live sources */
  lastVerifiedUtc: string;
}

/** One completed-hour market observation from the GGG feed. */
export interface GggMarket {
  league: string;
  /** canonical "pathA|pathB" */
  marketId: string;
  pair: [string, string];
  volumeTraded: Record<string, number>;
  lowestStock: Record<string, number>;
  highestStock: Record<string, number>;
  lowestRatio: Record<string, number>;
  highestRatio: Record<string, number>;
}

/** The GGG payload envelope (raw). */
export interface GggPayload {
  nextChangeId: number;
  markets: GggMarket[];
}

/**
 * A single *directed* edge derived from ONE independently observed market pair.
 * Edge direction is decided at derivation time: for pair (A, B), we create
 * edges A→B at ratio rateAB and B→A at ratio 1/rateAB — but crucially, both
 * edges trace back to the SAME observation. Route generation must therefore
 * never use both an edge and its reverse (`reverseEdgeKey`) inside one route,
 * or it manufactures profit from a single price.
 */
export interface DirectedEdge {
  key: string; // "A→B"
  reverseEdgeKey: string; // "B→A"
  from: string;
  to: string;
  /** units of `to` received per 1 unit of `from` (midpoint of observed range) */
  rate: number;
  /** lowest observed ratio of from:to (as rate) */
  rateLow: number;
  /** highest observed ratio of from:to (as rate) */
  rateHigh: number;
  /** total executed volume of `from` for this pair, this hour */
  volumeFrom: number;
  /** total executed volume of `to` for this pair, this hour */
  volumeTo: number;
  hourlyVolume: number; // max(volumeFrom, volumeTo) as the pair's hour volume
  hourUtc: string;
  source: "ggg-hourly" | "live-confirmed" | "manual-override";
  /** for live/manual sources, the confidence of the parsed quote (0..1) */
  confidence: number | null;
}

export interface RouteLeg {
  edgeKey: string;
  from: string;
  to: string;
  fromUnits: number;
  toUnits: number;
  /** integer ratio as the in-game order will use it: give fromUnits, receive toUnits */
  playbook: { give: number; pay: string; receive: number; want: string };
  goldCost: number; // integer units received × received item gold cost
  volumeShare: number; // toUnits / hourlyVolume of this pair, capped 0..1
}

export type RouteStrategy = "two-leg-cross" | "closed-triangle";

export interface Route {
  id: string;
  strategy: RouteStrategy;
  startCurrency: string;
  endCurrency: string;
  hubCurrency: string; // intermediate hub for two-leg; null-equivalent for triangle uses start
  legs: RouteLeg[];
  startUnits: number;
  endUnits: number;
  grossProfitBase: number; // in base currency
  goldCostTotal: number;
  movementHaircutPct: number;
  conservativeProfitBase: number;
  fillConfidence: number;
  expectedProfitBase: number;
  score: number;
  profitPer1mGold: number;
  profitPerTrade: number;
  capitalRoiPct: number;
  bottleneckVolumeShare: number;
  bottleneckEdgeKey: string;
  dataAgeHours: number;
  ratioRangePct: number;
}

export interface OpportunityRun {
  runId: string;
  league: string;
  sourceHourUtc: string;
  settings: RunSettings;
  routes: Route[];
  createdAtUtc: string;
}

export interface RunSettings {
  startCurrency: string; // GGG path
  baseCurrency: string; // GGG path used to value everything
  capitalUnits: number;
  goldBudget: number;
  maxLegs: number;
  maxVolumeSharePct: number; // default 10, hard ceiling 20
  minConservativeProfitBase: number;
  maxDataAgeHours: number;
  movementRiskTolerancePct: number; // 0..100
}