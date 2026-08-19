import { deriveEdges } from "../../../src/domain/edges.ts";
import { parseGggPayload } from "../../../src/domain/ggg.ts";
import { GGG_HUB_PATHS } from "../../../src/domain/mapping.ts";
import { buildCurrencyRates } from "../../../src/domain/currency-rates.ts";
import { DEFAULT_START_CURRENCIES, scanOpportunityRows } from "../../../src/domain/scanner.ts";
import type { RunSettings } from "../../../src/domain/types.ts";

const FUNCTION = "poe2-hourly-ingest";
const LEAGUE = Deno.env.get("POE2_LEAGUE") ?? "Runes of Aldur";
const ALGORITHM_VERSION = "phase4-all-currencies-1";
const MAX_ATTEMPTS = 3;

function json(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/(authorization|apikey|service.role|secret|password|token)\s*[:=]\s*[^\s,;]+/gi, "$1=[redacted]").slice(0, 500);
}

function latestCompletedHour(now = new Date()): Date {
  const hour = new Date(now);
  hour.setUTCMinutes(0, 0, 0);
  hour.setUTCHours(hour.getUTCHours() - 1);
  return hour;
}

async function sha256Json(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function fetchWithRetry(url: string, init: RequestInit): Promise<unknown> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetch(url, { ...init, signal: AbortSignal.timeout(30_000) });
      const text = await response.text();
      if (!response.ok) throw new Error(`upstream HTTP ${response.status}`);
      return JSON.parse(text);
    } catch (error) {
      lastError = error;
      if (attempt < MAX_ATTEMPTS) await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** (attempt - 1)));
    }
  }
  throw lastError ?? new Error("upstream request failed");
}

async function rpc(name: string, body: Record<string, unknown>): Promise<unknown> {
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) throw new Error("hosted Supabase environment is incomplete");
  const response = await fetch(`${url}/rest/v1/rpc/${name}`, {
    method: "POST",
    headers: { apikey: key, Authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    const detail = (await response.text()).replace(/(authorization|apikey|service.role|secret|password|token)\s*[:=]\s*[^\s,;]+/gi, "$1=[redacted]").slice(0, 300);
    throw new Error(`database RPC ${name} returned HTTP ${response.status}: ${detail}`);
  }
  return response.json();
}

function buildOpportunities(payload: ReturnType<typeof parseGggPayload>, sourceHourUtc: string, settings: RunSettings, hash: string) {
  const markets = payload.markets.filter((market) => market.league === LEAGUE);
  const edges = deriveEdges(markets, sourceHourUtc);
  return scanOpportunityRows(
    edges,
    settings,
    LEAGUE,
    sourceHourUtc,
    hash,
    Date.now(),
    DEFAULT_START_CURRENCIES,
  );
}

Deno.serve(async (request) => {
  const startedAt = Date.now();
  if (request.method !== "POST") return json(405, { error: "method not allowed" });
  const expected = Deno.env.get("POE2_INGESTION_TOKEN");
  const supplied = request.headers.get("x-poe2-ingestion-token");
  if (!expected || !supplied || supplied !== expected) return json(401, { error: "unauthorized" });

  const sourceHour = latestCompletedHour();
  const sourceHourUtc = sourceHour.toISOString();
  const sourceUrl = `https://web.poecdn.com/api/currency-exchange/poe2/${Math.floor(sourceHour.getTime() / 1000)}`;
  const settings: RunSettings = {
    league: LEAGUE,
    startCurrency: GGG_HUB_PATHS.CHAOS,
    baseCurrency: GGG_HUB_PATHS.DIVINE,
    capitalUnits: Number(Deno.env.get("POE2_CAPITAL_UNITS") ?? "100"),
    goldBudget: Number(Deno.env.get("POE2_GOLD_BUDGET") ?? "2000000"),
    maxLegs: 3,
    maxVolumeSharePct: 20,
    minConservativeProfitBase: 0.05,
    maxDataAgeHours: Number(Deno.env.get("POE2_MAX_DATA_AGE_HOURS") ?? "3"),
    movementRiskTolerancePct: Number(Deno.env.get("POE2_MOVEMENT_TOLERANCE_PCT") ?? "100"),
  };

  let activeRunId: string | null = null; // set once begin succeeds; drives best-effort fail
  try {
    const raw = await fetchWithRetry(sourceUrl, { headers: { "user-agent": "poe2-arbitrage-dashboard/0.1", accept: "application/json" } });
    const payload = parseGggPayload(raw);
    const payloadSha256 = await sha256Json(raw);
    const opportunities = buildOpportunities(payload, sourceHourUtc, settings, payloadSha256);
    const marketRows = payload.markets.filter((market) => market.league === LEAGUE).map((market) => ({
      marketId: market.marketId, pairA: market.pair[0], pairB: market.pair[1], volumeTraded: market.volumeTraded,
      lowestStock: market.lowestStock, highestStock: market.highestStock, lowestRatio: market.lowestRatio, highestRatio: market.highestRatio,
    }));
    const persistedSettings = {
      ...settings,
      scanStartCurrencies: [...DEFAULT_START_CURRENCIES],
      currencySelectionRequired: false,
    };
    const begun = (await rpc("begin_poe2_ingestion", { p_league: LEAGUE, p_source_hour: sourceHourUtc, p_payload_sha256: payloadSha256, p_settings: persistedSettings, p_algorithm_version: ALGORITHM_VERSION, p_markets: marketRows })) as Array<{ status: string; run_id: string | null; market_rows: number }>;
    const run = begun[0];
    if (!run || run.status === "skipped") return json(200, { status: "skipped", sourceHour: sourceHourUtc, durationMs: Date.now() - startedAt });
    if (!run.run_id) throw new Error("begin RPC returned no run id");
    activeRunId = run.run_id;
    const currencyRates = buildCurrencyRates(payload.markets.filter((market) => market.league === LEAGUE), sourceHourUtc, settings.capitalUnits);
    // One RPC is the completion boundary: opportunities, six directional
    // rates, closed-cycle history, safe projections, ingestion state and the
    // succeeded run status commit or roll back together.
    const count = await rpc("complete_poe2_ingestion", {
      p_run_id: run.run_id, p_league: LEAGUE, p_source_hour: sourceHourUtc,
      p_payload_sha256: payloadSha256, p_opportunities: opportunities,
      p_rates: currencyRates.map((rate) => ({
        direction: rate.direction, from_currency: rate.from.id, to_currency: rate.to.id,
        market_id: rate.marketId, rate: rate.rate, rate_low: rate.rateLow, rate_high: rate.rateHigh,
        pay_units: rate.payUnits, receive_units: rate.receiveUnits, gold_cost: rate.goldCost,
        from_volume: rate.fromVolume, to_volume: rate.toVolume, volume_share: rate.volumeShare,
        fill_risk_pct: rate.fillRiskPct, executable: rate.executable, reason: rate.reason,
      })),
    });
    console.log(JSON.stringify({ function: FUNCTION, status: "succeeded", runId: run.run_id, sourceHour: sourceHourUtc, marketCount: marketRows.length, opportunityCount: opportunities.length, durationMs: Date.now() - startedAt }));
    return json(200, { status: "succeeded", runId: run.run_id, sourceHour: sourceHourUtc, marketCount: marketRows.length, opportunityCount: count, durationMs: Date.now() - startedAt });
  } catch (error) {
    // Best-effort failure marker (item 1): a run begun but not atomically
    // completed must not be left as 'running' forever. If a run id is known,
    // attempt fail_poe2_ingestion; swallow its errors (best effort only).
    if (activeRunId) {
      try {
        await rpc("fail_poe2_ingestion", { p_run_id: activeRunId, p_error: safeError(error) });
      } catch (failError) {
        console.error(JSON.stringify({ function: FUNCTION, status: "fail-marker-errored", runId: activeRunId, error: safeError(failError) }));
      }
    }
    const detail = safeError(error);
    console.error(JSON.stringify({ function: FUNCTION, status: "failed", sourceHour: sourceHourUtc, durationMs: Date.now() - startedAt, error: detail }));
    return json(502, { error: "ingestion failed", sourceHour: sourceHourUtc });
  }
});
