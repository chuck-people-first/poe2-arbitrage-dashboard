import { createHash } from "node:crypto";
import { parseGggPayload } from "../domain/ggg";
import type { GggPayload, GggMarket } from "../domain/types";

export interface IngestionSettings {
  league: string;
  sourceHourUtc: string;
  algorithmVersion: string;
  routeSettings: Record<string, unknown>;
}

export interface PersistedMarketHour {
  source: "ggg-hourly";
  realm: "poe2";
  league: string;
  completedHour: string;
  marketId: string;
  pairA: string;
  pairB: string;
  volumeTraded: Record<string, number>;
  lowestStock: Record<string, number>;
  highestStock: Record<string, number>;
  lowestRatio: Record<string, number>;
  highestRatio: Record<string, number>;
  payloadSha256: string;
}

export interface PersistedOpportunity {
  strategy: "two-leg-cross" | "closed-triangle";
  route: unknown;
  playbook: unknown;
  startCurrency: string;
  endCurrency: string;
  startUnits: number;
  endUnits: number;
  grossProfitBase: number;
  conservativeProfitBase: number;
  expectedProfitBase: number;
  goldCost: number;
  legCount: number;
  bottleneckVolumeShare: number;
  ratioRangePct: number;
  movementHaircutPct: number;
  fillConfidence: number;
  score: number;
  sourceHour: string;
}

export interface IngestionRepository {
  transaction<T>(fn: (tx: IngestionTransaction) => Promise<T>): Promise<T>;
}

export interface IngestionTransaction {
  hasSuccessfulRun(settings: IngestionSettings, payloadSha256: string): Promise<boolean>;
  insertMarketHours(rows: PersistedMarketHour[]): Promise<void>;
  startRun(settings: IngestionSettings, payloadSha256: string): Promise<string>;
  insertOpportunities(runId: string, rows: PersistedOpportunity[]): Promise<void>;
  finishRun(runId: string, status: "succeeded" | "failed", error?: string): Promise<void>;
  updateIngestionState(runId: string, settings: IngestionSettings, payloadSha256: string): Promise<void>;
}

export interface IngestionResult {
  status: "succeeded" | "skipped";
  runId: string | null;
  payloadSha256: string;
  marketRows: number;
  opportunityRows: number;
}

export function sha256Json(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function normalizeMarkets(
  payload: GggPayload,
  settings: IngestionSettings,
  payloadSha256: string,
): PersistedMarketHour[] {
  return payload.markets
    .filter((market) => market.league === settings.league)
    .map((market) => toPersistedMarket(market, settings.sourceHourUtc, payloadSha256));
}

function toPersistedMarket(market: GggMarket, sourceHourUtc: string, payloadSha256: string): PersistedMarketHour {
  return {
    source: "ggg-hourly",
    realm: "poe2",
    league: market.league,
    completedHour: sourceHourUtc,
    marketId: market.marketId,
    pairA: market.pair[0],
    pairB: market.pair[1],
    volumeTraded: market.volumeTraded,
    lowestStock: market.lowestStock,
    highestStock: market.highestStock,
    lowestRatio: market.lowestRatio,
    highestRatio: market.highestRatio,
    payloadSha256,
  };
}

export async function ingestCompletedHour(
  rawPayload: unknown,
  settings: IngestionSettings,
  repository: IngestionRepository,
  buildOpportunities: (markets: PersistedMarketHour[]) => Promise<PersistedOpportunity[]>,
): Promise<IngestionResult> {
  const payload = parseGggPayload(rawPayload);
  const payloadSha256 = sha256Json(rawPayload);
  const marketRows = normalizeMarkets(payload, settings, payloadSha256);
  if (marketRows.length === 0) throw new Error(`No markets found for league ${settings.league}`);

  return repository.transaction(async (tx) => {
    if (await tx.hasSuccessfulRun(settings, payloadSha256)) {
      return { status: "skipped", runId: null, payloadSha256, marketRows: 0, opportunityRows: 0 };
    }
    await tx.insertMarketHours(marketRows);
    const runId = await tx.startRun(settings, payloadSha256);
    try {
      const opportunities = await buildOpportunities(marketRows);
      await tx.insertOpportunities(runId, opportunities);
      await tx.finishRun(runId, "succeeded");
      await tx.updateIngestionState(runId, settings, payloadSha256);
      return { status: "succeeded", runId, payloadSha256, marketRows: marketRows.length, opportunityRows: opportunities.length };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await tx.finishRun(runId, "failed", message);
      throw error;
    }
  });
}
