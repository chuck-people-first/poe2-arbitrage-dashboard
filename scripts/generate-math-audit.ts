import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { parseGggPayload } from "../src/domain/ggg.ts";
import { deriveEdges } from "../src/domain/edges.ts";
import { valueInBase, evaluateCandidate } from "../src/domain/routes.ts";
import { scoreCandidate } from "../src/domain/scoring.ts";
import { displayName, GGG_HUB_PATHS } from "../src/domain/mapping.ts";
import type { DirectedEdge, RunSettings } from "../src/domain/types.ts";

const rows=JSON.parse(readFileSync("fixtures/opportunity-public-2026-08-18T22.json","utf8"));
const base=GGG_HUB_PATHS.DIVINE;
const settings=(start:string):RunSettings=>({startCurrency:start,baseCurrency:base,capitalUnits:100,goldBudget:2_000_000,maxLegs:3,maxVolumeSharePct:20,minConservativeProfitBase:.05,maxDataAgeHours:0,movementRiskTolerancePct:100});
const fixtureFor=(hour:string)=>`fixtures/ggg-currency-exchange-${Math.floor(new Date(hour).getTime()/1000)}.json`;
const findIndependentPath=(from:string,to:string,edges:DirectedEdge[],used:Set<string>)=>{
 if(from===to)return [{from,to,rate:1,key:"identity"}];
 const direct=edges.find(e=>e.from===from&&e.to===to&&!used.has(e.key)&&!used.has(e.reverseEdgeKey));
 return direct?[direct]:[];
};
let out="# Phase 0 Math Audit — Published Opportunities\n\n";
out += `Audit inputs: raw GGG completed-hour fixtures for 2026-08-18 21:00Z and 22:00Z; base currency is ${displayName(base)}. All quantities below are integer Exchange quantities.\n\n`;
out += "> These are cross-currency flips, not closed arbitrage loops: they end in Exalted Orb and require an independently observed Exalted→Divine valuation for comparison.\n\n";
for(const [i,row] of rows.entries()){
 const payload=parseGggPayload(JSON.parse(readFileSync(fixtureFor(row.source_hour),"utf8")));
 const edges=deriveEdges(payload.markets.filter(m=>m.league===row.league),row.source_hour);
 const route=row.route;const used=new Set(route.legs.map((l:any)=>l.edgeKey));
 const routeEdges=route.legs.map((l:any)=>edges.find(e=>e.key===l.edgeKey)).filter(Boolean) as DirectedEdge[];
 const ev=evaluateCandidate({strategy:route.strategy,edges:routeEdges,startCurrency:route.startCurrency,endCurrency:route.endCurrency,startUnits:row.start_units,settings:settings(row.start_currency)});
 const currentStart=valueInBase(row.start_currency,row.start_units,base,edges,used);
 const end=valueInBase(row.end_currency,row.end_units,base,edges,used);
 const correctedStart=routeEdges[0]?.to===base ? row.start_units*routeEdges[0].rate : currentStart;
 const correctedGross=(end??0)-(correctedStart??0);
 const correctedConservative=correctedGross-(correctedStart??0)*(row.movement_haircut_pct/100);
 const correctedExpected=correctedConservative+(correctedGross-correctedConservative)*(1-row.fill_confidence);
 out += `## Published row ${i+1}\n\n`;
 out += `- **Source hour:** ${row.source_hour}\n- **Strategy:** ${row.strategy} (cross-currency flip; not a closed loop)\n- **Start:** ${row.start_units} ${displayName(row.start_currency)}\n- **End:** ${row.end_units} ${displayName(row.end_currency)}\n- **Observed route legs:** ${route.legs.length}\n\n`;
 out += `### Raw independent observations\n\n`;
 routeEdges.forEach((e,j)=>{const m=payload.markets.find(m=>m.marketId===e.observationId&&m.league===row.league)!;out += `${j+1}. **${displayName(e.from)} → ${displayName(e.to)}**, observation \`${e.observationId}\`\n   - GGG pair: \`${m.pair.join(" | ")}\`\n   - Low/high ratio rates in this direction: ${e.rateLow.toFixed(12)} / ${e.rateHigh.toFixed(12)}; midpoint used: **${e.rate.toFixed(12)}**\n   - Executed hourly volume basis: **${e.hourlyVolume}**; route receipt: **${route.legs[j].toUnits}**; share: **${(route.legs[j].volumeShare*100).toFixed(6)}%**\n   - Integer playbook: give **${route.legs[j].playbook.give}** ${displayName(route.legs[j].from)}, receive **${route.legs[j].playbook.receive}** ${displayName(route.legs[j].to)}\n   - Gold: **${route.legs[j].playbook.receive} × ${route.legs[j].goldCost/route.legs[j].playbook.receive} = ${route.legs[j].goldCost}**\n`});
 out += `\n### Published calculation reproduction\n\n`;
 out += `- Current engine input valuation: **${currentStart?.toFixed(12)} ${displayName(base)}** via an alternate path selected after excluding the route edges.\n- Output valuation: **${end?.toFixed(12)} ${displayName(base)}** via an independently observed path excluding the route edges.\n- Published gross: **${row.gross_profit_base.toFixed(12)} = ${end?.toFixed(12)} − ${currentStart?.toFixed(12)}**.\n- Published conservative: **${row.conservative_profit_base.toFixed(12)}**.\n- Published expected: **${row.expected_profit_base.toFixed(12)}**.\n- Published ROI: **${(row.conservative_profit_base/currentStart!*100).toFixed(6)}%**.\n- Gold total: **${route.legs.map((l:any)=>l.goldCost).join(" + ")} = ${row.gold_cost}**.\n- Profit/trade: **${row.conservative_profit_base.toFixed(12)} ÷ ${row.leg_count} = ${(row.conservative_profit_base/row.leg_count).toFixed(12)}**.\n- Profit/1M gold: **${row.conservative_profit_base.toFixed(12)} ÷ ${row.gold_cost} × 1,000,000 = ${(row.conservative_profit_base/row.gold_cost*1e6).toFixed(12)}**.\n\n`;
 out += `### Defect determination and corrected calculation\n\n`;
 out += `The displayed **${row.conservative_profit_base.toFixed(2)} Divine / ${(row.conservative_profit_base/currentStart!*100).toFixed(1)}%** is caused by an incorrect input valuation path: the engine excludes the route’s first Chaos→Divine observation, then finds an unrelated alternate path that values 100 Chaos at **${currentStart?.toFixed(6)} Divine**. The actual first Exchange leg is itself an independently observed Chaos→Divine conversion at **${routeEdges[0]?.rate.toFixed(12)} Divine/Chaos**, so the input capital is **${correctedStart?.toFixed(6)} Divine**.\n\n`;
 out += `Corrected: output **${end?.toFixed(6)} Divine** − input **${correctedStart?.toFixed(6)} Divine** = gross **${correctedGross.toFixed(6)} Divine**; movement haircut **${row.movement_haircut_pct}% × ${correctedStart?.toFixed(6)} = ${(correctedStart!*row.movement_haircut_pct/100).toFixed(6)}**; conservative **${correctedConservative.toFixed(6)} Divine**; expected (between conservative and gross) **${correctedExpected.toFixed(6)} Divine**; ROI **${(correctedConservative/correctedStart!*100).toFixed(6)}%**.\n\n`;
}
out += `## Duplicate determination\n\nThe two rows are **not sizing variants**: they have identical route currencies and legs but different source hours (21:00Z vs 22:00Z), different observed rates, integer receipts (2,970 vs 3,300), and different profits. They are alternative historical-hour observations of the same route family. The main dashboard must expose only the latest successful hour; historical alternatives belong in a separate history projection.\n`;
mkdirSync("docs",{recursive:true});writeFileSync("docs/phase-0-math-audit.md",out);
console.log("wrote docs/phase-0-math-audit.md");
