// Broad two-leg market discovery for the product-facing Market Scanner.
//
// This intentionally has a different trust boundary from scored opportunities:
// - names/icons must resolve authoritatively;
// - every price leg is an independently observed GGG completed-hour market;
// - unknown gold is shown as unknown, never guessed or treated as zero;
// - TRADE NOW remains reserved for fully executable, closed scored cycles.

import { conflictsWith } from "./edges.ts";
import { estimateFillRisk, fillRiskLabel, resolveIdentity } from "./flips.ts";
import { sha256Hex } from "./identity.ts";
import { estimatedGoldCostPerUnit, GGG_HUB_PATHS, goldCostPerUnit } from "./mapping.ts";
import type { OpportunityRow } from "./opportunity.ts";
import type { DirectedEdge, InGameRatio, InGameRatioRange, MarketSignal, Route, RouteLeg, RunSettings, ValuationDisclosure } from "./types.ts";

const OUTPUT_TARGETS = [1, 2, 5, 10, 25, 50, 100, 250, 500] as const;

function share(edge: DirectedEdge, fromUnits: number, toUnits: number): number {
  const a = edge.volumeFrom > 0 ? fromUnits / edge.volumeFrom : Number.POSITIVE_INFINITY;
  const b = edge.volumeTo > 0 ? toUnits / edge.volumeTo : Number.POSITIVE_INFINITY;
  return Math.max(a, b);
}

function rangePct(edge: DirectedEdge): number {
  return edge.rate > 0 ? Math.abs(edge.rateHigh - edge.rateLow) / edge.rate * 100 : 100;
}

/**
 * The GGG feed is an hourly aggregate, not a live order book. `rateHigh` is
 * merely the most favorable trade seen somewhere in that hour. Combining the
 * high from three different markets manufactures a best-case cycle that may
 * never have existed at one moment.
 *
 * Size and price scanner ideas from the least-favorable observed boundary.
 * This makes the completed-hour signal conservative; the player must still
 * confirm the current book before posting an order.
 */
function planningRate(edge: DirectedEdge): number {
  return edge.rateLow;
}

/** Normalize one rate to the Currency Exchange's visible I WANT : I HAVE form. */
function ratioForRate(rate: number, side: InGameRatio["side"]): InGameRatio {
  return rate >= 1
    ? { want: rate, have: 1, side }
    : { want: 1, have: 1 / rate, side };
}

/** The two real boundaries GGG publishes; never interpolate a fake ladder. */
function inGameRatioRange(edge: DirectedEdge): InGameRatioRange {
  return {
    favorable: ratioForRate(edge.rateHigh, "favorable-hourly"),
    conservative: ratioForRate(edge.rateLow, "conservative-hourly"),
    source: "ggg-completed-hour-boundaries",
  };
}

function inGameRatio(edge: DirectedEdge): MarketSignal["buyRatio"] {
  const ratio = inGameRatioRange(edge).conservative;
  return { want: ratio.want, have: ratio.have, side: "conservative-hourly" };
}

function flipLeg(edge: DirectedEdge, pay: number, receive: number) {
  const fee = goldCostPerUnit(edge.to);
  return {
    pay,
    receive,
    goldCost: fee.verified ? receive * fee.cost : 0,
    goldVerified: fee.verified,
    hourlyVolume: edge.volumeFrom,
  };
}

function routeLeg(edge: DirectedEdge, pay: number, receive: number): RouteLeg {
  const legShare = share(edge, pay, receive);
  const fee = goldCostPerUnit(edge.to);
  return {
    edgeKey: edge.key,
    from: edge.from,
    to: edge.to,
    fromUnits: pay,
    toUnits: receive,
    rate: planningRate(edge),
    volumeFrom: edge.volumeFrom,
    volumeTo: edge.volumeTo,
    playbook: { give: pay, pay: edge.from, receive, want: edge.to },
    goldCost: fee.verified ? receive * fee.cost : 0,
    fromShare: edge.volumeFrom > 0 ? pay / edge.volumeFrom : 1,
    toShare: edge.volumeTo > 0 ? receive / edge.volumeTo : 1,
    volumeShare: legShare,
    sourceHourUtc: edge.hourUtc,
    ratioRangePct: rangePct(edge),
  };
}

function chooseSizing(buy: DirectedEdge, sell: DirectedEdge, back: DirectedEdge | null) {
  const choices = OUTPUT_TARGETS.map((target) => {
    const itemNeeded = Math.max(1, Math.ceil(target / planningRate(sell)));
    const start = Math.max(1, Math.ceil(itemNeeded / planningRate(buy)));
    const item = Math.floor(start * planningRate(buy));
    const end = Math.floor(item * planningRate(sell));
    const final = back ? Math.floor(end * planningRate(back)) : null;
    if (item <= 0 || end <= 0) return null;
    const twoLegProfitPct = (end * (back ? planningRate(back) : 0) / start - 1) * 100;
    const closedCycleProfitPct = final === null ? null : (final / start - 1) * 100;
    const shares = [share(buy, start, item), share(sell, item, end)];
    if (back && final !== null) shares.push(share(back, end, final));
    return { start, item, end, final, twoLegProfitPct, closedCycleProfitPct, maxShare: Math.max(...shares) };
  }).filter((x): x is NonNullable<typeof x> =>
    x !== null
    && Number.isFinite(x.twoLegProfitPct)
    // A proposed size larger than the entire observed hourly market is not a
    // trade signal. Keeping the 20-100% band lets the product show HIGH RISK
    // ideas without persisting impossible liquidity ratios.
    && x.maxShare <= 1
  );

  return choices.sort((a, b) =>
    (b.closedCycleProfitPct ?? b.twoLegProfitPct) - (a.closedCycleProfitPct ?? a.twoLegProfitPct)
    || a.maxShare - b.maxShare
    || a.start - b.start
  )[0] ?? null;
}

function findReturn(edges: DirectedEdge[], from: string, to: string, used: Set<string>): DirectedEdge | null {
  return edges
    .filter((edge) => edge.from === from && edge.to === to && !conflictsWith(edge, used))
    .sort((a, b) => Math.min(b.volumeFrom, b.volumeTo) - Math.min(a.volumeFrom, a.volumeTo))[0] ?? null;
}

/** Build broad, readable market signals without fabricating an unknown fee. */
export function buildMarketSignalRows(
  edges: DirectedEdge[],
  settings: RunSettings,
  league: string,
  sourceHourUtc: string,
  payloadSha256: string,
  hubCurrencies: readonly string[],
): OpportunityRow[] {
  const hubs = new Set(hubCurrencies);
  const byFrom = new Map<string, DirectedEdge[]>();
  for (const edge of edges) byFrom.set(edge.from, [...(byFrom.get(edge.from) ?? []), edge]);
  const bestByFamily = new Map<string, OpportunityRow>();

  for (const start of hubCurrencies) {
    const startIdentity = resolveIdentity(start);
    if (!startIdentity) continue;
    for (const buy of byFrom.get(start) ?? []) {
      if (hubs.has(buy.to)) continue;
      const item = resolveIdentity(buy.to);
      if (!item) continue;
      for (const sell of byFrom.get(buy.to) ?? []) {
        if (!hubs.has(sell.to) || sell.to === start || conflictsWith(sell, new Set([buy.key]))) continue;
        const sellIdentity = resolveIdentity(sell.to);
        if (!sellIdentity) continue;
        const back = findReturn(edges, sell.to, start, new Set([buy.key, sell.key]));
        if (!back) continue; // the user asked for the entire equation
        const sized = chooseSizing(buy, sell, back);
        if (!sized || sized.twoLegProfitPct <= 0 || (sized.closedCycleProfitPct ?? 0) <= 0) continue;
        const { start: startUnits, item: itemUnits, end: endUnits, final, twoLegProfitPct, closedCycleProfitPct, maxShare } = sized;
        if (final === null) continue;

        const buyLeg = flipLeg(buy, startUnits, itemUnits);
        const sellLeg = flipLeg(sell, itemUnits, endUnits);
        const returnLeg = flipLeg(back, endUnits, final);
        const goldVerified = buyLeg.goldVerified && sellLeg.goldVerified && returnLeg.goldVerified;
        const totalGold = goldVerified ? buyLeg.goldCost + sellLeg.goldCost + returnLeg.goldCost : null;
        const estimatedFees = [
          { edge: buy, receive: itemUnits, leg: buyLeg },
          { edge: sell, receive: endUnits, leg: sellLeg },
          { edge: back, receive: final, leg: returnLeg },
        ].map(({ edge, receive, leg }) => {
          const estimate = estimatedGoldCostPerUnit(edge.to);
          return { gold: leg.goldVerified ? leg.goldCost : receive * estimate.cost, estimate };
        });
        const estimatedTotalGold = estimatedFees.reduce((sum, fee) => sum + fee.gold, 0);
        const unknownFee = estimatedFees.find((fee) => !fee.estimate.verified)?.estimate ?? null;
        const maxRange = Math.max(rangePct(buy), rangePct(sell), rangePct(back));
        const itemHourlyVolume = Math.min(buy.volumeTo, sell.volumeFrom);
        const riskValue = estimateFillRisk(maxShare, maxRange, itemHourlyVolume);
        const familyId = sha256Hex(`market-signal|${start}|${buy.to}|${sell.to}`);
        const id = sha256Hex(`market-signal|${familyId}|${league}|${sourceHourUtc}|${startUnits}`);
        const profitStart = final - startUnits;
        const toDivineRate = start === GGG_HUB_PATHS.DIVINE
          ? 1
          : edges.find((edge) => edge.from === start && edge.to === GGG_HUB_PATHS.DIVINE)?.rateLow ?? null;
        const estimatedProfitDivine = toDivineRate === null ? null : profitStart * toDivineRate;
        const estimatedDivPer100kGold = estimatedProfitDivine === null || estimatedTotalGold <= 0
          ? null
          : estimatedProfitDivine / estimatedTotalGold * 100_000;
        const warning = !goldVerified
          ? "Item gold fee is not verified; check the in-game fee before trading."
          : maxShare > settings.maxVolumeSharePct / 100
            ? "This size exceeds the normal liquidity limit; reduce the order or wait."
            : null;
        const recommendation: MarketSignal["recommendation"] = maxShare > 0.2
          ? "HIGH RISK"
          : goldVerified && (closedCycleProfitPct ?? 0) > 0
            ? "VERIFY NOW"
            : "WATCH";
        const signal: MarketSignal = {
          id, familyId, league, sourceHourUtc, item, buyCurrency: startIdentity,
          sellCurrency: sellIdentity, buyLeg, sellLeg, returnLeg,
          buyRatio: inGameRatio(buy), sellRatio: inGameRatio(sell), returnRatio: inGameRatio(back),
          buyRatioRange: inGameRatioRange(buy),
          sellRatioRange: inGameRatioRange(sell),
          returnRatioRange: inGameRatioRange(back),
          twoLegProfitPct, closedCycleProfitPct, startingQuantity: startUnits,
          finalStartingQuantity: final, totalGold, goldVerified, estimatedTotalGold,
          estimatedGoldPerUnknownUnit: unknownFee?.cost ?? null,
          goldEstimateBasis: unknownFee?.basis ?? null,
          estimatedProfitDivine, estimatedDivPer100kGold, itemHourlyVolume,
          maxVolumeShare: maxShare, fillRisk: riskValue, fillRiskLabel: fillRiskLabel(riskValue),
          ratioRangePct: maxRange, recommendation, warning,
        };

        const routeLegs = [routeLeg(buy, startUnits, itemUnits), routeLeg(sell, itemUnits, endUnits)];
        const valuation: ValuationDisclosure = {
          profitKind: "mark-to-market", inputValuationPath: [], outputValuationPath: [],
          observationIds: [buy.observationId, sell.observationId, back.observationId],
          valuationRates: [planningRate(buy), planningRate(sell), planningRate(back)],
          returnToBaseLegs: [{ observationId: back.observationId, from: back.from, to: back.to, rate: planningRate(back) }],
          returnToBaseIncluded: false, valuationBottleneckVolumeShare: maxShare,
          valuationRangeUncertaintyPct: maxRange, valuationConfidence: Math.max(0, 1 - riskValue),
          valuationExecutable: true, valuationGoldIncluded: false, valuationTradeCountIncluded: 0,
        };
        const route = {
          id, routeFamilyId: familyId, strategy: "two-leg-cross", startCurrency: start,
          endCurrency: sell.to, hubCurrency: buy.to, legs: routeLegs, startUnits,
          endUnits, grossProfitBase: profitStart, inputValueBase: startUnits,
          goldCostTotal: totalGold ?? 0, movementHaircutPct: maxRange / 2,
          ratioRangeUncertaintyPct: maxRange, temporalMovementPct: null,
          movementStatus: "insufficient-history", estimatedMarketImpactPct: maxShare * 100,
          conservativeProfitBase: profitStart, fillConfidence: Math.max(0, 1 - riskValue),
          expectedProfitBase: profitStart, score: (closedCycleProfitPct ?? twoLegProfitPct) - maxShare * 100,
          divineProfitPerGold: totalGold && totalGold > 0 ? profitStart / totalGold : 0,
          profitPerTrade: profitStart / 3, capitalRoiPct: closedCycleProfitPct ?? twoLegProfitPct,
          bottleneckVolumeShare: maxShare, bottleneckEdgeKey: [buy, sell, back].sort((a,b) => share(b,1,b.rate)-share(a,1,a.rate))[0]!.key,
          dataAgeHours: 0, ratioRangePct: maxRange, profitKind: "mark-to-market",
          profitClass: "mark-to-market", realizedCurrency: null, realizedProfitStart: null,
          realizedProfitBase: null, valuation, discovery: signal,
        } as Route & { discovery: MarketSignal };
        const row: OpportunityRow = {
          strategy: "two-leg-cross", route, playbook: routeLegs.map((leg) => leg.playbook),
          startCurrency: start, endCurrency: sell.to, startUnits, endUnits,
          grossProfitBase: profitStart, conservativeProfitBase: profitStart,
          expectedProfitBase: profitStart, goldCost: totalGold ?? 0, legCount: 2,
          bottleneckVolumeShare: maxShare, ratioRangePct: maxRange,
          movementHaircutPct: maxRange / 2, fillConfidence: Math.max(0, 1 - riskValue),
          score: route.score, profitKind: "mark-to-market", profitClass: "mark-to-market",
          realizedCurrency: null, realizedProfitStart: null, realizedProfitBase: null,
          sourceHour: sourceHourUtc, payloadSha256,
        };
        const old = bestByFamily.get(familyId);
        if (!old || row.score > old.score) bestByFamily.set(familyId, row);
      }
    }
  }
  return [...bestByFamily.values()].sort((a, b) => b.score - a.score);
}
