// Phase 0 spike runner: real fixtures -> edges -> candidate routes -> scores.
// Run: npx tsx src/spike.ts

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseGggPayload } from "./domain/ggg";
import { deriveEdges } from "./domain/edges";
import { enumerateClosedTriangles, enumerateTwoLegFlips, evaluateCandidate } from "./domain/routes";
import { scoreCandidate, toRoute, rankDefault } from "./domain/scoring";
import { displayName, GGG_HUB_PATHS, ITEM_MAP } from "./domain/mapping";
import type { RunSettings } from "./domain/types";

const LEAGUE = "Runes of Aldur";
const HOUR_UTC = "2026-08-18T03:00:00Z";

const raw = JSON.parse(
  readFileSync(join(process.cwd(), "fixtures", "ggg-currency-exchange-1787022000.json"), "utf8"),
);
const payload = parseGggPayload(raw);
const roa = payload.markets.filter((m) => m.league === LEAGUE);
console.log(`GGG payload: ${payload.markets.length} markets; ${roa.length} in ${LEAGUE}`);

const edges = deriveEdges(roa, HOUR_UTC);
console.log(`Derived ${edges.length} directed edges from ${roa.length} independent market pairs\n`);

const settings: RunSettings = {
  startCurrency: GGG_HUB_PATHS.CHAOS,
  baseCurrency: GGG_HUB_PATHS.DIVINE,
  capitalUnits: 100, // start with 100 chaos (~10 divine)
  goldBudget: 2_000_000,
  maxLegs: 3,
  maxVolumeSharePct: 20,
  minConservativeProfitBase: 0.05, // in divine
  maxDataAgeHours: 0,
  movementRiskTolerancePct: 100,
};

const flips = enumerateTwoLegFlips(edges, settings);
const triangles = enumerateClosedTriangles(edges, settings);
console.log(`Candidate two-leg flips: ${flips.length}`);
console.log(`Candidate closed triangles: ${triangles.length}`);

const scoredFlips = flips
  .map((c) => ({ c, ev: evaluateCandidate(c), sc: scoreCandidate(c, evaluateCandidate(c), edges, settings) }))
  .filter((x) => x.sc.score !== null);
const scoredTris = triangles
  .map((c) => ({ c, ev: evaluateCandidate(c), sc: scoreCandidate(c, evaluateCandidate(c), edges, settings) }))
  .filter((x) => x.sc.score !== null);

console.log(`Scored two-leg flips: ${scoredFlips.length}`);
console.log(`Scored closed triangles: ${scoredTris.length}`);

// Diagnose why candidates fail
const reasons = new Map<string, number>();
for (const c of flips) {
  const ev = evaluateCandidate(c);
  const sc = scoreCandidate(c, ev, edges, settings);
  const key = sc.rejection ?? (ev.error ? `EXEC: ${ev.error}` : "scored");
  reasons.set(key, (reasons.get(key) ?? 0) + 1);
}
for (const c of triangles) {
  const ev = evaluateCandidate(c);
  const sc = scoreCandidate(c, ev, edges, settings);
  const key = sc.rejection ?? (ev.error ? `EXEC: ${ev.error}` : "scored");
  reasons.set(key, (reasons.get(key) ?? 0) + 1);
}
console.log("\n=== Rejection breakdown (flips + triangles) ===");
for (const [reason, count] of [...reasons.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`${String(count).padStart(6)}  ${reason}`);
}

const routes = [...scoredFlips, ...scoredTris]
  .map((x) => ({ route: toRoute(x.c, x.sc, x.ev, HOUR_UTC)!, score: x.sc.score! }))
  .filter((r) => r.route !== null)
  .sort((a, b) => rankDefault(a.route, b.route));

console.log("=== TOP 25 ROUTES by profit-per-1M-gold (conservative) ===\n");
for (const { route } of routes.slice(0, 25)) {
  const legNames = route.legs
    .map((l) => `give ${l.playbook.give} ${displayName(l.from).split(" ")[0]} -> get ${l.playbook.receive} ${displayName(l.to).split(" ")[0]}`)
    .join(" | ");
  console.log(
    `${route.strategy === "closed-triangle" ? "▲3" : "=2"} ${displayName(route.startCurrency).padEnd(12)} ${route.startUnits} ${"→".padEnd(2)} ` +
      `${route.endUnits} ${displayName(route.endCurrency).padEnd(12)} ` +
      `gross=${route.grossProfitBase.toFixed(2)} adj=${route.conservativeProfitBase.toFixed(2)} ` +
      `gold=${route.goldCostTotal.toLocaleString()} ` +
      `per1M=${route.profitPer1mGold.toFixed(2)} pt=${route.profitPerTrade.toFixed(3)} ` +
      `roi=${route.capitalRoiPct.toFixed(2)}% conf=${(route.fillConfidence * 100).toFixed(0)}% ` +
      `bottleneck=${(route.bottleneckVolumeShare * 100).toFixed(1)}%`,
  );
  console.log(`     ${legNames}`);
  console.log(`     haircut=${route.movementHaircutPct.toFixed(1)}% score=${route.score.toFixed(3)}`);
  console.log();
}

console.log(`\nRoutes with score>0: ${routes.length}`);

// Also show the quarantine report
const mapped = new Set(Object.keys(ITEM_MAP));
const roaPaths = new Set<string>();
for (const m of roa) for (const p of m.pair) roaPaths.add(p);
const unmapped = [...roaPaths].filter((p) => !mapped.has(p)).sort();
console.log(`\nQuarantine report: ${unmapped.length}/${roaPaths.size} paths in ROA payload unmapped (never guessed):`);
for (const p of unmapped.slice(0, 15)) console.log(`  Q ${p}`);