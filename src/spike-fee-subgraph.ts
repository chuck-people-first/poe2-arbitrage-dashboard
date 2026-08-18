// Focused diagnostic: run the engine on the fee-verified subgraph only.
// Run: npx tsx src/spike-fee-subgraph.ts

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
const edges = deriveEdges(roa, HOUR_UTC);

// Fee-verified set: items whose mapping AND gold fee are both proven
const feeVerified = new Set<string>();
for (const [path, item] of Object.entries(ITEM_MAP)) {
  if (item.mappingSource === "checked-in-verified" && item.goldCostPerUnit >= 0) feeVerified.add(path);
}
console.log(`Fee-verified items: ${feeVerified.size}`);
// restrict edges
const subedges = edges.filter((e) => feeVerified.has(e.from) && feeVerified.has(e.to));
console.log(`Subgraph edges: ${subedges.length}\n`);

const settings: RunSettings = {
  startCurrency: GGG_HUB_PATHS.CHAOS,
  baseCurrency: GGG_HUB_PATHS.DIVINE,
  capitalUnits: 1000,
  goldBudget: 2_000_000,
  maxLegs: 3,
  maxVolumeSharePct: 20,
  minConservativeProfitBase: 0.05,
  maxDataAgeHours: 0,
  movementRiskTolerancePct: 100,
};

const flips = enumerateTwoLegFlips(subedges, settings);
const tris = enumerateClosedTriangles(subedges, settings);
console.log(`Flips in subgraph: ${flips.length}, triangles: ${tris.length}`);

// Show rejection breakdown
const reasons = new Map<string, number>();
const scored: { route: ReturnType<typeof toRoute>; sc: ReturnType<typeof scoreCandidate> }[] = [];
for (const c of flips) {
  const ev = evaluateCandidate(c);
  const sc = scoreCandidate(c, ev, subedges, settings);
  if (sc.score !== null) scored.push({ route: toRoute(c, sc, ev, HOUR_UTC), sc });
  const key = sc.rejection ?? "SCORED";
  reasons.set(key, (reasons.get(key) ?? 0) + 1);
}
for (const c of tris) {
  const ev = evaluateCandidate(c);
  const sc = scoreCandidate(c, ev, subedges, settings);
  if (sc.score !== null) scored.push({ route: toRoute(c, sc, ev, HOUR_UTC), sc });
  const key = sc.rejection ?? "SCORED";
  reasons.set(key, (reasons.get(key) ?? 0) + 1);
}
for (const [r, n] of [...reasons.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`${String(n).padStart(5)}  ${r}`);
}

console.log(`\nScored: ${scored.length}`);
const valid = scored.filter((x) => x.route !== null);
valid.sort((a, b) => rankDefault(a.route!, b.route!));
for (const { route } of valid.slice(0, 15)) {
  if (!route) continue;
  const legs = route.legs.map((l) => `${l.playbook.give} ${displayName(l.from).split(" ")[0]}→${l.playbook.receive} ${displayName(l.to).split(" ")[0]}`).join(" | ");
  console.log(
    `${route.strategy === "closed-triangle" ? "▲" : "="} ${route.startUnits} ${displayName(route.startCurrency).split(" ")[0]}→${route.endUnits} ${displayName(route.endCurrency).split(" ")[0]} ` +
      `gross=${route.grossProfitBase.toFixed(2)} adj=${route.conservativeProfitBase.toFixed(2)} gold=${route.goldCostTotal.toLocaleString()} ` +
      `per1M=${route.profitPer1mGold.toFixed(1)} roi=${route.capitalRoiPct.toFixed(2)}% conf=${(route.fillConfidence * 100).toFixed(0)}% ${legs}`,
  );
}