// Live zero-candidate state capture helper: produces a dashboard-demo-zero.js
// that renders a REAL-style zero-candidate result (like the actual Phase 0
// output for the 22:00 fixture hour) so the empty state can be screenshotted.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const LEAGUE = "Runes of Aldur";
const HOUR = "2026-08-18T22:00:00Z";
const REF = Date.parse("2026-08-18T22:05:00Z");

const fixture = {
  // This is a REAL honest result shape, not a synthetic market: the 22:00Z
  // fixture hour yields zero publishable two-leg flips (Phase 0 rejects every
  // signal for valuation liquidity / unverified gold). candidate_count: 0.
  _demo: false,
  _note: "Zero-candidate state as the live dashboard renders it for a completed hour with no publishable flips. src of truth: safe status projection.",
  league: LEAGUE,
  status: { league: LEAGUE, latest_successful_source_hour: HOUR, completed_at: new Date(REF).toISOString(), candidate_count: 0, algorithm_version: "phase-3", run_status: "succeeded" },
  routes: [],
};
mkdirSync("public", { recursive: true });
writeFileSync(join("public", "dashboard-zero.js"), `window.POE2_ZERO_DATA=${JSON.stringify(fixture)};\n`);
console.log("Wrote public/dashboard-zero.js (zero-candidate state)");
