import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseGggPayload } from "../src/domain/ggg.ts";
import { deriveEdges } from "../src/domain/edges.ts";
import { enumerateTwoLegFlips, evaluateCandidate } from "../src/domain/routes.ts";
import { scoreCandidate } from "../src/domain/scoring.ts";
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
 it("uses the observed first leg for input valuation and keeps profit ordering",()=>{
   const evaluated=evaluateCandidate(candidate);const scored=scoreCandidate(candidate,evaluated,edges,settings,referenceTimeMs);
   expect(scored.rejection).toBeNull();expect(scored.fields).not.toBeNull();
   const f=scored.fields!;
   expect(f.grossProfitBase).toBeCloseTo(54.85961982025,8);
   expect(f.conservativeProfitBase).toBeCloseTo(53.84951881015,8);
   expect(f.expectedProfitBase).toBeGreaterThanOrEqual(f.conservativeProfitBase);
   expect(f.expectedProfitBase).toBeLessThanOrEqual(f.grossProfitBase);
   expect(f.capitalRoiPct).toBeCloseTo(533.1102362205,6);
   expect(f.grossProfitBase).not.toBeCloseTo(62.426905581084,6);
 });
 it("rejects the same route when the source has genuinely aged past the limit",()=>{
   const agedMs=referenceTimeMs+4*3_600_000; // 4h later
   const scored=scoreCandidate(candidate,evaluateCandidate(candidate),edges,settings,agedMs);
   expect(scored.rejection).toMatch(/stale source: age/);
 });
});
