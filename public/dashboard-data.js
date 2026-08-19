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
    };
  }

  // Resolve one GGG path to a readable label. This is ONLY a diagnostics
  // fallback: the authoritative product projection is route.flip (resolved
  // server-side, with unmapped items dropped). If a flip is unavailable, the
  // raw last-segment is shown so the operator sees why it was not promoted.
  function name(path) {
    if (typeof path !== 'string' || !path.trim()) return 'Unknown currency';
    const x = path.split('/').filter(Boolean).pop() || path;
    return x.replaceAll('-', ' ').replaceAll('_', ' ').replace(/\b\w/g, c => c.toUpperCase());
  }

  root.POE2Dashboard = { normalizeOpportunityRow, name };
})(window);
