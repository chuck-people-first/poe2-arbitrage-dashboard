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

/** One Currency Exchange quote, written exactly as the game shows I WANT : I HAVE. */
export interface InGameRatio {
  want: number;
  have: number;
  side: "conservative-hourly" | "favorable-hourly";
}

/**
 * The two price boundaries exposed by GGG's completed-hour aggregate.
 * This is deliberately not called an order book: the official feed does not
 * expose the live ladder or any intermediate price levels.
 */
export interface InGameRatioRange {
  favorable: InGameRatio;
  conservative: InGameRatio;
  source: "ggg-completed-hour-boundaries";
}

export interface RouteLeg {
  edgeKey: string;
  from: string;
  to: string;
  fromUnits: number;
  toUnits: number;
  /** Direct observed midpoint rate used to plan this leg (to units per from unit). */
  rate?: number;
  /** Independently observed hourly volume in the leg's pay currency. */
  volumeFrom?: number;
  /** Independently observed hourly volume in the leg's receive currency. */
  volumeTo?: number;
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
  /** Per-leg disclosure fields populated when the source supplies them. */
  sourceHourUtc?: string;
  ratioRangePct?: number;
  marketImpactPct?: number;
  movementHaircutPct?: number;
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
  /** Valuation-path liquidity (item 4): unit-safe bottleneck share of the most
   *  illiquid hop in the combined input+output valuation paths. */
  valuationBottleneckVolumeShare: number;
  /** Valuation-path ratio-range uncertainty (max over valuation hops). */
  valuationRangeUncertaintyPct: number;
  /** Confidence label derived from valuation-path liquidity/range. */
  valuationConfidence: number;
  /** Whether the required reference-path quantities are integer-executable. */
  valuationExecutable: boolean;
  /** Whether gold for the return/valuation trades is included in totals. */
  valuationGoldIncluded: boolean;
  /** Number of extra trades required to return to base (0 when excluded/mark-to-market). */
  valuationTradeCountIncluded: number;
}

export type MovementStatus = "insufficient-history" | "computed";

/**
 * Profit classification (item 5): a route is classified by what it actually
 * closes, NOT hardcoded to mark-to-market.
 *   - two-leg cross ending in another currency            -> mark-to-market
 *   - route returning to its starting currency            -> closed-realized
 *     (closes in the STARTING currency; may differ from the display base)
 *   - route explicitly converted back to base with all of
 *     its return legs included                            -> closed-realized (base)
 */
export type ProfitClass = "mark-to-market" | "closed-realized";

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
    grossProfitBase: number; // in base currency (mark-to-market valuation when not closed in base)
    /** Input value in base currency (start units converted), captured for the flip view. */
    inputValueBase: number;
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
  divineProfitPerGold: number;
  profitPerTrade: number;
  capitalRoiPct: number;
  bottleneckVolumeShare: number;
  bottleneckEdgeKey: string;
  /** Actual source age in hours (now - source_hour), never the configured limit. */
  dataAgeHours: number;
  ratioRangePct: number;
  profitKind: ProfitKind;
  /**
   * Classification (item 5). `realizedCurrency` is the currency the route truly
   * closes in, or null for mark-to-market. When a route closes in a currency
   * that differs from the display base, realizedProfitStart is the closed
   * profit in that currency and realizedProfitBase is its mark-to-market
   * Divine-currency equivalent — the two must not be conflated.
   */
  profitClass: ProfitClass;
  realizedCurrency: string | null;
  realizedProfitStart: number | null;
  realizedProfitBase: number | null;
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

// ---------------------------------------------------------------------------
// Product-facing two-leg item flip model.
//
// A two-leg item flip is the PRIMARY opportunity: buy one specific item with
// Currency A, then sell that SAME item for Currency B. Both legs are exact
// executable integer trades. Valuing the input currency in Divine is a
// supporting calculation — NOT an extra player instruction.
// ---------------------------------------------------------------------------

/** Resolved display identity for one item or currency (NEVER a raw GGG id). */
export interface FlipIdentity {
  /** stable GGG metadata path (item/currency id) */
  id: string;
  /** readable display name, e.g. "Chaos Orb", "Tul's Catalyst" */
  name: string;
  /** absolute icon URL when available */
  iconUrl: string | null;
  /** gold cost per unit received on the Currency Exchange (want side) */
  goldCostPerUnit: number;
}

/** One executable leg of the flip. Quantities are exact integers. */
export interface FlipLeg {
  /** what the player pays (currency A in leg 1, the item in leg 2) */
  pay: number;
  /** what the player receives (the item in leg 1, currency B in leg 2) */
  receive: number;
  /** gold charged for this leg = received units x gold cost of received item */
  goldCost: number;
  /** hourly executed volume available for this leg, in the leg's own units */
  hourlyVolume: number;
}

/**
 * The complete product record for one two-leg item flip:
 * buy item X with currency A -> sell that same item X for currency B.
 */
export interface TwoLegFlip {
  /** Deterministic opportunity identity (family + league + source hour + sizing). */
  id: string;
  /** Deterministic family identity: same item + buy/sell path across hours. */
  familyId: string;
  league: string;
  sourceHourUtc: string;
  /** Actual source age in hours (now - source_hour), computed live at render. */
  sourceAgeHours: number;

  /** The item being flipped (resolved, readable). */
  item: FlipIdentity;
  /** Buying currency A (resolved, readable). */
  buyCurrency: FlipIdentity;
  /** Selling currency B (resolved, readable). */
  sellCurrency: FlipIdentity;

  /** Leg 1: pay this many units of A -> receive this many units of X. */
  buyLeg: FlipLeg;
  /** Leg 2: pay this many units of X -> receive this many units of B. */
  sellLeg: FlipLeg;

  /** Gold required for BOTH legs (executable in-game). */
  goldRequired: number;
  /** Number of trades to execute the flip (always 2). */
  tradeCount: 2;

  /** Input value in Divine equivalents (buy amount, supporting conversion). */
  inputDivineValue: number;
  /** Output value in Divine equivalents (sell proceeds). */
  outputDivineValue: number;
  /** gross profit = output - input (before haircuts). */
  grossProfitDivine: number;
  /** conservative net profit after movement/market-impact haircut. */
  conservativeNetProfitDivine: number;
  /** Unscaled Divine profit per one Gold. */
  divineProfitPerGold: number;
  /** Net Divine profit per 100K Gold — the Div / 100K Gold display metric. */
  divPer100kGold: number;

  /** Highest leg volume share of executed hourly volume (0..1, bottleneck). */
  volumeShare: number;
  /** lowest hourly volume across both legs (units of the item per hour). */
  lowestLegVolume: number;
  /** Estimated fill risk (0..1). HEURISTIC, explicitly labeled as an estimate. */
  fillRisk: number;
  fillRiskLabel: "Low" | "Medium" | "High";

  /** Whether the sell leg closes in the base currency (realized) or not. */
  profitKind: ProfitKind;
  /** Full valuation disclosure (input/output paths, rates, observation ids). */
  valuation: ValuationDisclosure;

  // Advanced metrics — retained for the detail drawer, not the main table.
  ratioRangePct: number;
  movementHaircutPct: number;
  capitalRoiPct: number;
  expectedProfitDivine: number;
  confidence: number;

  // Phase B / C fields. Filled from compact hourly history; absent (null)
  // means "insufficient history" — never fabricated.
  trend: FlipTrend | null;
  recommendation: FlipRecommendation | null;
}

/**
 * How much of the equation a signal has actually proven.
 *
 * These are ordered by strength and are NOT interchangeable:
 *   - "return-confirmed"       every leg + the independent return conversion
 *                              is priced at its least-favorable completed-hour
 *                              boundary, every gold fee is verified, and the
 *                              closed cycle is still positive. Only this may be
 *                              described as a closed cycle.
 *   - "fee-check-needed"       the closed cycle is positive but at least one
 *                              item gold fee is a category estimate.
 *   - "return-quote-available" a direct return market exists and is priced, but
 *                              the conservative closed cycle is not positive.
 *                              The spread is real; the round trip is not proven.
 *   - "two-leg-spread"         item mispricing between two currency markets
 *                              only. No independent return market was observed.
 *   - "high-risk"              the sizing needed to act consumes an abnormal
 *                              share of the observed hourly market. Overrides
 *                              the others because liquidity, not price, is the
 *                              binding constraint.
 */
export type SignalClassification =
  | "return-confirmed"
  | "fee-check-needed"
  | "return-quote-available"
  | "two-leg-spread"
  | "high-risk";

/**
 * The three figures the product must keep separate. Collapsing them is how a
 * scanner ends up advertising +25,900%: three favorable hourly boundaries from
 * three different markets may have occurred at three different moments and may
 * never have been simultaneously executable.
 */
export interface SignalPriceModel {
  /**
   * DISCOVERY metric. The item's price in the starting currency taken from the
   * buy market, versus its price implied by (sell market -> return market),
   * with every leg at that market's completed-hour MIDPOINT. Gold is excluded.
   * This is the broad "same item, mispriced across two currencies" number.
   */
  twoLegSpreadPct: number;
  /**
   * POTENTIAL only. What the same path would return if every favorable posted
   * bid filled. Never executable profit, never used for ranking, and never
   * shown without its label. Present so the size of the hourly range is
   * visible, not so it can be multiplied into a headline.
   */
  targetBidPotentialPct: number;
  /**
   * The only figure that may be called a closed cycle: exact integer sizing at
   * the least-favorable observed boundary on all three legs, with all three
   * gold fees. Null when no independent return market was observed or no
   * integer sizing fits inside the observed hourly liquidity.
   */
  returnConfirmedCyclePct: number | null;
  /** Which price boundary produced `twoLegSpreadPct`. */
  discoveryBasis: "ggg-completed-hour-midpoint";
  /** True when returnConfirmedCyclePct came from an independently observed return market. */
  returnObserved: boolean;
}

/**
 * One executed step of the round trip, in the Exchange's own vocabulary:
 * you HAVE one thing and you WANT another. Quantities are exact integers.
 */
export interface SignalFlowStep {
  /** buy the item, sell it into the other hub, or convert back to the start. */
  action: "buy" | "sell" | "convert";
  haveUnits: number;
  haveCurrency: string;
  wantUnits: number;
  wantCurrency: string;
  /** Gold charged for this step, or null when the received item's fee is unverified. */
  goldCost: number | null;
}

/**
 * The complete round trip: start currency -> item -> other hub -> start
 * currency. This is the whole point of the product — a two-leg spread that
 * never converts back has not made anyone any Exalted — so the chain is
 * computed once here rather than reassembled by each consumer.
 *
 * `closesInStartCurrency` is false when no integer sizing closed the loop
 * inside the observed hourly liquidity. The steps still describe the path;
 * they just do not describe a completed trip, and net figures are null.
 */
export interface SignalFlow {
  steps: SignalFlowStep[];
  startCurrency: string;
  startUnits: number;
  finalUnits: number | null;
  /** finalUnits - startUnits, in the starting currency. The number that matters. */
  netUnits: number | null;
  netPct: number | null;
  /** Total gold across all three steps; null when any fee is unverified. */
  totalGold: number | null;
  /** Same total using the labeled category fallback for unverified fees. */
  estimatedTotalGold: number;
  closesInStartCurrency: boolean;
}

/**
 * Broad completed-hour market signal. Unlike `TwoLegFlip`, this record may
 * carry an unverified item gold fee. It is therefore a research/verification
 * signal, never an automatic TRADE NOW instruction.
 */
export interface MarketSignal {
  id: string;
  familyId: string;
  league: string;
  sourceHourUtc: string;
  item: FlipIdentity;
  buyCurrency: FlipIdentity;
  sellCurrency: FlipIdentity;
  buyLeg: FlipLeg & { goldVerified: boolean };
  sellLeg: FlipLeg & { goldVerified: boolean };
  returnLeg: (FlipLeg & { goldVerified: boolean }) | null;
  /** Ratios entered in game, always expressed as I WANT : I HAVE. */
  buyRatio: InGameRatio & { side: "conservative-hourly" };
  sellRatio: InGameRatio & { side: "conservative-hourly" };
  returnRatio: (InGameRatio & { side: "conservative-hourly" }) | null;
  /** Both completed-hour price boundaries, with no fabricated intermediate levels. */
  buyRatioRange: InGameRatioRange;
  sellRatioRange: InGameRatioRange;
  returnRatioRange: InGameRatioRange | null;
  /** Potential two-leg spread after valuing the sell currency back in start currency. */
  twoLegProfitPct: number;
  /** Exact integer three-leg result, when an independent direct return market exists. */
  closedCycleProfitPct: number | null;
  /** The three separated figures. `priceModel` is authoritative; the two fields
   *  above are the conservative subset retained for existing consumers. */
  priceModel: SignalPriceModel;
  /** How much of the equation this row has proven (see SignalClassification). */
  classification: SignalClassification;
  /** Human-readable form of `classification`, rendered verbatim in the Status column. */
  classificationLabel: string;
  /** The complete round trip as executable quantities, start currency to start currency. */
  flow: SignalFlow;
  /** Liquidity band from the order's share of the observed hour: <=5% / <=20% / above. */
  liquidityLabel: "Low" | "Medium" | "High";
  /** Midpoint-model Divine profit for the same starting quantity and gold basis. */
  spreadProfitDivine: number | null;
  /** Midpoint-model Divine profit per 100K gold. The single ranking metric. */
  spreadDivPer100kGold: number | null;
  /** Conservative closed-cycle Divine profit per 100K gold; null unless return-confirmed. */
  returnConfirmedDivPer100kGold: number | null;
  startingQuantity: number;
  finalStartingQuantity: number | null;
  totalGold: number | null;
  goldVerified: boolean;
  /** Known fees plus an explicitly disclosed fallback for unknown want-side fees. */
  estimatedTotalGold: number;
  estimatedGoldPerUnknownUnit: number | null;
  goldEstimateBasis: string | null;
  /** Closed-cycle profit converted with the completed-hour direct Divine quote. */
  estimatedProfitDivine: number | null;
  estimatedDivPer100kGold: number | null;
  itemHourlyVolume: number;
  maxVolumeShare: number;
  fillRisk: number;
  fillRiskLabel: "Low" | "Medium" | "High";
  ratioRangePct: number;
  recommendation: "VERIFY NOW" | "WATCH" | "HIGH RISK";
  warning: string | null;
}

/** A fully executable closed cycle: two item legs plus an observed return leg. */
export interface ClosedFlipCycle {
  id: string;
  familyId: string;
  league: string;
  sourceHourUtc: string;
  startCurrency: FlipIdentity;
  startingQuantity: number;
  item: FlipIdentity;
  /** Currency received when the item is sold on leg two. */
  sellCurrency: FlipIdentity;
  buyLeg: FlipLeg;
  sellLeg: FlipLeg;
  returnLeg: FlipLeg;
  legSourceHours: string[];
  finalStartingQuantity: number;
  leftoverStartingCurrency: number;
  netRealizedProfitStart: number;
  realizedProfitDivineEquivalent: number;
  conservativeRealizedProfitStart: number;
  conservativeRealizedProfitDivine: number;
  totalGold: number;
  tradeCount: 3;
  bottleneckVolume: number;
  maxVolumeShare: number;
  movementHaircutPct: number;
  marketImpactHaircutPct: number;
  realizedProfitPer100kGold: number;
  capitalRoiPct: number;
  executable: boolean;
  closed: true;
  rejectionReason: string | null;
}

/** Deterministic historical trend features for one flip family. */
export interface FlipTrend {
  change1hPct: number | null;
  change6hPct: number | null;
  change24hPct: number | null;
  change7dPct: number | null;
  rollingMedianDivPer100k: number | null;
  spreadPersistenceHours: number;
  volatilityPct: number | null;
  volumeChange24hPct: number | null;
  percentileVsHistory: number | null; // 0..100
  sampleHours: number;
  seasonalityTrained: boolean; // false until >= 2 weeks of hourly observations
  currentHourOfDayEt: number | null; // America/New_York hour of the source hour
  currentWeekdayEt: number | null; // 0=Sun..6=Sat America/New_York
}

export type RecommendationAction = "TRADE NOW" | "WATCH" | "WAIT" | "AVOID" | "INSUFFICIENT HISTORY";

export interface FlipRecommendation {
  action: RecommendationAction;
  /** Plain-English reasons, each tied to a deterministic feature. */
  reasons: string[];
  historyWindowHours: number;
  sampleCount: number;
  /** 0..1 level of support; seasonal statements are never guaranteed. */
  confidence: number;
  seasonalityActive: boolean;
}

/** One compact hourly observation of a flip family (retained, deterministic). */
export interface FlipHourlyObservation {
  familyId: string;
  league: string;
  sourceHourUtc: string;
  divPer100kGold: number;
  conservativeProfitDivine: number;
  goldRequired: number;
  lowestLegVolume: number;
  volumeShare: number;
  /** Direct observed rate for the first closed-cycle leg. */
  buyRate: number;
  /** Direct observed rate for the second closed-cycle leg. */
  sellRate: number;
  /** Direct observed rate for the independently observed return leg. */
  returnRate: number;
  /** Ordered [buy, sell, return] rates retained for complete-cycle history. */
  legRates: [number, number, number];
  buyPayUnits?: number;
  buyReceiveUnits?: number;
  sellPayUnits?: number;
  sellReceiveUnits?: number;
  returnPayUnits?: number;
  returnReceiveUnits?: number;
  buyGold?: number;
  sellGold?: number;
  returnGold?: number;
  buyVolumeFrom?: number;
  buyVolumeTo?: number;
  sellVolumeFrom?: number;
  sellVolumeTo?: number;
  returnVolumeFrom?: number;
  returnVolumeTo?: number;
  inputDivineValue: number;
  outputDivineValue: number;
  payloadSha256: string;
}
