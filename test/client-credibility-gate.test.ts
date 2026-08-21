// The dashboard renders whatever the last SUCCESSFUL ingest wrote, which can be
// an older algorithm version than the checked-in scanner. These tests pin the
// client-side re-application of the ingest's own gates, using the exact row
// shape production was serving on 2026-08-21 (algorithm phase8-second-source-1)
// — the hour where a market of 2 units sat at the top of the board.

import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

import { MIN_ITEM_HOURLY_VOLUME, MAX_PLAUSIBLE_SPREAD_PCT } from "../src/domain/market-signals.js";

const source = readFileSync(new URL("../public/dashboard-data.js", import.meta.url), "utf8");

type Api = {
  credibilityFault: (d: unknown) => string | null;
  isCredibleSignal: (d: unknown) => boolean;
  MIN_ITEM_HOURLY_VOLUME: number;
  MAX_PLAUSIBLE_SPREAD_PCT: number;
};

function load(): Api {
  const context: { window?: Record<string, unknown> } = {};
  context.window = context as unknown as Record<string, unknown>;
  runInNewContext(source, context);
  return (context.window as { POE2Dashboard: Api }).POE2Dashboard;
}

const api = load();

/** Shaped like a stored row's `route.discovery`. */
const discovery = (overrides: Record<string, unknown> = {}) => ({
  itemHourlyVolume: 500,
  priceModel: { twoLegSpreadPct: 12 },
  ...overrides,
});

describe("client-side credibility gate", () => {
  it("uses the same thresholds as the ingest", () => {
    // If these drift, the dashboard and the scanner disagree about what is
    // tradeable and the board becomes unexplainable.
    expect(api.MIN_ITEM_HOURLY_VOLUME).toBe(MIN_ITEM_HOURLY_VOLUME);
    expect(api.MAX_PLAUSIBLE_SPREAD_PCT).toBe(MAX_PLAUSIBLE_SPREAD_PCT);
  });

  it("passes a liquid, plausibly priced round trip", () => {
    expect(api.credibilityFault(discovery())).toBeNull();
    expect(api.isCredibleSignal(discovery())).toBe(true);
  });

  it("suppresses the 2-unit market production ranked first", () => {
    // Amanamu's Gaze, 2026-08-21T13:00Z: buy leg received 2 units, sell leg
    // supplied 2, and the row claimed +202% net.
    const amanamu = discovery({ itemHourlyVolume: 2, priceModel: { twoLegSpreadPct: 202.5 } });
    expect(api.credibilityFault(amanamu)).toBe("thin-market");
  });

  it("suppresses the market exactly one unit below the floor, and admits it at the floor", () => {
    expect(api.isCredibleSignal(discovery({ itemHourlyVolume: MIN_ITEM_HOURLY_VOLUME - 1 }))).toBe(false);
    expect(api.isCredibleSignal(discovery({ itemHourlyVolume: MIN_ITEM_HOURLY_VOLUME }))).toBe(true);
  });

  it("suppresses a round trip that ends with less than it started", () => {
    // "52 Chaos in, 22 Chaos out" is not an opportunity at any filter setting.
    expect(api.credibilityFault(discovery({ priceModel: { twoLegSpreadPct: -57.69 } }))).toBe("negative-spread");
    expect(api.credibilityFault(discovery({ priceModel: { twoLegSpreadPct: 0 } }))).toBe("negative-spread");
  });

  it("suppresses a four-figure spread as an identity fault, not an edge", () => {
    expect(api.credibilityFault(discovery({ priceModel: { twoLegSpreadPct: 5316 } }))).toBe("implausible-spread");
    expect(api.isCredibleSignal(discovery({ priceModel: { twoLegSpreadPct: MAX_PLAUSIBLE_SPREAD_PCT } }))).toBe(true);
  });

  it("falls back to the pre-priceModel field name older ingests wrote", () => {
    // phase8 rows carry twoLegProfitPct and no priceModel.twoLegSpreadPct.
    expect(api.credibilityFault({ itemHourlyVolume: 500, twoLegProfitPct: 12 })).toBeNull();
    expect(api.credibilityFault({ itemHourlyVolume: 500, twoLegProfitPct: -3 })).toBe("negative-spread");
  });

  it("suppresses a row with no usable price at all rather than treating it as free money", () => {
    expect(api.credibilityFault({ itemHourlyVolume: 500 })).toBe("unpriced");
    expect(api.credibilityFault({ itemHourlyVolume: 500, priceModel: { twoLegSpreadPct: null } })).toBe("unpriced");
    expect(api.credibilityFault(null)).toBe("no-signal");
  });
});
