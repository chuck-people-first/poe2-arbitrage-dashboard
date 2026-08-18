(function (root) {
  function normalizeOpportunityRow(row) {
    const route = row && row.route && typeof row.route === 'object' ? row.route : {};
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
      legs: Array.isArray(route.legs) ? route.legs : []
    };
  }

  function name(path) {
    if (typeof path !== 'string' || !path.trim()) return 'Unknown currency';
    const x = path.split('/').filter(Boolean).pop() || path;
    return x.replaceAll('-', ' ').replaceAll('_', ' ').replace(/\b\w/g, c => c.toUpperCase());
  }

  root.POE2Dashboard = { normalizeOpportunityRow, name };
})(window);
