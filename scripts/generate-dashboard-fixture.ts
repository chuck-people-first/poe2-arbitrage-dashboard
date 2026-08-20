// Generates public/dashboard-fixture.json + dashboard-demo.js — a DEMO dataset
// for screenshots / static rendering (never a live fallback).
//
// It demonstrates the PRODUCT model on a Divine-Tendies-style NON-CURRENCY
// item flip — Exalted -> Tul's Catalyst -> Divine — using the REAL Tul's
// Catalyst identity (real GGG path, readable name, real icon resolved through
// the authoritative poe.ninja image-decoded bridge). Only the arithmetic
// quantities are controlled for demonstration (the live fixture hour has no
// catalyst exchange market). The permanent banner marks this DEMO DATA.
//
// This synthetic populated demonstration ISOLATED to demo.html:
//   - live index.html loads config.js + dashboard-data.js + dashboard.js only
//     (never dashboard-demo.js / dashboard-fixture.json)
//   - dashboard.js renders the demo only when window.POE2_DEMO_DATA is set,
//     which only demo.html + dashboard-demo.js create
//   - the live load() path never falls back to demo/fixtures; with no live
//     connection it shows "No live connection configured".
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Route, RouteLeg, ValuationDisclosure } from "../src/domain/types.ts";
import { projectRoute } from "../src/domain/opportunity.ts";

const LEAGUE = "Runes of Aldur";
const HOUR = "2026-08-18T22:00:00Z";
const REF = Date.parse("2026-08-18T22:05:00Z");
const HASH = "demo-payload-sha";
const TULS = "Metadata/Items/Currency/Breach/BreachCatalystCold"; // Tul's Catalyst (real)
const EX = "Metadata/Items/Currency/CurrencyAddModToRare"; // Exalted
const DIV = "Metadata/Items/Currency/CurrencyModValues"; // Divine

const edgeVal = (from: string, to: string, rate = 1) => ({ observationId: `${from}->${to}`, from, to, rate });
const valuation = (): ValuationDisclosure => ({
  profitKind: "mark-to-market", // ends in Divine; return conversion is not included
  inputValuationPath: [edgeVal(EX, DIV, 0.0033)],
  outputValuationPath: [edgeVal(DIV, DIV, 1)], // already base
  observationIds: ["ex-div", "div-div"],
  valuationRates: [0.0033, 1],
  returnToBaseLegs: [],
  returnToBaseIncluded: false,
  valuationBottleneckVolumeShare: 0.01,
  valuationRangeUncertaintyPct: 5,
  valuationConfidence: 0.8,
  valuationExecutable: true,
  valuationGoldIncluded: true,
  valuationTradeCountIncluded: 0,
});

const leg = (from: string, to: string, give: number, receive: number, goldCost: number, edgeKey: string): RouteLeg => ({
  edgeKey, from, to, fromUnits: give, toUnits: receive, playbook: { give, pay: from, receive, want: to },
  goldCost, fromShare: 0.01, toShare: 0.01, volumeShare: 0.014,
});

// Controlled arithmetic for the DEMO (real identity, synthetic quantities).
// 265 Exalted -> 62 Tul's Catalyst -> 2 Divine  (matches the Divine Tendies
// product reference). goldRequired: buy leg 62 * 700 gold, sell leg 2 * 800.
const demoRoute: Route = {
  id: "demo-tul-1",
  routeFamilyId: "fam-tul-demo",
  strategy: "two-leg-cross",
  startCurrency: EX,
  endCurrency: DIV,
  hubCurrency: TULS,
  legs: [leg(EX, TULS, 265, 62, 43400, "EX->TUL"), leg(TULS, DIV, 62, 2, 1600, "TUL->DIV")],
  startUnits: 265,
  endUnits: 2,
  grossProfitBase: 1.21,
  inputValueBase: 2.0, // 265 exalted ~ 0.875 divine equiv at 302:1
  goldCostTotal: 45000,
  movementHaircutPct: 1,
  ratioRangeUncertaintyPct: 5,
  temporalMovementPct: null,
  movementStatus: "insufficient-history",
  estimatedMarketImpactPct: 0.5,
  conservativeProfitBase: 1.1,
  fillConfidence: 0.8,
  expectedProfitBase: 1.15,
  score: 1,
  divineProfitPerGold: 0.000024444,
  profitPerTrade: 0.55,
  capitalRoiPct: 55,
  bottleneckVolumeShare: 0.014,
  bottleneckEdgeKey: "EX->TUL",
  dataAgeHours: 1,
  ratioRangePct: 5,
  profitKind: "mark-to-market",
    profitClass: "mark-to-market",
    realizedCurrency: null,
    realizedProfitStart: null,
    realizedProfitBase: null,
  valuation: valuation(),
};

const closedDemoRoute: Route = {
  ...demoRoute,
  id: "demo-closed-tul-cycle",
  routeFamilyId: "fam-tul-closed-demo",
  strategy: "closed-triangle",
  endCurrency: EX,
  endUnits: 340,
  legs: [
    leg(EX, TULS, 265, 62, 43400, "EX->TUL"),
    leg(TULS, DIV, 62, 2, 1600, "TUL->DIV"),
    leg(DIV, EX, 2, 340, 2000, "DIV->EX"),
  ],
  goldCostTotal: 47000,
  grossProfitBase: 1.0,
  conservativeProfitBase: 0.8,
  profitKind: "closed-realized",
  profitClass: "closed-realized",
  realizedCurrency: EX,
  realizedProfitStart: 75,
  realizedProfitBase: 1.0,
  valuation: { ...valuation(), profitKind: "closed-realized", returnToBaseIncluded: true, valuationExecutable: true, valuationGoldIncluded: true, valuationTradeCountIncluded: 1 },
};

const row = projectRoute(demoRoute, LEAGUE, HOUR, HASH, REF)!;
const closedRow = projectRoute(closedDemoRoute, LEAGUE, HOUR, HASH, REF)!;
closedRow.route.discovery = {
  id: "demo-market-signal",
  familyId: "fam-tul-market-demo",
  league: LEAGUE,
  sourceHourUtc: HOUR,
  item: closedRow.cycle!.item,
  buyCurrency: closedRow.cycle!.startCurrency,
  sellCurrency: closedRow.cycle!.sellCurrency,
  buyLeg: { ...closedRow.cycle!.buyLeg, goldVerified: false },
  sellLeg: { ...closedRow.cycle!.sellLeg, goldVerified: true },
  returnLeg: { ...closedRow.cycle!.returnLeg, goldVerified: true },
  twoLegProfitPct: 50.6,
  closedCycleProfitPct: (340 / 265 - 1) * 100,
  startingQuantity: 265,
  finalStartingQuantity: 340,
  totalGold: null,
  goldVerified: false,
  itemHourlyVolume: 413,
  maxVolumeShare: 0.01,
  fillRisk: 0.08,
  fillRiskLabel: "Low",
  ratioRangePct: 4,
  recommendation: "WATCH",
  warning: "Item gold fee is not verified; check the in-game fee before trading.",
};
const fixture = {
  _demo: true,
  _note: "DEMO DATA — NOT LIVE OR EXECUTABLE. Synthetic demonstration of the product model (real Tul's Catalyst identity, controlled quantities). Never a live fallback.",
  league: LEAGUE,
  status: { league: LEAGUE, latest_successful_source_hour: HOUR, completed_at: new Date(REF).toISOString(), candidate_count: 2, algorithm_version: "phase-a-demo", run_status: "succeeded" },
  routes: [closedRow, row],
};

mkdirSync("public", { recursive: true });
writeFileSync(join("public", "dashboard-fixture.json"), JSON.stringify(fixture, null, 2));
writeFileSync(join("public", "dashboard-demo.js"), `window.POE2_DEMO_DATA=${JSON.stringify(fixture)};\n`);
const f = row.route.flip!;
const c = closedRow.cycle!;
console.log(`Wrote dashboard-fixture.json + dashboard-demo.js (DEMO)`);
console.log(`  Pay ${f.buyLeg.pay} ${f.buyCurrency.name} -> receive ${f.buyLeg.receive} ${f.item.name}`);
console.log(`  Pay ${f.sellLeg.pay} ${f.item.name} -> receive ${f.sellLeg.receive} ${f.sellCurrency.name}`);
console.log(`  conservative ${f.conservativeNetProfitDivine.toFixed(3)} Div | div/100k ${f.divPer100kGold.toFixed(2)} | gold ${f.goldRequired} | ${f.fillRiskLabel} fill | icon ${f.item.iconUrl!.slice(0, 60)}...`);
console.log(`  CLOSED cycle ${c.startingQuantity} ${c.startCurrency.name} -> ${c.finalStartingQuantity} ${c.startCurrency.name} | profit ${c.netRealizedProfitStart} ${c.startCurrency.name} | div/100k ${c.realizedProfitPer100kGold.toFixed(2)} | gold ${c.totalGold}`);
