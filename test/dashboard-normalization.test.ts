import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

type DashboardApi = {
  normalizeOpportunityRow: (row: Record<string, unknown>) => Record<string, any>;
  name: (path: unknown) => string;
};

const source = readFileSync(resolve("public/dashboard-data.js"), "utf8");
const context = { window: {} as Record<string, unknown> };
vm.runInNewContext(source, context);
const api = context.window.POE2Dashboard as DashboardApi;
const rows = JSON.parse(readFileSync(resolve("test/fixtures/opportunity-public-response.json"), "utf8")) as Record<string, unknown>[];

describe("production opportunity response normalization", () => {
  it("overlays projection values while preserving route legs", () => {
    const route = api.normalizeOpportunityRow(rows[0]!);
    expect(route.startCurrency).toBe("Metadata/Items/Currency/CurrencyModValues");
    expect(route.endCurrency).toBe("Metadata/Items/Currency/CurrencyRerollRare");
    expect(route.legs).toHaveLength(2);
    expect(route.legs[0].playbook.give).toBe(100);
    expect(route.startUnits).toBe(100);
    expect(route.conservativeProfitBase).toBe(6.81);
    expect(route.goldCostTotal).toBe(303800);
  });

  it("normalizes two rows and tolerates missing optional route values", () => {
    const routes = rows.map(api.normalizeOpportunityRow);
    expect(routes).toHaveLength(2);
    expect(routes[1]!.legs[0]!.playbook.receive).toBe(3350);
    expect(routes[1]!.fillConfidence).toBe(0);
    expect(routes[1]!.movementHaircutPct).toBe(0);
  });

  it("provides safe names and preserves renderable quantities", () => {
    const routes = rows.map(api.normalizeOpportunityRow);
    const rendered = routes.map((route) => `${route.startUnits} ${api.name(route.startCurrency)} → ${route.endUnits} ${api.name(route.endCurrency)} (${route.legs[0].playbook.give})`);
    expect(rendered).toHaveLength(2);
    expect(rendered[0]).toContain("100 CurrencyModValues");
    expect(rendered[0]).toContain("2465 CurrencyRerollRare");
    expect(api.name(undefined)).toBe("Unknown currency");
    expect(api.name(" ")).toBe("Unknown currency");
  });
});
