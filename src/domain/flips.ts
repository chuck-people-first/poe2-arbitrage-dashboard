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
  ValuationDisclosure,
} from "./types.ts";
import { lookupItem } from "./mapping.ts";

const ICON_BASE = "https://web.poecdn.com";

/** Resolve one GGG path to a readable identity. Returns null when unmapped. */
export function resolveIdentity(gggPath: string): FlipIdentity | null {
  const item = lookupItem(gggPath);
  if (!item) return null;
  return {
    id: gggPath,
    name: item.displayName,
    iconUrl: item.iconUrl ? `${ICON_BASE}${item.iconUrl}` : null,
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

  const divPer100kGold = goldRequired > 0 ? (route.conservativeProfitBase / goldRequired) * 100_000 : 0;
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
    divPer100kGold,
    volumeShare: route.bottleneckVolumeShare,
    lowestLegVolume,
    fillRisk,
    fillRiskLabel: fillRiskLabel(fillRisk),
    profitKind: route.profitKind,
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