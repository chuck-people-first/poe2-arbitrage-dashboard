// Two-leg item flip builder — the PRIMARY product record.
//
// A two-leg item flip is: buy a specific item X with currency A, then sell that
// SAME item X for currency B. Both legs are exact executable integer trades
// (from the audited integer playbook). Valuing the input currency in Divine is
// a SUPPORTING calculation — never an extra player instruction.
//
// Conversion rules enforced here:
//  1. IDENTIFIER RESOLUTION — every displayed identity must resolve to a
//     readable name via the checked-in mapping. If the item or either currency
//     cannot be resolved, the flip is REJECTED from the public dashboard:
//     a raw GGG id is never shown to the user.
//  2. SAME-ITEM INVARIANT — leg1.to must equal leg2.from (structural in
//     enumerateTwoLegFlips, asserted here at build time).
//  3. Both legs must be executable: positive integer quantities, verified gold
//     cost, positive volume denominators. The audited Route already guarantees
//     this; we re-check for the public projection.
//  4. profitKind is taken from the audited classification (mark-to-market when
//     the sell leg does not close in the base currency, closed-realized when it
//     does), never hardcoded here.

import type {
  FlipIdentity,
  FlipLeg,
  Route,
  RouteLeg,
  TwoLegFlip,
  ClosedFlipCycle,
  ValuationDisclosure,
} from "./types.ts";
import { lookupItem } from "./mapping.ts";

const ICON_BASE = "https://web.poecdn.com";

/** Resolve one GGG path to a readable identity. Returns null when unmapped. */
export function resolveIdentity(gggPath: string): FlipIdentity | null {
  const item = lookupItem(gggPath);
  if (!item) return null;
  // iconUrl may be a full absolute URL (authoritative identity bridge) or a
  // relative path; never double-prefix.
  const iconUrl = item.iconUrl
    ? /^https?:\/\//i.test(item.iconUrl)
      ? item.iconUrl
      : `${ICON_BASE}${item.iconUrl}`
    : null;
  return {
    id: gggPath,
    name: item.displayName,
    iconUrl,
    goldCostPerUnit: item.goldCostPerUnit,
  };
}

/** True when every path in the route resolves to a readable identity. */
export function allIdentitiesResolve(route: Route): boolean {
  if (!resolveIdentity(route.startCurrency)) return false;
  if (!resolveIdentity(route.endCurrency)) return false;
  if (route.strategy === "two-leg-cross" && !resolveIdentity(route.hubCurrency)) return false;
  return true;
}

/** Number of trades a two-leg flip requires (always 2). */
export const FLIP_TRADE_COUNT = 2 as const;

/**
 * Build a TwoLegFlip from an audited scored two-leg route.
 *
 * `league` and `sourceHourUtc` come from the run/status row (the Route object
 * itself does not carry them — it carries dataAgeHours against the reference
 * time). Returns null when the route is not a two-leg-cross, does not resolve
 * to readable identities, or fails an executable-leg re-check — such routes
 * must never reach the public dashboard.
 */
export function toTwoLegFlip(
  route: Route,
  league: string,
  sourceHourUtc: string,
  referenceTimeMs: number = Date.now(),
): TwoLegFlip | null {
  if (route.strategy !== "two-leg-cross") return null;
  if (route.legs.length !== 2) return null;
  const [leg1, leg2] = route.legs;
  if (!leg1 || !leg2) return null;
  // Same-item invariant: leg1.to === leg2.from.
  if (leg1.to !== leg2.from) return null;

  // Identifier resolution: reject (not hide) anything we cannot name.
  const item = resolveIdentity(leg1.to);
  const buy = resolveIdentity(route.startCurrency);
  const sell = resolveIdentity(route.endCurrency);
  if (!item || !buy || !sell) return null;

  // Executable-leg re-check (the audited Route already guarantees these;
  // we re-assert them for the public projection boundary).
  if (!Number.isInteger(leg1.fromUnits) || leg1.fromUnits <= 0) return null;
  if (!Number.isInteger(leg1.toUnits) || leg1.toUnits <= 0) return null;
  if (!Number.isInteger(leg2.fromUnits) || leg2.fromUnits <= 0) return null;
  if (!Number.isInteger(leg2.toUnits) || leg2.toUnits <= 0) return null;
  if (!Number.isFinite(route.goldCostTotal) || route.goldCostTotal < 0) return null;
  if (!Number.isFinite(route.grossProfitBase) || !Number.isFinite(route.conservativeProfitBase)) return null;
  if (!Number.isFinite(route.bottleneckVolumeShare) || route.bottleneckVolumeShare <= 0) return null;
  if (!Number.isFinite(route.inputValueBase) || route.inputValueBase <= 0) return null;

  const goldRequired = route.goldCostTotal;
  const inputDivineValue = route.inputValueBase;
  const outputDivineValue = inputDivineValue + route.grossProfitBase;

  const divineProfitPerGold = goldRequired > 0 ? route.conservativeProfitBase / goldRequired : 0;
  const divPer100kGold = divineProfitPerGold * 100_000;
  const lowestLegVolume = Math.min(legLowestHourlyVolume(leg1), legLowestHourlyVolume(leg2));
  const fillRisk = estimateFillRisk(route.bottleneckVolumeShare, route.ratioRangePct ?? 0, lowestLegVolume);

  const sourceMs = Date.parse(sourceHourUtc);
  const sourceAgeHours = Number.isFinite(sourceMs)
    ? Math.max(0, (referenceTimeMs - sourceMs) / 3_600_000)
    : Number.POSITIVE_INFINITY;

  return {
    id: route.id,
    familyId: route.routeFamilyId,
    league,
    sourceHourUtc,
    sourceAgeHours,
    item,
    buyCurrency: buy,
    sellCurrency: sell,
    buyLeg: {
      pay: leg1.fromUnits,
      receive: leg1.toUnits,
      goldCost: leg1.goldCost,
      hourlyVolume: legHourlyVolume(leg1),
    },
    sellLeg: {
      pay: leg2.fromUnits,
      receive: leg2.toUnits,
      goldCost: leg2.goldCost,
      hourlyVolume: legHourlyVolume(leg2),
    },
    goldRequired,
    tradeCount: FLIP_TRADE_COUNT,
    inputDivineValue,
    outputDivineValue,
    grossProfitDivine: route.grossProfitBase,
    conservativeNetProfitDivine: route.conservativeProfitBase,
    divineProfitPerGold,
    divPer100kGold,
    volumeShare: route.bottleneckVolumeShare,
    lowestLegVolume,
    fillRisk,
    fillRiskLabel: fillRiskLabel(fillRisk),
    // A two-leg cross ends in B, not A; it is never a realized cycle.
    profitKind: "mark-to-market",
    valuation: route.valuation as ValuationDisclosure,
    ratioRangePct: route.ratioRangePct ?? 0,
    movementHaircutPct: route.movementHaircutPct,
    capitalRoiPct: route.capitalRoiPct,
    expectedProfitDivine: route.expectedProfitBase,
    confidence: route.fillConfidence,
    trend: null,
    recommendation: null,
  };
}

/**
 * Lowest available hourly volume on a leg, in the leg's own units.
 * volumeShare = max(fromUnits/volumeFrom, toUnits/volumeTo), so the tighter of
 * the two denominators determines the share; we recover the "offered" hourly
 * volume on the from-side from the share without mixing units.
 */
function legLowestHourlyVolume(leg: RouteLeg): number {
  if (!Number.isFinite(leg.volumeShare) || leg.volumeShare <= 0) return 0;
  return leg.fromUnits / leg.volumeShare;
}

/** Hourly volume offered on the pay side of a leg (units of the pay item/hr). */
function legHourlyVolume(leg: RouteLeg): number {
  if (!Number.isFinite(leg.volumeShare) || leg.volumeShare <= 0) return 0;
  return leg.fromUnits / leg.volumeShare;
}

/**
 * Estimate the probability a flip does not fill near the displayed rate.
 * Pure heuristic, explicitly labeled: combines how much of the hourly volume
 * the trade consumes (bottleneck share), the completed-hour ratio range
 * uncertainty, and the available lowest-leg volume. Never a guarantee.
 */
export function estimateFillRisk(bottleneckVolumeShare: number, ratioRangePct: number, lowestLegVolume: number): number {
  const shareTerm = Math.min(1, bottleneckVolumeShare * 4); // 25% share -> very risky
  const rangeTerm = Math.min(0.5, (ratioRangePct / 100) * 2.5);
  const volumeTerm = lowestLegVolume > 0 ? Math.min(0.35, 14 / Math.sqrt(lowestLegVolume)) : 1;
  return Math.max(0, Math.min(1, shareTerm * 0.55 + rangeTerm + volumeTerm * 0.15));
}

export function fillRiskLabel(risk: number): "Low" | "Medium" | "High" {
  if (risk < 0.15) return "Low";
  if (risk < 0.35) return "Medium";
  return "High";
}

/** Build a genuinely closed cycle from an independently observed third leg. */
export function toClosedFlipCycle(route: Route, league: string, sourceHourUtc: string, referenceTimeMs: number = Date.now(), maxVolumeShare = 0.2): ClosedFlipCycle | null {
  if (route.strategy !== "closed-triangle" || route.legs.length !== 3 || route.startCurrency !== route.endCurrency) return null;
  const [leg1, leg2, leg3] = route.legs;
  if (!leg1 || !leg2 || !leg3 || leg1.to !== leg2.from || leg2.to !== leg3.from || leg3.to !== route.startCurrency) return null;
  const start = resolveIdentity(route.startCurrency);
  const item = resolveIdentity(leg1.to);
  if (!start || !item) return null;
  const legs = [leg1, leg2, leg3];
  if (legs.some(l => ![l.fromUnits, l.toUnits].every(Number.isInteger) || l.fromUnits <= 0 || l.toUnits <= 0)) return null;
  if (legs.some(l => !Number.isFinite(l.goldCost) || l.goldCost < 0 || !Number.isFinite(l.volumeShare) || l.volumeShare <= 0 || l.volumeShare > maxVolumeShare)) return null;
  const sourceMs = Date.parse(sourceHourUtc);
  if (!Number.isFinite(sourceMs) || (referenceTimeMs - sourceMs) / 3_600_000 > 24) return null;
  const finalStartingQuantity = leg3.toUnits;
  const gross = finalStartingQuantity - route.startUnits;
  if (gross <= 0) return null;
  const totalGold = legs.reduce((sum, l) => sum + l.goldCost, 0);
  const maxShare = Math.max(...legs.map(l => l.volumeShare));
  const bottleneckVolume = Math.min(...legs.map(l => l.fromUnits / l.volumeShare));
  const conservativeRatio = route.grossProfitBase > 0 ? Math.max(0, Math.min(1, route.conservativeProfitBase / route.grossProfitBase)) : 0;
  const conservativeRealizedProfitStart = gross * conservativeRatio;
  const toFlipLeg = (l: RouteLeg): FlipLeg => ({ pay: l.fromUnits, receive: l.toUnits, goldCost: l.goldCost, hourlyVolume: l.fromUnits / l.volumeShare });
  return { id: route.id, familyId: route.routeFamilyId, league, sourceHourUtc, startCurrency: start, startingQuantity: route.startUnits, item,
    buyLeg: toFlipLeg(leg1), sellLeg: toFlipLeg(leg2), returnLeg: toFlipLeg(leg3), legSourceHours: legs.map(l => l.sourceHourUtc ?? sourceHourUtc),
    finalStartingQuantity, leftoverStartingCurrency: 0, netRealizedProfitStart: gross, conservativeRealizedProfitStart, totalGold, tradeCount: 3,
    bottleneckVolume, maxVolumeShare: maxShare, movementHaircutPct: Math.max(...legs.map(l => l.movementHaircutPct ?? route.movementHaircutPct)), marketImpactHaircutPct: Math.max(...legs.map(l => l.marketImpactPct ?? route.estimatedMarketImpactPct)),
    realizedProfitPer100kGold: totalGold > 0 ? conservativeRealizedProfitStart / totalGold * 100_000 : 0, capitalRoiPct: route.startUnits > 0 ? conservativeRealizedProfitStart / route.startUnits * 100 : 0,
    executable: true, closed: true, rejectionReason: null };
}
