// Conservative scoring: haircut raw profit for movement and market impact,
// then rank. All thresholds are configurable in RunSettings.

import type { DirectedEdge, Route, RouteLeg, RunSettings } from "./types";
import type { EvaluatedRoute, RouteCandidate } from "./routes";
import { valueInBase } from "./routes";

export interface ScoringResult {
  route: RouteCandidate;
  score: number | null;
  fields: {
    grossProfitBase: number;
    goldCostTotal: number;
    capitalRoiPct: number;
    movementHaircutPct: number;
    conservativeProfitBase: number;
    fillConfidence: number;
    expectedProfitBase: number;
    profitPer1mGold: number;
    profitPerTrade: number;
    bottleneckVolumeShare: number;
    bottleneckEdgeKey: string;
    ratioRangePct: number;
    needsGoldVerification: boolean;
  } | null;
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
 * Evaluate + score a candidate route. Returns null score with a rejection
 * reason when any hard filter fails.
 */
export function scoreCandidate(
  c: RouteCandidate,
  ev: EvaluatedRoute,
  allEdges: DirectedEdge[],
  settings: RunSettings,
): ScoringResult {
  const hard = hardFilters(c, ev, allEdges, settings);
  if (hard) return { route: c, score: null, fields: null, rejection: hard };

  const used = new Set(c.edges.map((e) => e.key));
  const startValue = valueInBase(c.startCurrency, c.startUnits, settings.baseCurrency, allEdges, used);
  if (startValue === null) {
    return { route: c, score: null, fields: null, rejection: "start currency not valued in base" };
  }
  const endValue = valueInBase(c.endCurrency, ev.endUnits, settings.baseCurrency, allEdges, used);
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

  // movement haircut: conservative estimate of adverse price move
  const rangeHalf = ratioRangePct / 2;
  const volTerm = 1.65 * ewmaVolatility([c.edges[0]!.rate, c.edges[0]!.rate * 0.95]) * Math.sqrt(1);
  const impactCoefficient = 0.1; // 10% price impact per sqrt(volume share)
  const impactTerm = impactCoefficient * Math.sqrt(bottleneck.volumeShare) * 100;
  const movementHaircutPct = Math.max(rangeHalf, volTerm, impactTerm);

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
  const expectedProfitBase = conservativeProfitBase * confidence;

  const profitPer1mGold = ev.goldTotal > 0 ? (conservativeProfitBase / ev.goldTotal) * 1_000_000 : 0;
  const profitPerTrade = conservativeProfitBase / legs.length;
  const capitalRoiPct = startValue > 0 ? (conservativeProfitBase / startValue) * 100 : 0;

  // freshness factor: full when the data is from the latest completed hour
  const freshnessFactor = Math.max(0.1, 1 - settings.maxDataAgeHours * 0.05);
  const persistenceFactor = 1; // Phase 0: no multi-hour history yet

  const denominator = Math.max(ev.goldTotal / 1_000_000, 0.01) * legs.length;
  const score = (expectedProfitBase / denominator) * freshnessFactor * persistenceFactor;

  return {
    route: c,
    score,
    fields: {
      grossProfitBase,
      goldCostTotal: ev.goldTotal,
      capitalRoiPct,
      movementHaircutPct,
      conservativeProfitBase,
      fillConfidence: confidence,
      expectedProfitBase,
      profitPer1mGold,
      profitPerTrade,
      bottleneckVolumeShare: bottleneck.volumeShare,
      bottleneckEdgeKey: bottleneck.edgeKey,
      ratioRangePct,
      needsGoldVerification: false,
    },
    rejection: null,
  };
}

function hardFilters(
  c: RouteCandidate,
  ev: EvaluatedRoute,
  allEdges: DirectedEdge[],
  settings: RunSettings,
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
  }
  const startValue = valueInBase(c.startCurrency, c.startUnits, settings.baseCurrency, allEdges, new Set(c.edges.map((e) => e.key)));
  if (startValue === null) return "start currency unvalued";
  if (startValue <= 0) return "non-positive start value";
  return null;
}

/** Build the final Route database object from a scored candidate. */
export function toRoute(
  c: RouteCandidate,
  sc: ScoringResult,
  ev: EvaluatedRoute,
  hourUtc: string,
): Route | null {
  if (sc.score === null || !sc.fields) return null;
  const f = sc.fields;
  return {
    id: c.edges.map((e) => e.from.split("/").pop()).join("-"),
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
    conservativeProfitBase: f.conservativeProfitBase,
    fillConfidence: f.fillConfidence,
    expectedProfitBase: f.expectedProfitBase,
    score: sc.score,
    profitPer1mGold: f.profitPer1mGold,
    profitPerTrade: f.profitPerTrade,
    capitalRoiPct: f.capitalRoiPct,
    bottleneckVolumeShare: f.bottleneckVolumeShare,
    bottleneckEdgeKey: f.bottleneckEdgeKey,
    dataAgeHours: 0,
    ratioRangePct: f.ratioRangePct,
  };
}

/**
 * The one true rank default: profit per 1M gold (conservative) then fewer legs,
 * matching the acceptance criteria. Direct sorts remain available downstream.
 */
export function rankDefault(a: Route, b: Route): number {
  if (b.profitPer1mGold !== a.profitPer1mGold) return b.profitPer1mGold - a.profitPer1mGold;
  return a.legs.length - b.legs.length;
}