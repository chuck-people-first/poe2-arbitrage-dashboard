(function (root) {
  function normalizeOpportunityRow(row) {
    const route = row && row.route && typeof row.route === 'object' ? row.route : {};
    const valuation = route && route.valuation && typeof route.valuation === 'object' ? route.valuation : {};
    return {
      ...route,
      id: row?.id ?? route.id,
      strategy: row?.strategy ?? route.strategy,
      playbook: row?.playbook ?? route.playbook ?? [],
      startCurrency: row?.start_currency ?? route.startCurrency,
      endCurrency: row?.end_currency ?? route.endCurrency,
      startUnits: Number(row?.start_units ?? route.startUnits ?? 0),
      endUnits: Number(row?.end_units ?? route.endUnits ?? 0),
      grossProfitBase: Number(row?.gross_profit_base ?? route.grossProfitBase ?? 0),
      conservativeProfitBase: Number(row?.conservative_profit_base ?? route.conservativeProfitBase ?? 0),
      expectedProfitBase: Number(row?.expected_profit_base ?? route.expectedProfitBase ?? 0),
      goldCostTotal: Number(row?.gold_cost ?? route.goldCostTotal ?? 0),
      legCount: Number(row?.leg_count ?? route.legCount ?? route.legs?.length ?? 0),
      bottleneckVolumeShare: Number(row?.bottleneck_volume_share ?? route.bottleneckVolumeShare ?? 0),
      ratioRangePct: Number(row?.ratio_range_pct ?? route.ratioRangePct ?? 0),
      movementHaircutPct: Number(row?.movement_haircut_pct ?? route.movementHaircutPct ?? 0),
      fillConfidence: Number(row?.fill_confidence ?? route.fillConfidence ?? 0),
      score: Number(row?.score ?? route.score ?? 0),
      sourceHour: row?.source_hour ?? route.sourceHour,
      league: row?.league ?? route.league,
      algorithmVersion: row?.algorithm_version ?? route.algorithmVersion ?? null,
      dataAgeHours: route.dataAgeHours ?? 0,
      dataAgeIntervalHours: row?.data_age
        ? (typeof row.data_age === 'number' ? row.data_age / 3600 : 0)
        : (route.dataAgeHours ?? 0),
      legs: Array.isArray(route.legs) ? route.legs : [],
      // item 4: valuation-path risk disclosure
      valuationBottleneckVolumeShare: Number(row?.valuation_bottleneck_volume_share ?? valuation.valuationBottleneckVolumeShare ?? 0),
      valuationRangeUncertaintyPct: Number(row?.valuation_range_uncertainty_pct ?? valuation.valuationRangeUncertaintyPct ?? 0),
      valuationConfidence: Number(row?.valuation_confidence ?? valuation.valuationConfidence ?? 0),
      valuationExecutable: row?.valuation_executable ?? valuation.valuationExecutable ?? false,
      valuationGoldIncluded: row?.valuation_gold_included ?? valuation.valuationGoldIncluded ?? false,
      valuationTradeCountIncluded: Number(row?.valuation_trade_count_included ?? valuation.valuationTradeCountIncluded ?? 0),
      // item 5: profit classification
      profitClass: row?.profit_class ?? route.profitClass ?? (row?.strategy === 'closed-triangle' || route.strategy === 'closed-triangle' ? 'closed-realized' : 'mark-to-market'),
      realizedCurrency: row?.realized_currency ?? route.realizedCurrency ?? null,
      realizedProfitStart: route.realizedProfitStart ?? null,
      realizedProfitBase: route.realizedProfitBase ?? null,
      // Phase A: the Edge Function embeds the resolved two-leg flip under
      // route.flip. Where present it is the authoritative product projection.
      cycle: route.cycle || row?.cycle || null,
      flip: route.flip || null,
      discovery: route.discovery || null,
    };
  }

  // Resolve one GGG path to a readable label. This is ONLY a diagnostics
  // fallback: the authoritative product projection is route.flip (resolved
  // server-side, with unmapped items dropped). If a flip is unavailable, the
  // raw last-segment is shown so the operator sees why it was not promoted.
  function name(path) {
    if (typeof path !== 'string' || !path.trim()) return 'Unknown currency';
    const hubName = root.POE2CurrencyRates?.currencyName(path);
    if (hubName) return hubName;
    const x = path.split('/').filter(Boolean).pop() || path;
    return x.replaceAll('-', ' ').replaceAll('_', ' ').replace(/\b\w/g, c => c.toUpperCase());
  }


  // The ingest applies a liquidity floor and a plausibility cap before it
  // publishes (src/domain/market-signals.ts). The dashboard, however, renders
  // whatever the last SUCCESSFUL ingest wrote — which can be an older
  // algorithm version that predates those gates, and stays on screen until an
  // ingest with the new version lands. Re-applying the same two thresholds
  // here means a one-unit market can never sit at the top of the board just
  // because the Edge Function has not been redeployed yet.
  //
  // Keep these two numbers identical to MIN_ITEM_HOURLY_VOLUME and
  // MAX_PLAUSIBLE_SPREAD_PCT in src/domain/market-signals.ts.
  const MIN_ITEM_HOURLY_VOLUME = 25;
  const MAX_PLAUSIBLE_SPREAD_PCT = 300;

  // Why a stored signal is not fit to show, or null when it is fit.
  // Returning the reason (rather than a boolean) lets the empty state explain
  // itself instead of looking like a broken page.
  function credibilityFault(discovery) {
    if (!discovery) return 'no-signal';
    const volume = Number(discovery.itemHourlyVolume);
    if (!Number.isFinite(volume) || volume < MIN_ITEM_HOURLY_VOLUME) return 'thin-market';
    const spread = Number(discovery.priceModel?.twoLegSpreadPct ?? discovery.twoLegProfitPct);
    if (!Number.isFinite(spread)) return 'unpriced';
    // A round trip that gives back less than it takes is not an opportunity,
    // whatever the ingest scored it.
    if (spread <= 0) return 'negative-spread';
    // Past this the buy and sell markets disagree about what the item IS.
    if (spread > MAX_PLAUSIBLE_SPREAD_PCT) return 'implausible-spread';
    return null;
  }

  const isCredibleSignal = discovery => credibilityFault(discovery) === null;

  root.POE2Dashboard = {
    normalizeOpportunityRow, name, credibilityFault, isCredibleSignal,
    MIN_ITEM_HOURLY_VOLUME, MAX_PLAUSIBLE_SPREAD_PCT,
  };
})(window);
