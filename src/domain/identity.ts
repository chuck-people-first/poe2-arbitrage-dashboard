// Deterministic route identity and valuation disclosure.
// Route family identity is strategy + canonical ordered observation/path
// identity. Opportunity identity adds league, source hour and execution sizing.
// Both use stable SHA-256 over canonical deterministic serialization so that
// collisions cannot come from shortened currency display names.
//
// Hashing is a PURE-JS SHA-256 (no node:crypto / no WebCrypto dependency) so
// this module runs identically in Node (tests), the Supabase Deno edge runtime,
// and the browser. Keep it dependency-free.

import type { DirectedEdge, ProfitKind, Route, ValuationDisclosure } from "./types.ts";

/** Pure-JS SHA-256 hex digest over a UTF-8 string (portable sync). */
export function sha256Hex(input: string): string {
  // UTF-8 encode
  const bytes: number[] = [];
  const str = unescape(encodeURIComponent(input));
  for (let i = 0; i < str.length; i++) bytes.push(str.charCodeAt(i));

  const K = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ];

  let h0 = 0x6a09e667, h1 = 0xbb67ae85, h2 = 0x3c6ef372, h3 = 0xa54ff53a;
  let h4 = 0x510e527f, h5 = 0x9b05688c, h6 = 0x1f83d9ab, h7 = 0x5be0cd19;

  const bitLen = bytes.length * 8;
  const bitLenHi = Math.floor(bitLen / 0x100000000);
  bytes.push(0x80);
  while (bytes.length % 64 !== 56) bytes.push(0);
  // 64-bit big-endian message length in bits (8 bytes total)
  bytes.push(
    (bitLenHi >>> 24) & 0xff, (bitLenHi >>> 16) & 0xff, (bitLenHi >>> 8) & 0xff, bitLenHi & 0xff,
    (bitLen >>> 24) & 0xff, (bitLen >>> 16) & 0xff, (bitLen >>> 8) & 0xff, bitLen & 0xff,
  );

  const w = new Array<number>(64).fill(0);
  const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n));
  for (let i = 0; i < bytes.length; i += 64) {
    for (let t = 0; t < 16; t++) {
      const off = i + t * 4;
      w[t] = ((bytes[off]! << 24) | (bytes[off + 1]! << 16) | (bytes[off + 2]! << 8) | bytes[off + 3]!) >>> 0;
    }
    for (let t = 16; t < 64; t++) {
      const s0 = rotr(w[t - 15]!, 7) ^ rotr(w[t - 15]!, 18) ^ (w[t - 15]! >>> 3);
      const s1 = rotr(w[t - 2]!, 17) ^ rotr(w[t - 2]!, 19) ^ (w[t - 2]! >>> 10);
      w[t] = (w[t - 16]! + s0 + w[t - 7]! + s1) >>> 0;
    }
    let a = h0, b = h1, c = h2, d = h3, e = h4, f = h5, g = h6, h = h7;
    for (let t = 0; t < 64; t++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + S1 + ch + K[t]! + w[t]!) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (S0 + maj) >>> 0;
      h = g; g = f; f = e; e = (d + temp1) >>> 0;
      d = c; c = b; b = a; a = (temp1 + temp2) >>> 0;
    }
    h0 = (h0 + a) >>> 0; h1 = (h1 + b) >>> 0; h2 = (h2 + c) >>> 0; h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0; h5 = (h5 + f) >>> 0; h6 = (h6 + g) >>> 0; h7 = (h7 + h) >>> 0;
  }

  return [h0, h1, h2, h3, h4, h5, h6, h7]
    .map((v) => (v >>> 0).toString(16).padStart(8, "0"))
    .join("");
}

/** Canonical ordered path identity used for the route family + opportunity. */
export function pathObsKey(edges: DirectedEdge[]): string {
  return edges
    .map((e) => `${e.observationId}>${e.from}>${e.to}`)
    .join("|");
}

/**
 * The route family: the strategy plus the canonical ordered observation/path
 * identity. Two historical hours that re-observe the same currency path with
 * the same legs share this id; sizing differences do not split it.
 */
export function routeFamilyId(strategy: Route["strategy"], edges: DirectedEdge[]): string {
  return sha256Hex(`family|${strategy}|${pathObsKey(edges)}`);
}

/**
 * The opportunity id: route family + league + source hour + execution sizing.
 * Distinct source hours or distinct start units produce distinct opportunities.
 */
export function opportunityId(
  familyId: string,
  league: string,
  sourceHourUtc: string,
  startUnits: number,
): string {
  return sha256Hex(`opp|${familyId}|${league}|${sourceHourUtc}|${startUnits}`);
}

/** Build the valuation disclosure for a route leg. */
export function disclosureForLegs(
  inputPath: DirectedEdge[],
  outputPath: DirectedEdge[],
  returnToBaseLegs: DirectedEdge[],
  returnToBaseIncluded: boolean,
  profitKind: ProfitKind,
  metrics: {
    valuationBottleneckVolumeShare: number;
    valuationRangeUncertaintyPct: number;
    valuationConfidence: number;
    valuationExecutable: boolean;
    valuationTradeCountIncluded: number;
  },
): ValuationDisclosure {
  const valuationEdges = (edges: DirectedEdge[]) =>
    edges.map((e) => ({ observationId: e.observationId, from: e.from, to: e.to, rate: e.rate }));
  const obsIds = new Set<string>([
    ...inputPath.map((e) => e.observationId),
    ...outputPath.map((e) => e.observationId),
    ...returnToBaseLegs.map((e) => e.observationId),
  ]);
  return {
    profitKind,
    inputValuationPath: valuationEdges(inputPath),
    outputValuationPath: valuationEdges(outputPath),
    observationIds: [...obsIds],
    valuationRates: [...inputPath, ...outputPath].map((e) => e.rate),
    returnToBaseLegs: valuationEdges(returnToBaseLegs),
    returnToBaseIncluded,
    valuationBottleneckVolumeShare: metrics.valuationBottleneckVolumeShare,
    valuationRangeUncertaintyPct: metrics.valuationRangeUncertaintyPct,
    valuationConfidence: metrics.valuationConfidence,
    valuationExecutable: metrics.valuationExecutable,
    valuationGoldIncluded: returnToBaseIncluded,
    valuationTradeCountIncluded: metrics.valuationTradeCountIncluded,
  };
}
