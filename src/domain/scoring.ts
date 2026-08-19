// Conservative scoring: haircut raw profit for movement and market impact,
// then rank. All thresholds are configurable in RunSettings.
//
// Movement is decomposed into three independently-tracked terms so the audit
// and dashboard can label them honestly:
//   - ratio-range uncertainty (from the completed-hour low/high spread)
//   - temporal movement (null until real hourly history is retained)
//   - estimated market impact (separate risk term)
// No historical price is ever fabricated; temporal volatility is explicitly
// reported as "insufficient-history" until real source hours are retained.
//
// Expected profit is a monotone function of fill confidence:
//   expected = conservative + (gross - conservative) * confidence
// Increasing confidence can never reduce expected profit.

import type { DirectedEdge, Route, RouteLeg, RunSettings, ValuationDisclosure } from "./types.ts";
import type { EvaluatedRoute, RouteCandidate } from "./routes.ts";
import { valuationPath } from "./routes.ts";
import { validateCalculatedRoute } from "./invariants.ts";
import { opportunityId, routeFamilyId, disclosureForLegs } from "./identity.ts";

export interface ScoredFields {
  grossProfitBase: number;
  goldCostTotal: number;
  capitalRoiPct: number;
  movementHaircutPct: number;
  ratioRangeUncertaintyPct: number;
  temporalMovementPct: number | null;
  movementStatus: Route["movementStatus"];
  estimatedMarketImpactPct: number;
  conservativeProfitBase: number;
  fillConfidence: number;
  expectedProfitBase: number;
  profitPer1mGold: number;
  profitPerTrade: number;
  bottleneckVolumeShare: number;
  bottleneckEdgeKey: string;
  ratioRangePct: number;
  needsGoldVerification: boolean;
  /** Data captured once during scoring so route assembly is deterministic. */
  inputValuationPath: DirectedEdge[];
  outputValuationPath: DirectedEdge[];
  routeFamilyId: string;
  dataAgeHours: number;
}

export interface ScoringResult {
  route: RouteCandidate;
  score: number | null;
  fields: ScoredFields | null;
  rejection: string | null;
}

/** EWMA volatility from a sparse series of mid prices (returns per hour). */
export function ewmaVolatility(prices: number[], lambda = 0.94): number {
  if (prices.length < 2) return 0;
  let variance = 0;

  // robust MAD volatility to avoid outlier-driven values
  const diffs: number[] = [];
  for (let i = 1; i < prices.length; i++) {
    const previous = prices[i - 1]!;
    const current = prices[i]!;
    if (previous > 0 && current > 0) diffs.push(Math.log(current / previous));
  }
  if (diffs.length === 0) return 0;
  const med = diffs.slice().sort((a, b) => a - b)[Math.floor(diffs.length / 2)]!;
  const absDev = diffs.map((d) => Math.abs(d - med)).sort((a, b) => a - b);
  const mad = absDev[Math.floor(absDev.length / 2)]!;
  variance = (1.4826 * mad) ** 2;
  // EWMA over the squared deviations for persistence weighting
  let ew = variance;
  for (let i = 1; i < diffs.length; i++) {
    ew = lambda * ew + (1 - lambda) * diffs[i]! ** 2;
  }
  return Math.sqrt(ew);
}

/** Candidate route length in edges. */
export function legCount(c: RouteCandidate): number {
  return c.edges.length;
}

/**
 * Expected profit is monotone in confidence:
 *   expected = conservative + (gross - conservative) * confidence
 * At confidence 0 it equals the conservative haircut; at 1 it equals gross.
 * Always bounded: conservative <= expected <= gross.
 */
export function expectedProfit(conservative: number, gross: number, confidence: number): number {
  return conservative + (gross - conservative) * confidence;
}

/** Actual source age of a route in hours (now - source_hour), never the configured limit. */
export function sourceAgeHours(edges: DirectedEdge[], referenceMs: number): number {
  const sourceMs = Date.parse(edges[0]?.hourUtc ?? "");
  if (!Number.isFinite(sourceMs)) return Number.POSITIVE_INFINITY;
  return Math.max(0, (referenceMs - sourceMs) / 3_600_000);
}

/**
 * Evaluate + score a candidate route. Returns null score with a structured
 * rejection reason when any hard filter fails. `referenceTimeMs` is the
 * injected reference time used for actual source-age and freshness.
 */
export function scoreCandidate(
  c: RouteCandidate,
  ev: EvaluatedRoute,
  allEdges: DirectedEdge[],
  settings: RunSettings,
  referenceTimeMs: number = Date.now(),
): ScoringResult {
  const hard = hardFilters(c, ev, allEdges, settings, referenceTimeMs);
  if (hard) return { route: c, score: null, fields: null, rejection: hard };

  const used = new Set(c.edges.map((e) => e.key));
  const inputPath = c.edges[0]?.to === settings.baseCurrency
    ? [c.edges[0]]
    : valuationPath(c.startCurrency, settings.baseCurrency, allEdges, used);
  const startValue = inputPath === null
    ? null
    : inputPath.reduce((value, edge) => value * edge.rate, c.startUnits);
  if (startValue === null) {
    return { route: c, score: null, fields: null, rejection: "start currency not valued in base" };
  }
  const outputPath = valuationPath(c.endCurrency, settings.baseCurrency, allEdges, used);
  const endValue = outputPath === null
    ? null
    : outputPath.reduce((value, edge) => value * edge.rate, ev.endUnits);
  if (endValue === null) {
    return { route: c, score: null, fields: null, rejection: "end currency not valued in base" };
  }

  const grossProfitBase = endValue - startValue;
  const legs = ev.legs;
  const bottleneck = legs.reduce((a, b) => (b.volumeShare > a.volumeShare ? b : a));
  const rangePcts = legs.map((l, i) => {
    const e = c.edges[i]!;
    return e.rate > 0 ? ((e.rateHigh - e.rateLow) / e.rate) * 100 : 0;
  });
  const ratioRangePct = Math.max(...rangePcts, 0);

  // Movement decomposition. No fabricated price history: temporal movement is
  // null with an explicit status until real hourly history is wired in.
  const rangeHalf = ratioRangePct / 2;
  const impactCoefficient = 0.1; // 10% price impact per sqrt(volume share)
  const impactTerm = impactCoefficient * Math.sqrt(bottleneck.volumeShare) * 100;
  const estimatedMarketImpactPct = impactTerm;
  const temporalMovementPct: number | null = null; // insufficient history
  const movementStatus: Route["movementStatus"] = "insufficient-history";
  const movementHaircutPct = Math.max(rangeHalf, estimatedMarketImpactPct);

  const movementLoss = startValue * (movementHaircutPct / 100);
  const conservativeProfitBase = grossProfitBase - movementLoss;
  if (conservativeProfitBase <= settings.minConservativeProfitBase) {
    return {
      route: c,
      score: null,
      fields: null,
      rejection: `conservative profit ${conservativeProfitBase.toFixed(2)} <= min ${settings.minConservativeProfitBase}`,
    };
  }

  // fill confidence heuristic (labeled as an estimate)
  const volShare = Math.min(bottleneck.volumeShare, 1);
  const confidence = Math.max(0.05, Math.min(0.95, 0.9 - volShare * 0.8 - rangePcts.reduce((a, b) => a + b, 0) / 300));
  // Expected profit is monotone in confidence: higher confidence approaches
  // gross profit, lower confidence approaches the conservative haircut.
  const expectedProfitBase = expectedProfit(conservativeProfitBase, grossProfitBase, confidence);

  const profitPer1mGold = ev.goldTotal > 0 ? (conservativeProfitBase / ev.goldTotal) * 1_000_000 : 0;
  const profitPerTrade = conservativeProfitBase / legs.length;
  const capitalRoiPct = startValue > 0 ? (conservativeProfitBase / startValue) * 100 : 0;

  // freshness based on ACTUAL source age, not the configured maxDataAgeHours.
  const dataAgeHours = sourceAgeHours(c.edges, referenceTimeMs);
  const freshnessFactor = Math.max(0.1, 1 - dataAgeHours * 0.1);
  const persistenceFactor = 1; // Phase 0: no multi-hour history yet

  const denominator = Math.max(ev.goldTotal / 1_000_000, 0.01) * legs.length;
  const score = (expectedProfitBase / denominator) * freshnessFactor * persistenceFactor;

  const familyId = routeFamilyId(c.strategy, c.edges);
  const fields: ScoredFields = {
    grossProfitBase,
    goldCostTotal: ev.goldTotal,
    capitalRoiPct,
    movementHaircutPct,
    ratioRangeUncertaintyPct: ratioRangePct,
    temporalMovementPct,
    movementStatus,
    estimatedMarketImpactPct,
    conservativeProfitBase,
    fillConfidence: confidence,
    expectedProfitBase,
    profitPer1mGold,
    profitPerTrade,
    bottleneckVolumeShare: bottleneck.volumeShare,
    bottleneckEdgeKey: bottleneck.edgeKey,
    ratioRangePct,
    needsGoldVerification: false,
    inputValuationPath: inputPath ?? [],
    outputValuationPath: outputPath ?? [],
    routeFamilyId: familyId,
    dataAgeHours,
  };

  const calculatedRoute = routeFromScoring(c, ev, fields, c.edges, settings, score, referenceTimeMs);
  const invariant = validateCalculatedRoute({
    candidate: c,
    evaluated: ev,
    route: calculatedRoute,
    inputValueBase: startValue,
    outputValueBase: endValue,
    inputValuationPath: inputPath ?? [],
    outputValuationPath: outputPath ?? [],
  });
  if (invariant) return { route: c, score: null, fields: null, rejection: `${invariant.code}: ${invariant.message}` };

  return { route: c, score, fields, rejection: null };
}

/** Assemble the full Route object from a scored candidate. */
export function routeFromScoring(
  c: RouteCandidate,
  ev: EvaluatedRoute,
  f: ScoredFields,
  allEdges: DirectedEdge[],
  settings: RunSettings,
  score: number,
  referenceTimeMs: number = Date.now(),
): Route {
  const used = new Set(c.edges.map((e) => e.key));
  const inputPath = c.edges[0]?.to === settings.baseCurrency
    ? [c.edges[0]]
    : valuationPath(c.startCurrency, settings.baseCurrency, allEdges, used) ?? [];
  const outputPath = valuationPath(c.endCurrency, settings.baseCurrency, allEdges, used) ?? [];
  const league = settings.league;
  const sourceHourUtc = c.edges[0]?.hourUtc ?? "";
  const valuation = disclosureForLegs(inputPath, outputPath, [], false);
  return {
    id: opportunityId(f.routeFamilyId, league, sourceHourUtc, c.startUnits),
    routeFamilyId: f.routeFamilyId,
    strategy: c.strategy,
    startCurrency: c.startCurrency,
    endCurrency: c.endCurrency,
    hubCurrency: c.strategy === "two-leg-cross" ? c.edges[0]!.to : c.startCurrency,
    legs: ev.legs,
    startUnits: c.startUnits,
    endUnits: ev.endUnits,
    grossProfitBase: f.grossProfitBase,
    goldCostTotal: f.goldCostTotal,
    movementHaircutPct: f.movementHaircutPct,
    ratioRangeUncertaintyPct: f.ratioRangeUncertaintyPct,
    temporalMovementPct: f.temporalMovementPct,
    movementStatus: f.movementStatus,
    estimatedMarketImpactPct: f.estimatedMarketImpactPct,
    conservativeProfitBase: f.conservativeProfitBase,
    fillConfidence: f.fillConfidence,
    expectedProfitBase: f.expectedProfitBase,
    score,
    profitPer1mGold: f.profitPer1mGold,
    profitPerTrade: f.profitPerTrade,
    capitalRoiPct: f.capitalRoiPct,
    bottleneckVolumeShare: f.bottleneckVolumeShare,
    bottleneckEdgeKey: f.bottleneckEdgeKey,
    dataAgeHours: f.dataAgeHours,
    ratioRangePct: f.ratioRangePct,
    profitKind: valuation.profitKind,
    valuation,
  };
}

function hardFilters(
  c: RouteCandidate,
  ev: EvaluatedRoute,
  allEdges: DirectedEdge[],
  settings: RunSettings,
  referenceTimeMs: number,
): string | null {
  if (ev.error) return `route execution failed: ${ev.error}`;
  if (ev.legs.length !== c.edges.length) return "missing legs";
  if (ev.goldTotal > settings.goldBudget) return `gold ${ev.goldTotal} exceeds budget ${settings.goldBudget}`;

  const volumeCap = Math.min(settings.maxVolumeSharePct, 20) / 100;
  const bottleneck = ev.legs.reduce((a, b) => (b.volumeShare > a.volumeShare ? b : a));
  if (bottleneck.volumeShare > volumeCap) {
    return `bottleneck volume share ${(bottleneck.volumeShare * 100).toFixed(1)}% > cap ${(volumeCap * 100).toFixed(0)}%`;
  }
  for (const leg of ev.legs) {
    if (leg.toUnits <= 0) return "zero received units after integer rounding";
    if (leg.goldCost < 0) return "negative gold cost";
    if (!Number.isFinite(leg.volumeShare)) return "missing/zero volume denominator on a leg";
  }

  // Actual source-age filtering (never the configured limit as a freshness score).
  const dataAgeHours = sourceAgeHours(c.edges, referenceTimeMs);
  if (dataAgeHours > settings.maxDataAgeHours) {
    return `stale source: age ${dataAgeHours.toFixed(2)}h > max ${settings.maxDataAgeHours}h`;
  }

  const used = new Set(c.edges.map((e) => e.key));
  const inputPath = c.edges[0]?.to === settings.baseCurrency
    ? [c.edges[0]]
    : valuationPath(c.startCurrency, settings.baseCurrency, allEdges, used);
  const startValue = inputPath === null
    ? null
    : inputPath.reduce((value, edge) => value * edge.rate, c.startUnits);
  if (startValue === null) return "start currency unvalued";
  if (startValue <= 0) return "non-positive start value";

  // Movement-risk tolerance filter (movementRiskTolerancePct was previously unused).
  const rangePcts = ev.legs.map((l, i) => {
    const e = c.edges[i]!;
    return e.rate > 0 ? ((e.rateHigh - e.rateLow) / e.rate) * 100 : 0;
  });
  const ratioRangePct = Math.max(...rangePcts, 0);
  const rangeHalf = ratioRangePct / 2;
  const impactTerm = 0.1 * Math.sqrt(bottleneck.volumeShare) * 100;
  const movementHaircutPct = Math.max(rangeHalf, impactTerm);
  if (movementHaircutPct > settings.movementRiskTolerancePct) {
    return `movement risk ${movementHaircutPct.toFixed(2)}% > tolerance ${settings.movementRiskTolerancePct}%`;
  }
  return null;
}

/** Build the final Route database object from a scored candidate. */
export function toRoute(
  c: RouteCandidate,
  sc: ScoringResult,
  ev: EvaluatedRoute,
  hourUtc: string,
  allEdges: DirectedEdge[] = [],
  referenceTimeMs: number = Date.now(),
): Route | null {
  if (sc.score === null || !sc.fields) return null;
  return routeFromScoring(c, ev, sc.fields, allEdges, c.settings, sc.score, referenceTimeMs);
}

/**
 * The one true rank default: profit per 1M gold (conservative) then fewer legs,
 * matching the acceptance criteria. Direct sorts remain available downstream.
 */
export function rankDefault(a: Route, b: Route): number {
  if (b.profitPer1mGold !== a.profitPer1mGold) return b.profitPer1mGold - a.profitPer1mGold;
  return a.legs.length - b.legs.length;
}
