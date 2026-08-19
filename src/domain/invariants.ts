import type { DirectedEdge, Route, RouteLeg } from "./types.ts";
import type { EvaluatedRoute, RouteCandidate } from "./routes.ts";

export interface MathInvariantViolation {
  code: string;
  message: string;
}

export interface MathInvariantInput {
  candidate: RouteCandidate;
  evaluated: EvaluatedRoute;
  route: Route;
  inputValueBase: number;
  outputValueBase: number;
  inputValuationPath: DirectedEdge[];
  outputValuationPath: DirectedEdge[];
}

const finitePositive = (value: number) => Number.isFinite(value) && value > 0;
const positiveInteger = (value: number) => Number.isInteger(value) && value > 0;

/** Runtime release-gate checks for every route that reaches persistence. */
export function validateCalculatedRoute(input: MathInvariantInput): MathInvariantViolation | null {
  const { candidate, evaluated, route } = input;
  if (!finitePositive(input.inputValueBase) || !Number.isFinite(input.outputValueBase)) {
    return { code: "INVALID_VALUATION", message: "input/output valuation is missing or non-finite" };
  }
  if (!positiveInteger(candidate.startUnits) || !positiveInteger(route.endUnits)) {
    return { code: "INVALID_QUANTITY", message: "route quantities must be positive integers" };
  }
  if (candidate.strategy === "closed-triangle" && candidate.endCurrency !== candidate.startCurrency) {
    return { code: "NOT_CLOSED", message: "closed loop does not finish in its starting currency" };
  }
  if (candidate.edges.some((edge) => edge.source !== "ggg-hourly" && edge.source !== "live-confirmed" && edge.source !== "manual-override")) {
    return { code: "INVALID_OBSERVATION", message: "leg has no valid observed source" };
  }
  if (candidate.edges.some((edge) => !finitePositive(edge.rate) || !finitePositive(edge.hourlyVolume))) {
    return { code: "INVALID_EDGE", message: "leg contains a missing, zero, NaN, or infinite rate/divisor" };
  }
  if (evaluated.legs.some((leg) => !positiveInteger(leg.fromUnits) || !positiveInteger(leg.toUnits))) {
    return { code: "INVALID_LEG_QUANTITY", message: "Exchange quantities must be positive integers" };
  }
  if (input.inputValuationPath.length === 0 && candidate.startCurrency !== candidate.settings.baseCurrency) {
    return { code: "MISSING_INPUT_PATH", message: "input currency has no independent base valuation path" };
  }
  if (input.outputValuationPath.length === 0 && candidate.endCurrency !== candidate.settings.baseCurrency) {
    return { code: "MISSING_OUTPUT_PATH", message: "output currency has no independent base valuation path" };
  }
  const gross = input.outputValueBase - input.inputValueBase;
  if (Math.abs(route.grossProfitBase - gross) > 1e-8) {
    return { code: "GROSS_MISMATCH", message: "output value minus input value does not equal gross profit" };
  }
  if (route.conservativeProfitBase <= 0) {
    return { code: "NON_POSITIVE_CONSERVATIVE", message: "gold, movement, or rounding eliminates conservative profit" };
  }
  if (route.dataAgeHours > candidate.settings.maxDataAgeHours) {
    return { code: "STALE_OBSERVATION", message: "route source is older than the configured maximum age" };
  }
  if (route.bottleneckVolumeShare > Math.min(candidate.settings.maxVolumeSharePct, 20) / 100) {
    return { code: "VOLUME_CAP", message: "bottleneck exceeds the 20% default hard ceiling" };
  }
  if (route.conservativeProfitBase > route.expectedProfitBase + 1e-8 || route.expectedProfitBase > route.grossProfitBase + 1e-8) {
    return { code: "PROFIT_ORDER", message: "conservative profit <= expected profit <= gross profit invariant failed" };
  }
  if (Math.abs(route.capitalRoiPct - route.conservativeProfitBase / input.inputValueBase * 100) > 1e-8) {
    return { code: "ROI_MISMATCH", message: "ROI does not equal conservative profit divided by input value" };
  }
  if (Math.abs(route.profitPerTrade - route.conservativeProfitBase / route.legs.length) > 1e-8) {
    return { code: "TRADE_PROFIT_MISMATCH", message: "profit per trade uses the wrong trade count" };
  }
  if (Math.abs(route.profitPer1mGold - route.conservativeProfitBase / route.goldCostTotal * 1_000_000) > 1e-8) {
    return { code: "GOLD_PROFIT_MISMATCH", message: "profit per 1M gold uses the wrong gold divisor" };
  }
  const goldSum = route.legs.reduce((sum, leg) => sum + leg.goldCost, 0);
  if (goldSum !== route.goldCostTotal) {
    return { code: "GOLD_SUM_MISMATCH", message: "total gold is not the sum of leg gold costs" };
  }
  const bottleneck = route.legs.reduce((a, b) => b.volumeShare > a.volumeShare ? b : a);
  if (Math.abs(route.bottleneckVolumeShare - bottleneck.volumeShare) > 1e-8) {
    return { code: "BOTTLENECK_MISMATCH", message: "volume share is not based on the bottleneck leg" };
  }
  return null;
}
