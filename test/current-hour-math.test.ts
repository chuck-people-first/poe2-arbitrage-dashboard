import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseGggPayload } from "../src/domain/ggg.ts";
import { deriveEdges } from "../src/domain/edges.ts";
import { enumerateTwoLegFlips, evaluateCandidate, valuationPath } from "../src/domain/routes.ts";
import { scoreCandidate, valuationRisk } from "../src/domain/scoring.ts";
import { GGG_HUB_PATHS } from "../src/domain/mapping.ts";
import type { RunSettings } from "../src/domain/types.ts";

const settings:RunSettings={league:"Runes of Aldur",startCurrency:GGG_HUB_PATHS.CHAOS,baseCurrency:GGG_HUB_PATHS.DIVINE,capitalUnits:100,goldBudget:2_000_000,maxLegs:3,maxVolumeSharePct:20,minConservativeProfitBase:.05,maxDataAgeHours:0,movementRiskTolerancePct:100};
const payload=parseGggPayload(JSON.parse(readFileSync("fixtures/ggg-currency-exchange-1787090400.json","utf8")));
const HOUR_UTC="2026-08-18T22:00:00Z";
const edges=deriveEdges(payload.markets.filter(m=>m.league==="Runes of Aldur"),HOUR_UTC);
const candidate=enumerateTwoLegFlips(edges,settings).find(c=>c.edges[0]?.from===GGG_HUB_PATHS.CHAOS&&c.edges[0]?.to===GGG_HUB_PATHS.DIVINE&&c.edges[1]?.to===GGG_HUB_PATHS.EXALTED)!;
// Reference time matches the fixture's source hour so actual source age is 0.
const referenceTimeMs=Date.parse(HOUR_UTC);

describe("2026-08-18 22:00 corrected cross-currency math",()=>{
 it("rejects the previously-published 533% route: its reference valuation path is illiquid",()=>{
   const evaluated=evaluateCandidate(candidate);
   const scored=scoreCandidate(candidate,evaluated,edges,settings,referenceTimeMs);
   // The route values its Exalted output through ThesisOfExperiments markets
   // whose executed volumes (127 / 1 / 3 / 8) cannot support a 3300-Exalted
   // notional: bottleneck ~2598% >> the 20% ceiling. The 533% signal is NOT
   // published as reliable mark-to-market value.
   expect(scored.rejection).toMatch(/valuation path bottleneck volume share/);
   expect(scored.rejection).toContain("> cap 20%");
   expect(scored.fields).toBeNull();
 });
 it("reports the valuation-path bottleneck share explicitly (~2598%)",()=>{
   const evaluated=evaluateCandidate(candidate);
   const used=new Set(candidate.edges.map(e=>e.key));
   const inputPath=candidate.edges[0]!.to===settings.baseCurrency
     ? [candidate.edges[0]!]
     : valuationPath(candidate.startCurrency,settings.baseCurrency,edges,used) ?? [];
   const outputPath=valuationPath(candidate.endCurrency,settings.baseCurrency,edges,used) ?? [];
   const risk=valuationRisk(inputPath,outputPath,candidate.startUnits,evaluated.endUnits,settings);
   expect(risk.bottleneckShare).toBeGreaterThan(20); // 25.98... = 2598%
   expect(risk.rejection).toMatch(/2598/);
 });
 it("rejects the same route when the source has genuinely aged past the limit",()=>{
   const agedMs=referenceTimeMs+4*3_600_000; // 4h later
   const scored=scoreCandidate(candidate,evaluateCandidate(candidate),edges,settings,agedMs);
   expect(scored.rejection).toMatch(/stale source: age/);
 });
});
