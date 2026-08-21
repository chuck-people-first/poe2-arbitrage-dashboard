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
//
// Valuation-path risk (item 4): the input and output reference paths that
// value the route in base currency are independently vetted for liquidity.
// A valuation path whose unit-safe bottleneck share exceeds the volume ceiling,
// or that has missing/zero volume or non-finite/non-positive rates, silently
// inflates value — so the route is REJECTED rather than relied upon.
//
// Profit classification (item 5): routes are classified by what they actually
// close (mark-to-market vs closed-realized), never hardcoded.

import type { DirectedEdge, ProfitClass, ProfitKind, Route, RouteLeg, RunSettings, ValuationDisclosure } from "./types.ts";
import type { EvaluatedRoute, RouteCandidate } from "./routes.ts";
import { valuationPath } from "./routes.ts";
import { validateCalculatedRoute } from "./invariants.ts";
import { opportunityId, routeFamilyId, disclosureForLegs } from "./identity.ts";

export interface ScoredFields {
  grossProfitBase: number;
  /** Input value in base currency (start units converted). */
  inputValueBase: number;
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
  divineProfitPerGold: number;
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
  // valuation-path risk (item 4)
  valuationBottleneckVolumeShare: number;
  valuationRangeUncertaintyPct: number;
  valuationConfidence: number;
  valuationExecutable: boolean;
  valuationGoldIncluded: boolean;
  valuationTradeCountIncluded: number;
  // classification (item 5)
  profitClass: ProfitClass;
  realizedCurrency: string | null;
  realizedProfitStart: number | null;
  realizedProfitBase: number | null;
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

interface ValuationRisk {
  bottleneckShare: number;
  rangeUncertaintyPct: number;
  confidence: number;
  rejection: string | null;
}

/**
 * Unit-safe liquidity/risk of the combined input+output valuation paths.
 * Every valuation hop is vetted: finite positive rates, present positive
 * volumes (in both denominations), a unit-correct notional share no greater
 * than the volume ceiling, and a ratio-range term. A path that cannot support
 * the required notional (bottleneck share > ceiling) is REJECTED.
 */
export function valuationRisk(
  inputPath: DirectedEdge[],
  outputPath: DirectedEdge[],
  startNotional: number,
  endNotional: number,
  settings: RunSettings,
): ValuationRisk {
  const ceiling = Math.min(settings.maxVolumeSharePct, 20) / 100;
  const shares: number[] = [];
  const ranges: number[] = [];

  const walk = (path: DirectedEdge[], notional: number): void => {
    let value = notional;
    for (const e of path) {
      if (!Number.isFinite(e.rate) || e.rate <= 0) throw new Error("valuation path has non-finite or non-positive rate");
      if (!(e.volumeFrom > 0) || !(e.volumeTo > 0)) throw new Error("valuation path reference market has missing or zero volume");
      const fromShare = value / e.volumeFrom;
      const toShare = (value * e.rate) / e.volumeTo;
      shares.push(Math.max(fromShare, toShare));
      ranges.push(e.rate > 0 ? ((e.rateHigh - e.rateLow) / e.rate) * 100 : 0);
      value *= e.rate;
    }
  };

  walk(inputPath, startNotional);
  walk(outputPath, endNotional);

  if (shares.length === 0) {
    return { bottleneckShare: 0, rangeUncertaintyPct: 0, confidence: 1, rejection: null };
  }
  const bottleneckShare = Math.max(...shares);
  const rangeUncertaintyPct = Math.max(...ranges, 0);
  if (bottleneckShare > ceiling) {
    return {
      bottleneckShare,
      rangeUncertaintyPct,
      confidence: 0,
      rejection: `valuation path bottleneck volume share ${(bottleneckShare * 100).toFixed(1)}% > cap ${(ceiling * 100).toFixed(0)}%`,
    };
  }
  const confidence = Math.max(0.05, Math.min(0.95, 0.9 - bottleneckShare * 0.8 - rangeUncertaintyPct / 300));
  return { bottleneckShare, rangeUncertaintyPct, confidence, rejection: null };
}

/** Classify a route by what it actually closes (item 5). */
export function classifyRoute(c: RouteCandidate): {
  profitClass: ProfitClass;
  profitKind: ProfitKind;
  realizedCurrency: string | null;
} {
  if (c.endCurrency === c.startCurrency) {
    // closed loop returning to the STARTING currency (may differ from base)
    return { profitClass: "closed-realized", profitKind: "closed-realized", realizedCurrency: c.startCurrency };
  }
  // A two-leg cross ending in the display base is still not closed when it
  // started in another currency. The player must execute an independently
  // observed return conversion (and pay its gold) before profit is realized.
  return { profitClass: "mark-to-market", profitKind: "mark-to-market", realizedCurrency: null };
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

  // Valuation-path liquidity vetted BEFORE treating the reference as reliable.
  let valRisk: ValuationRisk;
  try {
    valRisk = valuationRisk(inputPath ?? [], outputPath ?? [], c.startUnits, ev.endUnits, settings);
  } catch (error) {
    return { route: c, score: null, fields: null, rejection: error instanceof Error ? error.message : String(error) };
  }
  if (valRisk.rejection) {
    return { route: c, score: null, fields: null, rejection: valRisk.rejection };
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

  const divineProfitPerGold = ev.goldTotal > 0 ? conservativeProfitBase / ev.goldTotal : 0;
  const profitPerTrade = conservativeProfitBase / legs.length;
  const capitalRoiPct = startValue > 0 ? (conservativeProfitBase / startValue) * 100 : 0;

  // freshness based on ACTUAL source age, not the configured maxDataAgeHours.
  const dataAgeHours = sourceAgeHours(c.edges, referenceTimeMs);
  const freshnessFactor = Math.max(0.1, 1 - dataAgeHours * 0.1);
  const persistenceFactor = 1; // Phase 0: no multi-hour history yet

  const denominator = Math.max(ev.goldTotal, 0.01) * legs.length;
  const score = (expectedProfitBase / denominator) * freshnessFactor * persistenceFactor;

  const familyId = routeFamilyId(c.strategy, c.edges);

  // Classification (item 5).
  const cls = classifyRoute(c);
  let realizedProfitStart: number | null = null;
  let realizedProfitBase: number | null = null;
  if (cls.realizedCurrency && cls.realizedCurrency === c.startCurrency && c.startCurrency !== settings.baseCurrency) {
    // closed in the STARTING currency, which differs from the display base:
    // expose the closed profit in start units AND its mark-to-market base equiv.
    realizedProfitStart = ev.endUnits - c.startUnits;
    realizedProfitBase = grossProfitBase;
  }

  const valuationTradeCountIncluded = 0; // Phase 0: no separate return-to-base conversion legs selected
  const valuationExecutable = cls.profitClass === "closed-realized";

  const fields: ScoredFields = {
      grossProfitBase,
      inputValueBase: startValue,
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
    divineProfitPerGold,
    profitPerTrade,
    bottleneckVolumeShare: bottleneck.volumeShare,
    bottleneckEdgeKey: bottleneck.edgeKey,
    ratioRangePct,
    needsGoldVerification: false,
    inputValuationPath: inputPath ?? [],
    outputValuationPath: outputPath ?? [],
    routeFamilyId: familyId,
    dataAgeHours,
    valuationBottleneckVolumeShare: valRisk.bottleneckShare,
    valuationRangeUncertaintyPct: valRisk.rangeUncertaintyPct,
    valuationConfidence: valRisk.confidence,
    valuationExecutable,
    valuationGoldIncluded: false,
    valuationTradeCountIncluded,
    profitClass: cls.profitClass,
    realizedCurrency: cls.realizedCurrency,
    realizedProfitStart,
    realizedProfitBase,
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
  const cls = classifyRoute(c);
  const returnToBaseLegs: DirectedEdge[] = [];
  const valuation = disclosureForLegs(inputPath, outputPath, returnToBaseLegs, false, cls.profitKind, {
    valuationBottleneckVolumeShare: f.valuationBottleneckVolumeShare,
    valuationRangeUncertaintyPct: f.valuationRangeUncertaintyPct,
    valuationConfidence: f.valuationConfidence,
    valuationExecutable: f.valuationExecutable,
    valuationTradeCountIncluded: f.valuationTradeCountIncluded,
  });
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
      inputValueBase: f.inputValueBase,
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
    divineProfitPerGold: f.divineProfitPerGold,
    profitPerTrade: f.profitPerTrade,
    capitalRoiPct: f.capitalRoiPct,
    bottleneckVolumeShare: f.bottleneckVolumeShare,
    bottleneckEdgeKey: f.bottleneckEdgeKey,
    dataAgeHours: f.dataAgeHours,
    ratioRangePct: f.ratioRangePct,
    profitKind: cls.profitKind,
    profitClass: cls.profitClass,
    realizedCurrency: cls.realizedCurrency,
    realizedProfitStart: f.realizedProfitStart,
    realizedProfitBase: f.realizedProfitBase,
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
 * The one true rank default: profit per Divine per Gold (conservative) then fewer legs,
 * matching the acceptance criteria. Direct sorts remain available downstream.
 */
export function rankDefault(a: Route, b: Route): number {
  if (b.divineProfitPerGold !== a.divineProfitPerGold) return b.divineProfitPerGold - a.divineProfitPerGold;
  return a.legs.length - b.legs.length;
}
