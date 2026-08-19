import { GGG_HUB_PATHS, goldCostPerUnit, lookupItem } from "./mapping.ts";
import type { GggMarket, FlipIdentity } from "./types.ts";

export type CurrencyRateDirection =
  | "exalted-to-chaos" | "chaos-to-exalted"
  | "exalted-to-divine" | "divine-to-exalted"
  | "chaos-to-divine" | "divine-to-chaos";

export interface CurrencyRateQuote {
  direction: CurrencyRateDirection;
  from: FlipIdentity;
  to: FlipIdentity;
  marketId: string | null;
  rate: number | null;
  rateLow: number | null;
  rateHigh: number | null;
  payUnits: number;
  receiveUnits: number;
  goldCost: number;
  fromVolume: number;
  toVolume: number;
  volumeShare: number | null;
  fillRiskPct: number | null;
  sourceHourUtc: string;
  sourceAgeHours: number;
  executable: boolean;
  reason: string | null;
}

const HUBS = [GGG_HUB_PATHS.EXALTED, GGG_HUB_PATHS.CHAOS, GGG_HUB_PATHS.DIVINE] as const;
const DIRECTIONS: Array<[CurrencyRateDirection, string, string]> = [
  ["exalted-to-chaos", GGG_HUB_PATHS.EXALTED, GGG_HUB_PATHS.CHAOS],
  ["chaos-to-exalted", GGG_HUB_PATHS.CHAOS, GGG_HUB_PATHS.EXALTED],
  ["exalted-to-divine", GGG_HUB_PATHS.EXALTED, GGG_HUB_PATHS.DIVINE],
  ["divine-to-exalted", GGG_HUB_PATHS.DIVINE, GGG_HUB_PATHS.EXALTED],
  ["chaos-to-divine", GGG_HUB_PATHS.CHAOS, GGG_HUB_PATHS.DIVINE],
  ["divine-to-chaos", GGG_HUB_PATHS.DIVINE, GGG_HUB_PATHS.CHAOS],
];

function identity(path: string): FlipIdentity {
  const item = lookupItem(path);
  return {
    id: path,
    name: item?.displayName ?? path.split("/").pop() ?? path,
    iconUrl: item?.iconUrl ?? null,
    goldCostPerUnit: item?.goldCostPerUnit ?? -1,
  };
}

function observedDirection(market: GggMarket, from: string, to: string) {
  const fromLow = market.lowestRatio[from] ?? 0;
  const fromHigh = market.highestRatio[from] ?? 0;
  const toLow = market.lowestRatio[to] ?? 0;
  const toHigh = market.highestRatio[to] ?? 0;
  if (![fromLow, fromHigh, toLow, toHigh].every((x) => Number.isFinite(x) && x > 0)) return null;
  // Read the requested direction from its own ratio fields. The reverse quote
  // is independently calculated from the opposite fields, never 1 / rate.
  const low = Math.min(toLow / fromLow, toHigh / fromHigh);
  const high = Math.max(toLow / fromLow, toHigh / fromHigh);
  return { rate: (low + high) / 2, rateLow: low, rateHigh: high };
}

function findDirect(markets: GggMarket[], from: string, to: string) {
  return markets.find((m) => m.pair.includes(from) && m.pair.includes(to)) ?? null;
}

export function buildCurrencyRates(
  markets: GggMarket[],
  sourceHourUtc: string,
  capitalUnits: number,
  now: Date = new Date(),
): CurrencyRateQuote[] {
  const sourceAgeHours = Math.max(0, (now.getTime() - Date.parse(sourceHourUtc)) / 3600000);
  return DIRECTIONS.map(([direction, fromPath, toPath]) => {
    const from = identity(fromPath);
    const to = identity(toPath);
    const market = findDirect(markets, fromPath, toPath);
    const observed = market ? observedDirection(market, fromPath, toPath) : null;
    const payUnits = Math.max(0, Math.floor(capitalUnits));
    const receiveUnits = observed ? Math.floor(payUnits * observed.rate) : 0;
    const fee = goldCostPerUnit(toPath);
    const fromVolume = market?.volumeTraded[fromPath] ?? 0;
    const toVolume = market?.volumeTraded[toPath] ?? 0;
    const volumeShare = observed && fromVolume > 0 && toVolume > 0
      ? Math.max(payUnits / fromVolume, receiveUnits / toVolume)
      : null;
    const executable = Boolean(market && observed && receiveUnits > 0 && fee.verified && fromVolume > 0 && toVolume > 0);
    const reason = executable ? null : !market
      ? "No direct completed-hour observation"
      : !observed
        ? "Direct observation has invalid ratios"
        : !fee.verified
          ? "Gold fee is not verified"
          : receiveUnits <= 0
            ? "Capital produces zero whole received units"
            : "Two-sided volume is unavailable";
    return {
      direction, from, to, marketId: market?.marketId ?? null,
      rate: observed?.rate ?? null, rateLow: observed?.rateLow ?? null, rateHigh: observed?.rateHigh ?? null,
      payUnits, receiveUnits, goldCost: fee.verified ? receiveUnits * fee.cost : 0,
      fromVolume, toVolume, volumeShare, fillRiskPct: volumeShare === null ? null : Math.min(100, volumeShare * 100),
      sourceHourUtc, sourceAgeHours, executable, reason,
    };
  });
}

export function currencyHubPaths(): readonly string[] { return HUBS; }
