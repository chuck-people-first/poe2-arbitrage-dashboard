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

  it("ranks scanner results by Divine profit per gold before percentage ROI", () => {
    const dashboard = readFileSync(new URL("../public/dashboard.js", import.meta.url), "utf8");
    const efficiencySort = dashboard.indexOf("b.discovery.estimatedDivPer100kGold");
    const percentageTieBreak = dashboard.indexOf("b.discovery.closedCycleProfitPct", efficiencySort);
    expect(efficiencySort).toBeGreaterThan(-1);
    expect(percentageTieBreak).toBeGreaterThan(efficiencySort);
  });
});
