import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("../public/currency-rates.js", import.meta.url), "utf8");
const windowObject: Record<string, unknown> = {};
runInNewContext(source, { window: windowObject });

type RateReference = {
  pairModels(rows: Array<Record<string, unknown>>): {
    sourceHour: string | null;
    pairs: Array<{
      left: { name: string };
      right: { name: string };
      leftToRight: number | null;
      rightToLeft: number | null;
    }>;
  };
  ageLabel(sourceHour: string, nowMs?: number): string;
  currencyName(path: string): string | null;
};

const rates = windowObject.POE2CurrencyRates as RateReference;
const EXALTED = "Metadata/Items/Currency/CurrencyAddModToRare";
const CHAOS = "Metadata/Items/Currency/CurrencyRerollRare";
const DIVINE = "Metadata/Items/Currency/CurrencyModValues";

const row = (from: string, to: string, rate: number, sourceHour: string) => ({
  from_currency: from,
  to_currency: to,
  rate,
  source_hour: sourceHour,
});

describe("currency reference UI model", () => {
  it("shows exactly three readable hub pairs and never exposes raw GGG identifiers", () => {
    const model = rates.pairModels([
      row(EXALTED, CHAOS, 0.049, "2026-08-20T01:00:00Z"),
      row(CHAOS, EXALTED, 23.5, "2026-08-20T01:00:00Z"),
      row(EXALTED, DIVINE, 0.0029, "2026-08-20T01:00:00Z"),
      row(DIVINE, EXALTED, 341.5, "2026-08-20T01:00:00Z"),
      row(CHAOS, DIVINE, 0.095, "2026-08-20T01:00:00Z"),
      row(DIVINE, CHAOS, 10.5, "2026-08-20T01:00:00Z"),
    ]);

    expect(model.pairs).toHaveLength(3);
    expect(model.pairs.map(pair => [pair.left.name, pair.right.name])).toEqual([
      ["Exalted Orb", "Chaos Orb"],
      ["Exalted Orb", "Divine Orb"],
      ["Chaos Orb", "Divine Orb"],
    ]);
    expect(rates.currencyName(EXALTED)).toBe("Exalted Orb");
    expect(rates.currencyName(CHAOS)).toBe("Chaos Orb");
    expect(rates.currencyName(DIVINE)).toBe("Divine Orb");
  });

  it("uses only the latest completed hour and keeps both direct directions", () => {
    const model = rates.pairModels([
      row(EXALTED, CHAOS, 99, "2026-08-20T00:00:00Z"),
      row(CHAOS, EXALTED, 88, "2026-08-20T00:00:00Z"),
      row(EXALTED, CHAOS, 0.049, "2026-08-20T01:00:00Z"),
      row(CHAOS, EXALTED, 23.5, "2026-08-20T01:00:00Z"),
    ]);

    expect(model.sourceHour).toBe("2026-08-20T01:00:00.000Z");
    expect(model.pairs[0]!.leftToRight).toBe(0.049);
    expect(model.pairs[0]!.rightToLeft).toBe(23.5);
  });

  it("never emits NaN for a missing or valid source age", () => {
    expect(rates.ageLabel("not-a-date")).toBe("Source time unavailable");
    expect(rates.ageLabel("2026-08-20T01:00:00Z", Date.parse("2026-08-20T01:42:00Z"))).toBe("42m old");
    expect(rates.ageLabel("not-a-date")).not.toContain("NaN");
  });

  it("labels the panel as three reference pairs rather than arbitrary 100-unit trades", () => {
    const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
    const dashboard = readFileSync(new URL("../public/dashboard.js", import.meta.url), "utf8");
    expect(html).toContain("Quick Currency Reference");
    expect(html).toContain("3 PAIRS");
    expect(html).not.toContain("6 DIRECTIONS");
    expect(dashboard).toContain("1 ${esc(from.name)}");
    expect(dashboard).not.toContain("r.pay_units");
    expect(dashboard).not.toContain("Number(r.source_age)");
  });

  it("ranks scanner results by proof, then gold efficiency, then liquidity footprint", () => {
    const dashboard = readFileSync(new URL("../public/dashboard.js", import.meta.url), "utf8");
    const comparator = dashboard.slice(dashboard.indexOf("const SCANNER_COLUMN_SORTS"), dashboard.indexOf("function scannerRows"));
    const proof = comparator.indexOf("isConfirmed(b.discovery)");
    const efficiency = comparator.indexOf("b._divGold", proof);
    const share = comparator.indexOf("volumeShare", efficiency);
    const spread = comparator.indexOf("spreadOf(b.discovery)", share);
    expect(proof).toBeGreaterThan(-1);
    expect(efficiency).toBeGreaterThan(proof);
    expect(share).toBeGreaterThan(efficiency);
    expect(spread).toBeGreaterThan(share);
  });

  it("opens on the flow the player actually runs, not on every hub pair", () => {
    const dashboard = readFileSync(new URL("../public/dashboard.js", import.meta.url), "utf8");
    expect(dashboard).toMatch(/let flowPreset = 'mine'/);
    const presets = dashboard.slice(dashboard.indexOf("const FLOW_PRESETS"), dashboard.indexOf("let flowPreset"));
    // My flow == buy with Exalted or Chaos, sell for Divine, convert back.
    expect(presets).toContain("sellCurrency?.id === DIVINE");
    expect(presets).toContain("buyCurrency?.id === EXALTED || s.buyCurrency?.id === CHAOS");
    expect(presets).toContain("All paths");
  });

  it("never ranks a losing round trip above a profitable one, under ANY sort", () => {
    // A row showing "30.64 Div / 100K" beside "-30 Chaos" reached the top of the
    // live table purely by sorting on gold efficiency. Profitability at the size
    // you can actually trade is now layered over every column sort.
    const dashboard = readFileSync(new URL("../public/dashboard.js", import.meta.url), "utf8");
    expect(dashboard).toContain("const profits = r => Number(r._plan?.net ?? -Infinity) > 0;");
    const wrapper = dashboard.slice(dashboard.indexOf("const SCANNER_SORTS = Object.fromEntries"));
    expect(wrapper).toContain("(profits(b) ? 1 : 0) - (profits(a) ? 1 : 0)");
  });

  it("derives gold efficiency from the SAME plan as Net, not the midpoint spread", () => {
    // Two price models in adjacent columns is what produced "+30.64 Div / 100K"
    // beside a 58% loss.
    const dashboard = readFileSync(new URL("../public/dashboard.js", import.meta.url), "utf8");
    const fn = dashboard.slice(dashboard.indexOf("function planDivPer100k"), dashboard.indexOf("const spreadOf"));
    expect(fn).toContain("plan.net");
    expect(fn).toContain("startDivinePrice");
    expect(fn).not.toContain("spreadDivPer100kGold");
    const row = dashboard.slice(dashboard.indexOf("function scannerRowHtml"), dashboard.indexOf("function closedRowHtml"));
    expect(row).toContain("r._divGold");
    expect(row).not.toContain("s.spreadDivPer100kGold");
  });

  it("labels a losing round trip as a loss, and hides such rows by default", () => {
    const dashboard = readFileSync(new URL("../public/dashboard.js", import.meta.url), "utf8");
    const row = dashboard.slice(dashboard.indexOf("function scannerRowHtml"), dashboard.indexOf("function closedRowHtml"));
    expect(row).toContain("Loses money");
    expect(row).toContain("const cls = losing ?");
    // Default-on: a trade that ends with less than it started is not a candidate.
    const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
    expect(html).toMatch(/id="hideLosers"[^>]*checked/);
  });

  it("shows the whole round trip in the row, ending in the starting currency", () => {
    const dashboard = readFileSync(new URL("../public/dashboard.js", import.meta.url), "utf8");
    const chain = dashboard.slice(dashboard.indexOf("function flowChainHtml"), dashboard.indexOf("function bidStripHtml"));
    // Opens on the start hop and marks the closing hop differently — converting
    // back is the step people skip, and the only hop in what they started with.
    expect(chain).toContain("hop(startUnits, flow.startCurrency, 'start')");
    expect(chain).toContain("last ? 'back' : 'mid'");
    expect(chain).toContain("no order size closes this loop");
  });

  it("explains an empty scanner instead of claiming a recalculation is running", () => {
    // A blank dashboard reads as broken. When every stored row predates this
    // build, the page must say so — and must never imply work is in progress
    // when nothing is running.
    const dashboard = readFileSync(new URL("../public/dashboard.js", import.meta.url), "utf8");
    expect(dashboard).not.toContain("Recalculating this completed hour");
    expect(dashboard).toContain("Waiting on the next hourly ingest");
    expect(dashboard).toContain("staleVersion");
    // The reason the rows are hidden is still stated: old percentages are not
    // comparable, so they stay out rather than being mixed in.
    expect(dashboard).toMatch(/stay hidden rather than being shown/);
  });

  it("never ranks or headlines a row on the favorable-boundary compound", () => {
    // targetBidPotentialPct may only appear in the drawer's labeled figure
    // table. If it reaches a comparator or a main-row cell, three unrelated
    // best-case hourly extremes are being advertised as one executable number.
    const dashboard = readFileSync(new URL("../public/dashboard.js", import.meta.url), "utf8");
    const sorts = dashboard.slice(dashboard.indexOf("const SCANNER_SORTS"), dashboard.indexOf("function scannerRows"));
    const mainRow = dashboard.slice(dashboard.indexOf("function scannerRowHtml"), dashboard.indexOf("function closedRowHtml"));
    expect(sorts).not.toContain("targetBidPotentialPct");
    expect(mainRow).not.toContain("targetBidPotentialPct");
    expect(dashboard).toContain("targetBidPotentialPct");
    expect(dashboard).toContain("POTENTIAL, not executable profit");
  });
});
