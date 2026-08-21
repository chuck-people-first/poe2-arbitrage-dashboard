import { readFileSync } from "node:fs";
import { parseGggPayload, pairRate } from "../src/domain/ggg.ts";
import { deriveEdges } from "../src/domain/edges.ts";
import { valueInBase } from "../src/domain/routes.ts";
import { evaluateCandidate } from "../src/domain/routes.ts";
import { scoreCandidate } from "../src/domain/scoring.ts";
import { enumerateTwoLegFlips } from "../src/domain/routes.ts";
import { GGG_HUB_PATHS } from "../src/domain/mapping.ts";
const payload=parseGggPayload(JSON.parse(readFileSync("fixtures/ggg-currency-exchange-1787090400.json","utf8")));
const league=payload.markets.filter(m=>m.league==="Runes of Aldur");
const edges=deriveEdges(league,"2026-08-18T22:00:00Z");
const start="Metadata/Items/Currency/CurrencyRerollRare";
const end="Metadata/Items/Currency/CurrencyAddModToRare";
const settings={startCurrency:start,baseCurrency:GGG_HUB_PATHS.DIVINE,capitalUnits:100,goldBudget:2_000_000,maxLegs:3,maxVolumeSharePct:20,minConservativeProfitBase:.05,maxDataAgeHours:0,movementRiskTolerancePct:100};
const candidates=enumerateTwoLegFlips(edges,settings).filter(c=>c.edges[0]?.from===start&&c.edges[0]?.to==="Metadata/Items/Currency/CurrencyModValues"&&c.edges[1]?.to===end);
for(const c of candidates.slice(0,1)){
 const ev=evaluateCandidate(c);const used=new Set(c.edges.map(e=>e.key));
 console.log(JSON.stringify({edges:c.edges.map(e=>({from:e.from,to:e.to,rate:e.rate,low:e.rateLow,high:e.rateHigh,volume:e.hourlyVolume,key:e.key})),ev,startValue:valueInBase(start,100,settings.baseCurrency,edges,used),endValue:valueInBase(end,ev.endUnits,settings.baseCurrency,edges,used),score:scoreCandidate(c,ev,edges,settings)},null,2));
}
for(const e of edges.filter(e=>[start,end,GGG_HUB_PATHS.DIVINE].includes(e.from)||[start,end,GGG_HUB_PATHS.DIVINE].includes(e.to))) console.log("EDGE",e.from,"->",e.to,e.rate,e.key);
