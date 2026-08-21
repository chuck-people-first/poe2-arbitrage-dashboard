// The scanner's client-side behaviour, exercised directly rather than grepped.
// dashboard.js is a plain script (no module system) so the functions under test
// are extracted and evaluated in isolation — the same source the browser runs.

import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("../public/dashboard.js", import.meta.url), "utf8");

/** Pull a contiguous slice of the real file and evaluate it. */
function evaluate(fromMarker: string, toMarker: string, extra = "") {
  const slice = source.slice(source.indexOf(fromMarker), source.indexOf(toMarker));
  const context: Record<string, unknown> = {};
  runInNewContext(`${slice}\n${extra}`, context);
  return context;
}

const sizing = evaluate(
  "const stepRate =",
  "const SCANNER_SORTS =",
  "this.scaleFlow = scaleFlow; this.MARKET_SHARE_CAP = MARKET_SHARE_CAP;",
) as { scaleFlow: (s: unknown, bankroll: number) => any; MARKET_SHARE_CAP: number };

/** A signal shaped like the server's: 3 Baubles per Exalted, 90 per Divine, 325 Exalted back. */
const signal = (overrides: Record<string, unknown> = {}) => ({
  // Deep enough that the wallet, not the market, is the binding constraint;
  // the cap is exercised explicitly below.
  itemHourlyVolume: 10_000,
  estimatedGoldPerUnknownUnit: 1000,
  flow: {
    startCurrency: "Exalted Orb",
    startUnits: 3,
    steps: [
      { action: "buy", haveUnits: 1, haveCurrency: "Exalted Orb", wantUnits: 3, wantCurrency: "Glassblower's Bauble", goldCost: 2250 },
      { action: "sell", haveUnits: 90, haveCurrency: "Glassblower's Bauble", wantUnits: 1, wantCurrency: "Divine Orb", goldCost: 800 },
      { action: "convert", haveUnits: 1, haveCurrency: "Divine Orb", wantUnits: 325, wantCurrency: "Exalted Orb", goldCost: 39000 },
    ],
  },
  ...overrides,
});

describe("bankroll sizing", () => {
  it("sizes the order to whole output units so nothing is lost to flooring", () => {
    // 270 Exalted buys exactly 810 Baubles -> 9 Divine, no remainder stranded.
    const plan = sizing.scaleFlow(signal(), 270);
    expect(plan.start).toBe(270);
    expect(plan.steps[0].want).toBe(810);
    expect(plan.steps[1].want).toBe(9);
    expect(plan.closed).toBe(true);
    expect(plan.net).toBe(plan.final - plan.start);
  });

  it("never proposes an order larger than the market can absorb", () => {
    // A 4,000 Exalted stake against 630 Baubles/hour: the cap binds, not the wallet.
    const plan = sizing.scaleFlow(signal({ itemHourlyVolume: 630 }), 4000);
    expect(plan.capped).toBe(true);
    expect(plan.stake).toBe(4000);
    expect(plan.start).toBeLessThan(4000);
    expect(plan.volumeShare).toBeLessThanOrEqual(sizing.MARKET_SHARE_CAP + 1e-9);
  });

  it("spends the whole stake when the market is deep enough", () => {
    const plan = sizing.scaleFlow(signal({ itemHourlyVolume: 10_000_000 }), 270);
    expect(plan.steps[0].want).toBe(810);
    expect(plan.capped).toBe(false);
    expect(plan.start).toBe(270);
  });

  it("rounds the plan DOWN to what closes, rather than overstating the return", () => {
    // 100 Exalted buys 300 Baubles; only 270 of them make whole Divine, so the
    // sizing steps back to 270 rather than reporting a fractional Divine.
    const plan = sizing.scaleFlow(signal(), 100);
    expect(plan.steps[1].want).toBeGreaterThanOrEqual(1);
    expect(plan.start).toBeLessThanOrEqual(100);
    expect(plan.steps[0].want).toBe(plan.start * 3);
  });

  it("reports a market too thin to complete the loop instead of inventing a result", () => {
    const plan = sizing.scaleFlow(signal({ itemHourlyVolume: 1 }), 4000);
    expect(plan.closed).toBe(false);
    expect(plan.net).toBeNull();
    expect(plan.netPct).toBeNull();
    expect(plan.tooThin).toBe(true);
  });

  it("marks gold as estimated when any leg's fee is unverified", () => {
    const unverified = signal();
    unverified.flow.steps[0]!.goldCost = null as unknown as number;
    const plan = sizing.scaleFlow(unverified, 270);
    expect(plan.goldKnown).toBe(false);
    expect(plan.gold).toBeGreaterThan(0);
  });

  it("refuses a malformed flow rather than rendering nonsense", () => {
    expect(sizing.scaleFlow(null, 100)).toBeNull();
    expect(sizing.scaleFlow({ flow: { steps: [] } }, 100)).toBeNull();
  });
});

describe("clipboard text", () => {
  it("copies the raw ratio, not HTML-escaped markup", () => {
    // An apostrophe in "Glassblower's Bauble" must reach the game as an
    // apostrophe, not as &#39;.
    const bid = source.slice(source.indexOf("function bidStripHtml"), source.indexOf("const ICON ="));
    expect(bid).toContain("compactRatioPlain(");
    expect(bid).toContain('data-copy="${esc(plain)}"');
    expect(bid).not.toContain("data-copy=\"${esc(text)}\"");
    // And the plain builder must not escape.
    const plain = source.slice(source.indexOf("const ratioPlain ="), source.indexOf("const ratioText ="));
    expect(plain).not.toContain("esc(");
  });
});

describe("settings persistence", () => {
  it("stores and restores without letting bad state break the page", () => {
    expect(source).toContain("localStorage.setItem(STORE_KEY");
    // Both paths are guarded: private mode must not throw on load or save.
    const save = source.slice(source.indexOf("function saveSettings"), source.indexOf("function loadSettings"));
    const load = source.slice(source.indexOf("function loadSettings"), source.indexOf("// ---- flow"));
    expect(save).toContain("catch");
    expect(load).toContain("catch");
  });
});
