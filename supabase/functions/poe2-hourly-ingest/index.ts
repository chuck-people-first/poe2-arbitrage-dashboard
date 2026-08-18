import { deriveEdges } from "../../../src/domain/edges.ts";
import { parseGggPayload } from "../../../src/domain/ggg.ts";
import { enumerateClosedTriangles, enumerateTwoLegFlips, evaluateCandidate } from "../../../src/domain/routes.ts";
import { GGG_HUB_PATHS } from "../../../src/domain/mapping.ts";
import { rankDefault, scoreCandidate, toRoute } from "../../../src/domain/scoring.ts";
import type { RunSettings } from "../../../src/domain/types.ts";

const FUNCTION = "poe2-hourly-ingest";
const LEAGUE = Deno.env.get("POE2_LEAGUE") ?? "Runes of Aldur";
const ALGORITHM_VERSION = "phase3-edge-1";
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
  const edges = deriveEdges(markets.filter((market) => market.league === LEAGUE), sourceHourUtc);
  const candidates = [...enumerateTwoLegFlips(edges, settings), ...enumerateClosedTriangles(edges, settings)];
  return candidates.map((candidate) => {
    const evaluation = evaluateCandidate(candidate);
    const scoring = scoreCandidate(candidate, evaluation, edges, settings);
    const route = toRoute(candidate, scoring, evaluation, sourceHourUtc);
    if (!route || scoring.score === null) return null;
    return {
      strategy: route.strategy,
      route,
      playbook: route.legs.map((leg) => leg.playbook),
      startCurrency: route.startCurrency,
      endCurrency: route.endCurrency,
      startUnits: route.startUnits,
      endUnits: route.endUnits,
      grossProfitBase: route.grossProfitBase,
      conservativeProfitBase: route.conservativeProfitBase,
      expectedProfitBase: route.expectedProfitBase,
      goldCost: route.goldCostTotal,
      legCount: route.legs.length,
      bottleneckVolumeShare: route.bottleneckVolumeShare,
      ratioRangePct: route.ratioRangePct,
      movementHaircutPct: route.movementHaircutPct,
      fillConfidence: route.fillConfidence,
      score: route.score,
      sourceHour: sourceHourUtc,
      payloadSha256: hash,
    };
  }).filter((row): row is NonNullable<typeof row> => row !== null).sort((a, b) => rankDefault(a.route, b.route));
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
    startCurrency: GGG_HUB_PATHS.CHAOS,
    baseCurrency: GGG_HUB_PATHS.DIVINE,
    capitalUnits: Number(Deno.env.get("POE2_CAPITAL_UNITS") ?? "100"),
    goldBudget: Number(Deno.env.get("POE2_GOLD_BUDGET") ?? "2000000"),
    maxLegs: 3,
    maxVolumeSharePct: 20,
    minConservativeProfitBase: 0.05,
    maxDataAgeHours: 0,
    movementRiskTolerancePct: 100,
  };

  try {
    const raw = await fetchWithRetry(sourceUrl, { headers: { "user-agent": "poe2-arbitrage-dashboard/0.1", accept: "application/json" } });
    const payload = parseGggPayload(raw);
    const payloadSha256 = await sha256Json(raw);
    const opportunities = buildOpportunities(payload, sourceHourUtc, settings, payloadSha256);
    const marketRows = payload.markets.filter((market) => market.league === LEAGUE).map((market) => ({
      marketId: market.marketId, pairA: market.pair[0], pairB: market.pair[1], volumeTraded: market.volumeTraded,
      lowestStock: market.lowestStock, highestStock: market.highestStock, lowestRatio: market.lowestRatio, highestRatio: market.highestRatio,
    }));
    const begun = (await rpc("begin_poe2_ingestion", { p_league: LEAGUE, p_source_hour: sourceHourUtc, p_payload_sha256: payloadSha256, p_settings: settings, p_algorithm_version: ALGORITHM_VERSION, p_markets: marketRows })) as Array<{ status: string; run_id: string | null; market_rows: number }>;
    const run = begun[0];
    if (!run || run.status === "skipped") return json(200, { status: "skipped", sourceHour: sourceHourUtc, durationMs: Date.now() - startedAt });
    if (!run.run_id) throw new Error("begin RPC returned no run id");
    const count = await rpc("complete_poe2_ingestion", { p_run_id: run.run_id, p_league: LEAGUE, p_source_hour: sourceHourUtc, p_payload_sha256: payloadSha256, p_opportunities: opportunities });
    await rpc("project_poe2_opportunities", { p_run_id: run.run_id });
    console.log(JSON.stringify({ function: FUNCTION, status: "succeeded", runId: run.run_id, sourceHour: sourceHourUtc, marketCount: marketRows.length, opportunityCount: opportunities.length, durationMs: Date.now() - startedAt }));
    return json(200, { status: "succeeded", runId: run.run_id, sourceHour: sourceHourUtc, marketCount: marketRows.length, opportunityCount: count, durationMs: Date.now() - startedAt });
  } catch (error) {
    const detail = safeError(error);
    console.error(JSON.stringify({ function: FUNCTION, status: "failed", sourceHour: sourceHourUtc, durationMs: Date.now() - startedAt, error: detail }));
    return json(502, { error: "ingestion failed", sourceHour: sourceHourUtc });
  }
});
