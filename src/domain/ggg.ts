// GGG Currency Exchange payload parser.
// Zod-validated at the boundary; rejects partial/typed-wrong payloads.

import { z } from "zod";
import type { GggMarket, GggPayload } from "./types";

const marketsSchema = z.object({
  league: z.string(),
  market_id: z.string(),
  market_pair: z.array(z.string()).length(2),
  volume_traded: z.record(z.string(), z.number()),
  lowest_stock: z.record(z.string(), z.number()),
  highest_stock: z.record(z.string(), z.number()),
  lowest_ratio: z.record(z.string(), z.number()),
  highest_ratio: z.record(z.string(), z.number()),
});

export const gggPayloadSchema = z.object({
  next_change_id: z.number().int(),
  markets: z.array(marketsSchema),
});

export function parseGggPayload(raw: unknown): GggPayload {
  const parsed = gggPayloadSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`GGG payload rejected by schema: ${parsed.error.message}`);
  }
  return {
    nextChangeId: parsed.data.next_change_id,
    markets: parsed.data.markets.map((m) => ({
      league: m.league,
      marketId: m.market_id,
      pair: [m.market_pair[0]!, m.market_pair[1]!],
      volumeTraded: m.volume_traded,
      lowestStock: m.lowest_stock,
      highestStock: m.highest_stock,
      lowestRatio: m.lowest_ratio,
      highestRatio: m.highest_ratio,
    })),
  };
}

/**
 * Represents the observed rate: GGG expresses it as (units of pair[0]) : (units of pair[1])
 * e.g. lowest_ratio {chaos: 9, divine: 1} = "9 chaos per 1 divine".
 */
export type RatioSide = 0 | 1;

export function pairRate(
  m: GggMarket,
  side: RatioSide,
  which: "low" | "high" | "mid",
): { from: string; to: string; rate: number } {
  const a = m.pair[0]!;
  const b = m.pair[1]!;
  const ra = (which === "low" ? m.lowestRatio : which === "high" ? m.highestRatio : m.lowestRatio)[a] ?? 0;
  const rb = (which === "low" ? m.lowestRatio : which === "high" ? m.highestRatio : m.highestRatio)[b] ?? 0;
  // rate a->b = rb/ra (units of b per 1 unit of a)
  if (which === "mid") {
    const lo = Math.min(
      (m.lowestRatio[b] ?? 0) / (m.lowestRatio[a] ?? 0),
      (m.highestRatio[b] ?? 0) / (m.highestRatio[a] ?? 0),
    );
    const hi = Math.max(
      (m.lowestRatio[b] ?? 0) / (m.lowestRatio[a] ?? 0),
      (m.highestRatio[b] ?? 0) / (m.highestRatio[a] ?? 0),
    );
    if (side === 0) return { from: a, to: b, rate: (lo + hi) / 2 };
    return { from: b, to: a, rate: 2 / (lo + hi) };
  }
  const rate = rb / ra;
  if (side === 0) return { from: a, to: b, rate };
  return { from: b, to: a, rate: 1 / rate };
}