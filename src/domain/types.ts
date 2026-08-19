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
  observationId: string;
  key: string; // "observation:A→B"
  reverseEdgeKey: string; // "observation:B→A"
  from: string;
  to: string;
  /** units of `to` received per 1 unit of `from` (midpoint of observed range) */
  rate: number;
  /** lowest observed ratio of from:to (as rate) */
  rateLow: number;
  /** highest observed ratio of from:to (as rate) */
  rateHigh: number;
  /**
   * Total executed volume of `from` for this pair, this hour (units of `from`).
   * NOTE: volumeFrom and volumeTo are DIFFERENT currencies; they must never be
   * compared or max'ed directly. Per-leg shares are computed against the
   * matching denominator (see RouteLeg.fromShare/toShare).
   */
  volumeFrom: number;
  /** Total executed volume of `to` for this pair, this hour (units of `to`). */
  volumeTo: number;
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
  /**
   * Fraction of the executed hourly volume this leg consumes, in the leg's OWN
   * units. fromShare = fromUnits / volumeFrom (from-denominated), toShare =
   * toUnits / volumeTo (to-denominated). They are different units and are not
   * summed; the leg share is their maximum, and the route bottleneck is the
   * maximum leg share.
   */
  fromShare: number;
  toShare: number;
  /** max(fromShare, toShare); capped 0..1 after validation. */
  volumeShare: number;
}

export type RouteStrategy = "two-leg-cross" | "closed-triangle";

/** Whether reported base-currency profit is a realized loop or a reference. */
export type ProfitKind = "mark-to-market" | "closed-realized";

/** One directed edge used inside a valuation path (for disclosure only). */
export interface ValuationEdge {
  observationId: string;
  from: string;
  to: string;
  rate: number;
}

/**
 * Disclosure of how an item was valued in base currency and whether the route
 * actually returns to base. A cross-currency flip that ends in a non-base
 * currency and only *references* a separate Exalted→Divine quote is
 * "mark-to-market" and is NOT fully realized base profit.
 */
export interface ValuationDisclosure {
  profitKind: ProfitKind;
  inputValuationPath: ValuationEdge[];
  outputValuationPath: ValuationEdge[];
  /** All observation IDs involved in route legs AND valuation paths. */
  observationIds: string[];
  /** The base-currency rates used at each valuation hop. */
  valuationRates: number[];
  /** Extra executable trades required to convert the end currency back to base. */
  returnToBaseLegs: ValuationEdge[];
  /** Whether returnToBaseLegs (and their gold/movement/trades) are included in the reported totals. */
  returnToBaseIncluded: boolean;
}

export type MovementStatus = "insufficient-history" | "computed";

export interface Route {
  /** Deterministic opportunity identity: family + league + source hour + execution sizing. */
  id: string;
  /** Deterministic route family: strategy + canonical ordered observation identity. */
  routeFamilyId: string;
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
  /** Completed-hour low/high ratio range (labeled RANGE UNCERTAINTY, not temporal movement). */
  ratioRangeUncertaintyPct: number;
  /** Temporal price movement; null when there is insufficient hourly history. */
  temporalMovementPct: number | null;
  movementStatus: MovementStatus;
  /** Estimated market-impact risk, kept separate from temporal movement. */
  estimatedMarketImpactPct: number;
  conservativeProfitBase: number;
  fillConfidence: number;
  expectedProfitBase: number;
  score: number;
  profitPer1mGold: number;
  profitPerTrade: number;
  capitalRoiPct: number;
  bottleneckVolumeShare: number;
  bottleneckEdgeKey: string;
  /** Actual source age in hours (now - source_hour), never the configured limit. */
  dataAgeHours: number;
  ratioRangePct: number;
  profitKind: ProfitKind;
  valuation: ValuationDisclosure;
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
  league: string; // GGG league for this run (part of opportunity identity)
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
