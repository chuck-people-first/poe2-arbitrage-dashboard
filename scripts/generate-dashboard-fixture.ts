import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseGggPayload } from "../src/domain/ggg";
import { deriveEdges } from "../src/domain/edges";
import { enumerateClosedTriangles, enumerateTwoLegFlips, evaluateCandidate } from "../src/domain/routes";
import { scoreCandidate, toRoute, rankDefault } from "../src/domain/scoring";
import { GGG_HUB_PATHS } from "../src/domain/mapping";
import type { OpportunityRun, RunSettings } from "../src/domain/types";

const league = "Runes of Aldur";
const sourceHourUtc = "2026-08-18T03:00:00Z";
const raw = JSON.parse(readFileSync(join(process.cwd(), "fixtures/ggg-currency-exchange-1787022000.json"), "utf8"));
const markets = parseGggPayload(raw).markets.filter((market) => market.league === league);
const edges = deriveEdges(markets, sourceHourUtc);
const settings: RunSettings = {
  startCurrency: GGG_HUB_PATHS.CHAOS,
  baseCurrency: GGG_HUB_PATHS.DIVINE,
  capitalUnits: 100,
  goldBudget: 2_000_000,
  maxLegs: 3,
  maxVolumeSharePct: 20,
  minConservativeProfitBase: 0.05,
  maxDataAgeHours: 0,
  movementRiskTolerancePct: 100,
};
const candidates = [...enumerateTwoLegFlips(edges, settings), ...enumerateClosedTriangles(edges, settings)];
const routes = candidates.map((candidate) => {
  const evaluation = evaluateCandidate(candidate);
  const score = scoreCandidate(candidate, evaluation, edges, settings);
  return toRoute(candidate, score, evaluation, sourceHourUtc);
}).filter((route): route is NonNullable<typeof route> => route !== null).sort(rankDefault);
const run: OpportunityRun = {
  runId: "fixture-phase3",
  league,
  sourceHourUtc,
  settings,
  routes,
  createdAtUtc: new Date().toISOString(),
};
mkdirSync(join(process.cwd(), "public"), { recursive: true });
writeFileSync(join(process.cwd(), "public/dashboard-fixture.json"), JSON.stringify(run, null, 2) + "\n");
console.log(JSON.stringify({ routes: routes.length, sourceHourUtc, output: "public/dashboard-fixture.json" }));
