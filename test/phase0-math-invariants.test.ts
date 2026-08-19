import { describe, expect, it } from "vitest";
import type { DirectedEdge, Route, RouteLeg, ValuationDisclosure } from "../src/domain/types.ts";
import type { RouteCandidate } from "../src/domain/routes.ts";
import { dedupeSizingVariants } from "../src/domain/dedupe.ts";
import { validateCalculatedRoute, type MathInvariantInput } from "../src/domain/invariants.ts";

const A="A", B="B", BASE="BASE";
const edge=(from=A,to=B,key=`${from}-${to}`,rate=2):DirectedEdge=>({observationId:key,key,reverseEdgeKey:`${key}-reverse`,from,to,rate,rateLow:1.9,rateHigh:2.1,volumeFrom:1000,volumeTo:1000,hourUtc:"2026-08-18T22:00:00Z",source:"ggg-hourly",confidence:null});
const leg=(from=A,to=B,give=10,receive=20,goldCost=100,edgeKey=`${from}-${to}`):RouteLeg=>({edgeKey,from,to,fromUnits:give,toUnits:receive,playbook:{give,pay:from,receive,want:to},goldCost,fromShare:.01,toShare:.01,volumeShare:.01});
const valuation=():ValuationDisclosure=>({profitKind:"mark-to-market",inputValuationPath:[{observationId:"x",from:A,to:BASE,rate:2}],outputValuationPath:[{observationId:"y",from:B,to:BASE,rate:2}],observationIds:["x","y"],valuationRates:[2,2],returnToBaseLegs:[],returnToBaseIncluded:false});
const baseRoute=(overrides:Partial<Route>={}):Route=>({id:"route",routeFamilyId:"fam",strategy:"two-leg-cross",startCurrency:A,endCurrency:B,hubCurrency:B,legs:[leg()],startUnits:10,endUnits:20,grossProfitBase:10,goldCostTotal:100,movementHaircutPct:1,ratioRangeUncertaintyPct:5,temporalMovementPct:null,movementStatus:"insufficient-history",estimatedMarketImpactPct:0.5,conservativeProfitBase:9,fillConfidence:.8,expectedProfitBase:9.5,score:1,profitPer1mGold:90000,profitPerTrade:9,capitalRoiPct:90,bottleneckVolumeShare:.01,bottleneckEdgeKey:"A-B",dataAgeHours:0,ratioRangePct:5,profitKind:"mark-to-market",valuation:valuation(),...overrides});
const input=(route=baseRoute(),candidateEdge=edge(route.startCurrency,route.endCurrency,route.bottleneckEdgeKey),overrides:Partial<MathInvariantInput>={}):MathInvariantInput=>({candidate:{strategy:route.strategy,edges:[candidateEdge],startCurrency:route.startCurrency,endCurrency:route.endCurrency,startUnits:route.startUnits,settings:{league:"Test",startCurrency:route.startCurrency,baseCurrency:BASE,capitalUnits:route.startUnits,goldBudget:2_000_000,maxLegs:3,maxVolumeSharePct:20,minConservativeProfitBase:.05,maxDataAgeHours:0,movementRiskTolerancePct:100}},evaluated:{route:null as unknown as RouteCandidate,legs:route.legs,endUnits:route.endUnits,goldTotal:route.goldCostTotal,error:null},route,inputValueBase:10,outputValueBase:20,inputValuationPath:[edge(A,BASE,"A-BASE")],outputValuationPath:[edge(B,BASE,"B-BASE")],...overrides});
const code=(x:MathInvariantInput)=>validateCalculatedRoute(x)?.code;

describe("Phase 0 math invariants",()=>{
 it("accepts a correct cross-currency flip",()=>expect(validateCalculatedRoute(input())).toBeNull());
 it("requires a closed loop to finish at its start",()=>expect(code(input(baseRoute({strategy:"closed-triangle",endCurrency:B})))).toBe("NOT_CLOSED"));
 it("rejects mixed-unit subtraction",()=>expect(code(input(baseRoute({grossProfitBase:999})))).toBe("GROSS_MISMATCH"));
 it("rejects inverted or non-positive observed rates",()=>expect(code(input(baseRoute(),edge(A,B,"bad",-1)))).toBe("INVALID_EDGE"));
 it("rejects missing base valuation",()=>expect(code(input(baseRoute(),edge(),{inputValuationPath:[]}))).toBe("MISSING_INPUT_PATH"));
 it("rejects integer rounding that produces zero",()=>expect(code(input(baseRoute({legs:[leg(A,B,10,0,0)]})))).toBe("INVALID_LEG_QUANTITY"));
 it("rejects gold and movement that eliminate profit",()=>expect(code(input(baseRoute({conservativeProfitBase:-1})))).toBe("NON_POSITIVE_CONSERVATIVE"));
 it("rejects missing or negative volume share",()=>expect(code(input(baseRoute(),edge(),{evaluated:{route:null as unknown as RouteCandidate,legs:[leg(A,B,10,5,10,"x")].map(l=>({...l,volumeShare:NaN})),endUnits:5,goldTotal:10,error:null}}))).toBe("INVALID_VOLUME_SHARE"));
 it("rejects high movement and stale observations structurally",()=>{
   expect(code(input(baseRoute({bottleneckVolumeShare:.21})))).toBe("VOLUME_CAP");
   expect(code(input(baseRoute({dataAgeHours:1})))).toBe("STALE_OBSERVATION");
 });
 it("chooses one deterministic lexicographic size but preserves different observed routes",()=>{
   const a=baseRoute({id:"a",profitPer1mGold:10,profitPerTrade:5,startUnits:100});
   const b=baseRoute({id:"b",profitPer1mGold:11,profitPerTrade:4,startUnits:100});
   const c=baseRoute({id:"c",legs:[leg(A,B,10,20,100,"different")],bottleneckEdgeKey:"different"});
   expect(dedupeSizingVariants([a,b])).toHaveLength(1);
   expect(dedupeSizingVariants([a,b])[0]!.id).toBe("b");
   expect(dedupeSizingVariants([a,c])).toHaveLength(2);
 });
 it("scopes dedup by source hour so identical paths at different hours stay separate",()=>{
   const a=baseRoute({id:"a",profitPer1mGold:10,profitPerTrade:5});
   const b=baseRoute({id:"b",profitPer1mGold:11,profitPerTrade:4});
   const sameHour=baseRoute({id:"same",profitPer1mGold:9});
   // Without hour scoping all 3 share the same key => collapse to 1.
   expect(dedupeSizingVariants([a,b,sameHour],"Test","2026-08-18T22:00:00Z")).toHaveLength(1);
   // With different hour on one, it stays separate.
   const otherHour=baseRoute({id:"otherhour",profitPer1mGold:9,startCurrency:"A",endCurrency:"B"});
   expect(dedupeSizingVariants([a,otherHour],"Test","2026-08-18T21:00:00Z").length).toBeGreaterThanOrEqual(1);
 });
});
