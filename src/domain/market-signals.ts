// Broad two-leg market discovery for the product-facing Market Scanner.
//
// This intentionally has a different trust boundary from scored opportunities:
// - names/icons must resolve authoritatively;
// - every price leg is an independently observed GGG completed-hour market;
// - unknown gold is shown as unknown, never guessed or treated as zero;
// - TRADE NOW remains reserved for fully executable, closed scored cycles.
//
// DISCOVERY vs PROOF. The scanner's job is to surface every readable item that
// is mispriced across two currency markets — the broad list. Its job is NOT to
// pretend each of those is a proven round trip. So each row carries three
// separate figures (see `SignalPriceModel`) and one classification saying how
// much of the equation has actually been proven:
//
//   twoLegSpreadPct        completed-hour MIDPOINT of every market. Discovery.
//   targetBidPotentialPct  favorable boundaries. POTENTIAL, never executable.
//   returnConfirmedCyclePct least-favorable boundaries + integer sizing + all
//                          three gold fees. The only closed-cycle number.
//
// A row is listed when the midpoint spread is positive. It is only called
// return-confirmed when the conservative closed cycle is positive with every
// fee verified.

import { AGREEMENT_LABELS, crossSourcePrice } from "./cross-source.ts";
import type { DivinePriceBook } from "./divine-price.ts";
import { conflictsWith } from "./edges.ts";
import type { NinjaQuote } from "../integrations/poe-ninja.ts";
import { estimateFillRisk, fillRiskLabel, resolveIdentity } from "./flips.ts";
import { sha256Hex } from "./identity.ts";
import { estimatedGoldCostPerUnit, GGG_HUB_PATHS, goldCostPerUnit } from "./mapping.ts";
import type { OpportunityRow } from "./opportunity.ts";
import type {
  DirectedEdge,
  FlipIdentity,
  InGameRatio,
  InGameRatioRange,
  MarketSignal,
  Route,
  RouteLeg,
  RunSettings,
  SignalClassification,
  SignalFlow,
  SignalFlowStep,
  SignalPriceModel,
  ValuationDisclosure,
} from "./types.ts";

const OUTPUT_TARGETS = [1, 2, 5, 10, 25, 50, 100, 250, 500] as const;

/** Above this share of the observed hourly market, liquidity is the binding risk. */
const HIGH_RISK_SHARE = 0.2;

const CLASSIFICATION_LABELS: Record<SignalClassification, string> = {
  "return-confirmed": "Return confirmed",
  "fee-check-needed": "Fee check needed",
  "return-quote-available": "Return quote available",
  "two-leg-spread": "Two-leg spread",
  "high-risk": "High risk",
};

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
 * Size and price the *provable* cycle from the least-favorable observed
 * boundary. This makes the completed-hour proof conservative; the player must
 * still confirm the current book before posting an order.
 */
function planningRate(edge: DirectedEdge): number {
  return edge.rateLow;
}

/**
 * The discovery price: the hour's midpoint for this market. Used only for the
 * broad spread metric, never for the closed-cycle claim, and never mixed with
 * a boundary from another market inside one percentage.
 */
function discoveryRate(edge: DirectedEdge): number {
  return edge.rate;
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

/**
 * Compound one price model across the whole path. Every leg is read from the
 * SAME side of its own hourly range, so the result is internally consistent:
 * an all-midpoint number, an all-favorable number, or an all-conservative one.
 * Mixing sides across legs is exactly the bug this function exists to prevent.
 */
function compoundPct(
  legs: readonly DirectedEdge[],
  rateOf: (edge: DirectedEdge) => number,
): number {
  return (legs.reduce((product, edge) => product * rateOf(edge), 1) - 1) * 100;
}

/**
 * Pick an integer sizing at the conservative boundary. Sizing no longer gates
 * discovery: a family with no sizing that fits inside the observed hourly
 * liquidity still lists, it simply cannot claim a closed cycle.
 */
function chooseSizing(
  buy: DirectedEdge,
  sell: DirectedEdge,
  back: DirectedEdge | null,
  maxSharePct: number,
) {
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
    // trade signal. Rows that cannot fit are still listed for discovery, but
    // they are classified high-risk rather than persisted with an impossible
    // liquidity ratio.
    && x.maxShare <= 1
    // The cycle must actually close. A batch so small that the return leg
    // floors to zero units is not a conservative plan, it is a broken one, and
    // reporting its -100% as the closed-cycle result is noise.
    && (x.final === null || x.final >= 1)
  );

  // Report the best plan that stays INSIDE the product's liquidity cap, rather
  // than the best plan at any size. Two failure modes are being avoided here:
  // sizing up until `maxShare` — the number the risk classification keys on —
  // becomes an artifact of the sizer's ambition, and sizing down until integer
  // flooring, not the market, dictates the closed-cycle percentage.
  const cap = maxSharePct / 100;
  const byResult = (a: typeof choices[number], b: typeof choices[number]) =>
    (b.closedCycleProfitPct ?? b.twoLegProfitPct) - (a.closedCycleProfitPct ?? a.twoLegProfitPct)
    || a.maxShare - b.maxShare
    || a.start - b.start;
  const withinCap = choices.filter((choice) => choice.maxShare <= cap);
  if (withinCap.length) return withinCap.sort(byResult)[0]!;
  // Nothing fits the cap: take the lightest footprint. These rows classify as
  // high-risk, so the sizing is an illustration of the constraint, not a plan.
  return choices.sort((a, b) => a.maxShare - b.maxShare || byResult(a, b))[0] ?? null;
}

/** Smallest sizing that fits the path at all, used when nothing fits the liquidity cap. */
function fallbackSizing(buy: DirectedEdge, sell: DirectedEdge, back: DirectedEdge | null) {
  const itemNeeded = Math.max(1, Math.ceil(1 / planningRate(sell)));
  const start = Math.max(1, Math.ceil(itemNeeded / planningRate(buy)));
  const item = Math.floor(start * planningRate(buy));
  const end = Math.floor(item * planningRate(sell));
  if (item <= 0 || end <= 0) return null;
  const final = back ? Math.floor(end * planningRate(back)) : null;
  const shares = [share(buy, start, item), share(sell, item, end)];
  if (back && final !== null) shares.push(share(back, end, final));
  const maxShare = Math.max(...shares);
  if (!Number.isFinite(maxShare)) return null;
  return {
    start, item, end, final,
    twoLegProfitPct: (end * (back ? planningRate(back) : 0) / start - 1) * 100,
    closedCycleProfitPct: final === null ? null : (final / start - 1) * 100,
    maxShare,
  };
}

function findReturn(edges: DirectedEdge[], from: string, to: string, used: Set<string>): DirectedEdge | null {
  return edges
    .filter((edge) => edge.from === from && edge.to === to && !conflictsWith(edge, used))
    .sort((a, b) => Math.min(b.volumeFrom, b.volumeTo) - Math.min(a.volumeFrom, a.volumeTo))[0] ?? null;
}

/**
 * Classify how much of the equation is proven. Liquidity wins over price: a
 * cycle that only closes by eating a fifth of the hour's volume is high risk
 * whatever its percentage says.
 */
/**
 * Liquidity band straight from the order's share of the observed hour. The
 * shared `estimateFillRisk` blends in the hourly ratio range, which on GGG's
 * completed-hour feed is wide for almost every market — so its label saturates
 * at High and stops distinguishing anything. This band answers the only
 * question the scanner row has space for: how much of the hour would this
 * order have to eat?
 */
export function liquidityBand(maxVolumeShare: number): "Low" | "Medium" | "High" {
  if (!Number.isFinite(maxVolumeShare)) return "High";
  if (maxVolumeShare <= 0.05) return "Low";
  if (maxVolumeShare <= 0.2) return "Medium";
  return "High";
}

/**
 * The complete round trip as the player executes it: pay the starting
 * currency for the item, sell the item into the other hub, convert that hub
 * currency back. A spread that never converts back has not produced any of the
 * currency the player started with, so the closing step is part of the record,
 * not an afterthought.
 */
function buildFlow(
  start: FlipIdentity,
  item: FlipIdentity,
  sell: FlipIdentity,
  buyLeg: MarketSignal["buyLeg"],
  sellLeg: MarketSignal["sellLeg"],
  returnLeg: MarketSignal["returnLeg"],
  startUnits: number,
  finalUnits: number | null,
  totalGold: number | null,
  estimatedTotalGold: number,
  startDivinePrice: number | null,
): SignalFlow {
  const step = (
    action: SignalFlowStep["action"],
    leg: { pay: number; receive: number; goldCost: number; goldVerified: boolean },
    haveCurrency: string,
    wantCurrency: string,
  ): SignalFlowStep => ({
    action,
    haveUnits: leg.pay,
    haveCurrency,
    wantUnits: leg.receive,
    wantCurrency,
    goldCost: leg.goldVerified ? leg.goldCost : null,
  });
  const steps = [
    step("buy", buyLeg, start.name, item.name),
    step("sell", sellLeg, item.name, sell.name),
    ...(returnLeg ? [step("convert", returnLeg, sell.name, start.name)] : []),
  ];
  const closes = returnLeg !== null && finalUnits !== null;
  return {
    steps,
    startCurrency: start.name,
    startUnits,
    finalUnits: closes ? finalUnits : null,
    netUnits: closes ? finalUnits! - startUnits : null,
    netPct: closes && startUnits > 0 ? (finalUnits! / startUnits - 1) * 100 : null,
    startDivinePrice,
    totalGold,
    estimatedTotalGold,
    closesInStartCurrency: closes,
  };
}

function classify(
  model: SignalPriceModel,
  goldVerified: boolean,
  maxShare: number,
  sizingFits: boolean,
): SignalClassification {
  if (!sizingFits || maxShare > HIGH_RISK_SHARE) return "high-risk";
  if (!model.returnObserved) return "two-leg-spread";
  if (model.returnConfirmedCyclePct === null || model.returnConfirmedCyclePct <= 0) return "return-quote-available";
  return goldVerified ? "return-confirmed" : "fee-check-needed";
}

/** Build broad, readable market signals without fabricating an unknown fee. */
export function buildMarketSignalRows(
  edges: DirectedEdge[],
  settings: RunSettings,
  league: string,
  sourceHourUtc: string,
  payloadSha256: string,
  hubCurrencies: readonly string[],
  /** Second-source context. Omitted in tests that only exercise GGG behaviour. */
  secondSource?: { book: DivinePriceBook; quotesByPath: Map<string, NinjaQuote> },
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
        // The return leg is what makes the number a round trip rather than a
        // guess about what the sell currency is worth. Without it there is no
        // honest way to express the spread in the starting currency at all.
        if (!back) continue;
        const path = [buy, sell, back] as const;

        // DISCOVERY GATE: the item is mispriced at the hour's midpoint. This is
        // the broad list; proof of a closed cycle is a separate question below.
        const twoLegSpreadPct = compoundPct(path, discoveryRate);
        if (!Number.isFinite(twoLegSpreadPct) || twoLegSpreadPct <= 0) continue;

        const fitted = chooseSizing(buy, sell, back, settings.maxVolumeSharePct);
        const sizingFits = fitted !== null;
        const sized = fitted ?? fallbackSizing(buy, sell, back);
        if (!sized) continue;
        const { start: startUnits, item: itemUnits, end: endUnits, final, twoLegProfitPct, maxShare } = sized;

        const buyLeg = flipLeg(buy, startUnits, itemUnits);
        const sellLeg = flipLeg(sell, itemUnits, endUnits);
        const returnLeg = final === null ? null : flipLeg(back, endUnits, final);
        const goldVerified = buyLeg.goldVerified && sellLeg.goldVerified && (returnLeg?.goldVerified ?? false);
        const totalGold = goldVerified && returnLeg
          ? buyLeg.goldCost + sellLeg.goldCost + returnLeg.goldCost
          : null;
        const estimatedFees = [
          { edge: buy, receive: itemUnits, leg: buyLeg },
          { edge: sell, receive: endUnits, leg: sellLeg },
          ...(returnLeg && final !== null ? [{ edge: back, receive: final, leg: returnLeg }] : []),
        ].map(({ edge, receive, leg }) => {
          const estimate = estimatedGoldCostPerUnit(edge.to);
          return { gold: leg.goldVerified ? leg.goldCost : receive * estimate.cost, estimate };
        });
        const estimatedTotalGold = estimatedFees.reduce((sum, fee) => sum + fee.gold, 0);
        const unknownFee = estimatedFees.find((fee) => !fee.estimate.verified)?.estimate ?? null;

        // The conservative closed cycle only counts when a real integer sizing
        // fit inside the observed hourly liquidity AND every leg closed.
        const closedCycleProfitPct = sizingFits ? sized.closedCycleProfitPct : null;
        const priceModel: SignalPriceModel = {
          twoLegSpreadPct,
          targetBidPotentialPct: compoundPct(path, (edge) => edge.rateHigh),
          returnConfirmedCyclePct: closedCycleProfitPct,
          discoveryBasis: "ggg-completed-hour-midpoint",
          returnObserved: true,
        };

        const maxRange = Math.max(rangePct(buy), rangePct(sell), rangePct(back));
        const itemHourlyVolume = Math.min(buy.volumeTo, sell.volumeFrom);
        const riskValue = estimateFillRisk(maxShare, maxRange, itemHourlyVolume);
        const classification = classify(priceModel, goldVerified, maxShare, sizingFits);
        const familyId = sha256Hex(`market-signal|${start}|${buy.to}|${sell.to}`);
        const id = sha256Hex(`market-signal|${familyId}|${league}|${sourceHourUtc}|${startUnits}`);
        const profitStart = final === null ? 0 : final - startUnits;
        // Same starting quantity, same gold basis — the midpoint model differs
        // from the conservative one only in which side of the range it reads.
        const spreadProfitStart = startUnits * (twoLegSpreadPct / 100);
        const toDivineRate = start === GGG_HUB_PATHS.DIVINE
          ? 1
          : edges.find((edge) => edge.from === start && edge.to === GGG_HUB_PATHS.DIVINE)?.rateLow ?? null;
        const perGold = (profit: number | null) =>
          profit === null || estimatedTotalGold <= 0 ? null : profit / estimatedTotalGold * 100_000;
        const estimatedProfitDivine = toDivineRate === null ? null : profitStart * toDivineRate;
        const spreadProfitDivine = toDivineRate === null ? null : spreadProfitStart * toDivineRate;
        const spreadDivPer100kGold = perGold(spreadProfitDivine);
        const returnConfirmedDivPer100kGold = classification === "return-confirmed"
          ? perGold(estimatedProfitDivine)
          : null;
        const warning = !sizingFits
          ? "No order size fits inside the observed hourly volume; this is a price observation, not a plan."
          : !goldVerified
            ? "Item gold fee is not verified; check the in-game fee before trading."
            : maxShare > settings.maxVolumeSharePct / 100
              ? "This size exceeds the normal liquidity limit; reduce the order or wait."
              : closedCycleProfitPct !== null && closedCycleProfitPct <= 0
                ? "The spread is real at the midpoint but does not survive the least-favorable boundary; the return trip is not proven."
                : null;
        const recommendation: MarketSignal["recommendation"] = classification === "high-risk"
          ? "HIGH RISK"
          : classification === "return-confirmed"
            ? "VERIFY NOW"
            : "WATCH";
        const cross = crossSourcePrice(
          secondSource?.book.perUnit.get(buy.to) ?? null,
          secondSource?.quotesByPath.get(buy.to) ?? null,
        );
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
          estimatedProfitDivine, estimatedDivPer100kGold: perGold(estimatedProfitDivine),
          flow: buildFlow(startIdentity, item, sellIdentity, buyLeg, sellLeg, returnLeg,
            startUnits, sizingFits ? final : null, totalGold, estimatedTotalGold, toDivineRate),
          liquidityLabel: liquidityBand(maxShare),
          sourceCheck: {
            gggDivine: cross.gggDivine, ninjaDivine: cross.ninjaDivine,
            deviationPct: cross.deviationPct, agreement: cross.agreement,
            agreementLabel: AGREEMENT_LABELS[cross.agreement],
            trendPct: cross.ninjaTrendPct, sparkline: cross.ninjaSparkline,
            sources: cross.sources,
          },
          priceModel, classification, classificationLabel: CLASSIFICATION_LABELS[classification],
          spreadProfitDivine, spreadDivPer100kGold, returnConfirmedDivPer100kGold,
          itemHourlyVolume,
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
          valuationExecutable: sizingFits, valuationGoldIncluded: false, valuationTradeCountIncluded: 0,
        };
        // Ranking runs on the midpoint discovery model so every row is scored
        // on the same basis; classification, not score, decides what may be
        // called executable.
        const score = twoLegSpreadPct - maxShare * 100;
        const route = {
          id, routeFamilyId: familyId, strategy: "two-leg-cross", startCurrency: start,
          endCurrency: sell.to, hubCurrency: buy.to, legs: routeLegs, startUnits,
          endUnits, grossProfitBase: profitStart, inputValueBase: startUnits,
          goldCostTotal: totalGold ?? 0, movementHaircutPct: maxRange / 2,
          ratioRangeUncertaintyPct: maxRange, temporalMovementPct: null,
          movementStatus: "insufficient-history", estimatedMarketImpactPct: maxShare * 100,
          conservativeProfitBase: profitStart, fillConfidence: Math.max(0, 1 - riskValue),
          expectedProfitBase: profitStart, score,
          divineProfitPerGold: totalGold && totalGold > 0 ? profitStart / totalGold : 0,
          profitPerTrade: profitStart / 3, capitalRoiPct: closedCycleProfitPct ?? twoLegSpreadPct,
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
