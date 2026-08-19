import { describe, expect, it } from "vitest";
import { GGG_HUB_PATHS } from "../src/domain/mapping.ts";
import { buildCurrencyRates } from "../src/domain/currency-rates.ts";
import {
  appendHourlyObservation,
  classifySignal,
  summarizeHistory,
} from "../src/domain/signal-history.ts";
import type { DirectedEdge, FlipHourlyObservation, GggMarket } from "../src/domain/types.ts";

const HOUR = "2026-08-19T12:00:00.000Z";
const next = (hour: string, n: number) => new Date(Date.parse(hour) + n * 3600000).toISOString();

function market(a: string, b: string, aRatio: number, bRatio: number, volume = 10000): GggMarket {
  return {
    league: "Runes of Aldur", marketId: `${a}|${b}`, pair: [a, b],
    volumeTraded: { [a]: volume, [b]: volume }, lowestStock: { [a]: 1000, [b]: 1000 },
    highestStock: { [a]: 1000, [b]: 1000 }, lowestRatio: { [a]: aRatio, [b]: bRatio },
    highestRatio: { [a]: aRatio, [b]: bRatio },
  };
}

function observation(hour: string, value: number, rates: [number, number, number] = [0.1, 10, 0.01]): FlipHourlyObservation {
  return {
    familyId: "family-1", league: "Runes of Aldur", sourceHourUtc: hour,
    divPer100kGold: value, conservativeProfitDivine: value, goldRequired: 1000,
    lowestLegVolume: 1000, volumeShare: 0.01, buyRate: rates[0]!, sellRate: rates[1]!,
    returnRate: rates[2]!, legRates: rates, inputDivineValue: 1, outputDivineValue: 1 + value,
    payloadSha256: `hash-${hour}`,
  };
}

describe("direct currency rates", () => {
  it("emits all six hub directions from direct pair observations", () => {
    const rates = buildCurrencyRates([
      market(GGG_HUB_PATHS.EXALTED, GGG_HUB_PATHS.CHAOS, 1, 33),
      market(GGG_HUB_PATHS.EXALTED, GGG_HUB_PATHS.DIVINE, 1, 0.003),
      market(GGG_HUB_PATHS.CHAOS, GGG_HUB_PATHS.DIVINE, 1, 0.1),
    ], HOUR, 1000, new Date(next(HOUR, 1)));
    expect(rates).toHaveLength(6);
    expect(rates.every((r) => r.executable)).toBe(true);
    expect(rates.map((r) => `${r.from.id}->${r.to.id}`)).toEqual(expect.arrayContaining([
      `${GGG_HUB_PATHS.EXALTED}->${GGG_HUB_PATHS.CHAOS}`,
      `${GGG_HUB_PATHS.CHAOS}->${GGG_HUB_PATHS.EXALTED}`,
      `${GGG_HUB_PATHS.EXALTED}->${GGG_HUB_PATHS.DIVINE}`,
      `${GGG_HUB_PATHS.DIVINE}->${GGG_HUB_PATHS.EXALTED}`,
      `${GGG_HUB_PATHS.CHAOS}->${GGG_HUB_PATHS.DIVINE}`,
      `${GGG_HUB_PATHS.DIVINE}->${GGG_HUB_PATHS.CHAOS}`,
    ]));
    expect(rates[0]!.goldCost).toBeGreaterThan(0);
    expect(rates[0]!.sourceAgeHours).toBe(1);
  });

  it("marks a missing pair non-executable instead of inventing a reciprocal quote", () => {
    const rates = buildCurrencyRates([market(GGG_HUB_PATHS.EXALTED, GGG_HUB_PATHS.CHAOS, 1, 33)], HOUR, 100, new Date(`${HOUR}`));
    const missing = rates.find((r) => r.from.id === GGG_HUB_PATHS.EXALTED && r.to.id === GGG_HUB_PATHS.DIVINE)!;
    expect(missing.executable).toBe(false);
    expect(missing.reason).toMatch(/direct.*observation/i);
    expect(missing.rate).toBeNull();
  });
});

describe("append-only signal history", () => {
  it("preserves first detection and calculates current, best, break-even and duration", () => {
    const history = [observation(HOUR, 1), observation(next(HOUR, 1), 2), observation(next(HOUR, 2), -1)];
    const summary = summarizeHistory(history, new Date(next(HOUR, 3)));
    expect(summary.firstDetected.divPer100kGold).toBe(1);
    expect(summary.current.divPer100kGold).toBe(-1);
    expect(summary.best.divPer100kGold).toBe(2);
    expect(summary.breakEvenSourceHourUtc).toBe(next(HOUR, 1));
    expect(summary.changeSinceDetectionPct).toBe(-200);
    expect(summary.firstSeenSourceHourUtc).toBe(HOUR);
    expect(summary.lastProfitableSourceHourUtc).toBe(next(HOUR, 1));
    expect(summary.opportunityDurationHours).toBe(2);
    expect(summary.status).toBe("EXPIRED");
  });

  it("returns honest insufficient-history and expired statuses", () => {
    expect(classifySignal([], 24)).toBe("INSUFFICIENT HISTORY");
    expect(classifySignal([observation(HOUR, 1)], 48)).toBe("INSUFFICIENT HISTORY");
    expect(classifySignal([observation(HOUR, 1), observation(next(HOUR, 1), -1)], 48)).toBe("EXPIRED");
  });

  it("deduplicates by family, league and source hour without overwriting first values", () => {
    const rows = appendHourlyObservation([observation(HOUR, 1)], observation(HOUR, 9));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.divPer100kGold).toBe(1);
  });
});
