import { normalizeMarkets, sha256Json } from "./pipeline";
import { parseGggPayload } from "../domain/ggg";
import type { IngestionSettings, PersistedOpportunity } from "./pipeline";

export interface SupabaseWorkerConfig {
  supabaseUrl: string;
  serviceRoleKey: string;
  gggUserAgent: string;
  league: string;
  algorithmVersion: string;
  routeSettings: Record<string, unknown>;
}

export interface OpportunityBuilder {
  (markets: ReturnType<typeof normalizeMarkets>): Promise<PersistedOpportunity[]>;
}

/** Latest completed UTC hour, never the currently-open hour. */
export function latestCompletedHour(now = new Date()): Date {
  const hour = new Date(now);
  hour.setUTCMinutes(0, 0, 0);
  hour.setUTCHours(hour.getUTCHours() - 1);
  return hour;
}

export function hourUnixSeconds(hour: Date): number {
  return Math.floor(hour.getTime() / 1000);
}

async function fetchJson(url: string, init: RequestInit): Promise<unknown> {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(30_000) });
  const text = await response.text();
  if (!response.ok) throw new Error(`Upstream ${response.status}: ${text.slice(0, 500)}`);
  try { return JSON.parse(text); } catch { throw new Error("Upstream returned invalid JSON"); }
}

async function rpc(config: SupabaseWorkerConfig, name: string, body: Record<string, unknown>): Promise<unknown> {
  return fetchJson(`${config.supabaseUrl}/rest/v1/rpc/${name}`, {
    method: "POST",
    headers: {
      apikey: config.serviceRoleKey,
      Authorization: `Bearer ${config.serviceRoleKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

/**
 * Production hourly worker. The two RPCs make the persistence boundary atomic:
 * begin upserts the snapshot/run; complete inserts opportunities and advances
 * ingestion_state only after all calculations succeed.
 */
export async function runHourlyIngestion(
  config: SupabaseWorkerConfig,
  buildOpportunities: OpportunityBuilder,
  now = new Date(),
): Promise<{ status: string; runId: string | null; marketRows: number; opportunityRows: number }> {
  if (!config.serviceRoleKey) throw new Error("SUPABASE_SERVICE_ROLE_KEY is required server-side");
  const sourceHour = latestCompletedHour(now);
  const sourceHourUtc = sourceHour.toISOString();
  const sourceUrl = `https://web.poecdn.com/api/currency-exchange/poe2/${hourUnixSeconds(sourceHour)}`;
  const rawPayload = await fetchJson(sourceUrl, {
    headers: { "User-Agent": config.gggUserAgent, Accept: "application/json" },
  });
  const settings: IngestionSettings = {
    league: config.league,
    sourceHourUtc,
    algorithmVersion: config.algorithmVersion,
    routeSettings: config.routeSettings,
  };
  const payloadHash = sha256Json(rawPayload);
  const markets = normalizeMarkets(
    parseGggPayload(rawPayload),
    settings,
    payloadHash,
  );
  const begin = await rpc(config, "begin_poe2_ingestion", {
    p_league: config.league,
    p_source_hour: sourceHourUtc,
    p_payload_sha256: payloadHash,
    p_settings: config.routeSettings,
    p_algorithm_version: config.algorithmVersion,
    p_markets: markets,
  }) as Array<{ status: string; run_id: string | null; market_rows: number }>;
  const started = begin[0];
  if (!started || started.status === "skipped") {
    return { status: "skipped", runId: null, marketRows: 0, opportunityRows: 0 };
  }
  if (!started.run_id) throw new Error("Supabase begin RPC did not return run_id");

  try {
    const opportunities = await buildOpportunities(markets);
    const completed = await rpc(config, "complete_poe2_ingestion", {
      p_run_id: started.run_id,
      p_league: config.league,
      p_source_hour: sourceHourUtc,
      p_payload_sha256: payloadHash,
      p_opportunities: opportunities,
    });
    const count = typeof completed === "number" ? completed : opportunities.length;
    return { status: "succeeded", runId: started.run_id, marketRows: started.market_rows, opportunityRows: count };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await rpc(config, "fail_poe2_ingestion", { p_run_id: started.run_id, p_error: message });
    throw error;
  }
}
