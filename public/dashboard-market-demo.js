(function () {
  const demo = window.POE2_DEMO_DATA;
  const row = demo?.routes?.find(candidate => candidate?.cycle?.closed || candidate?.route?.cycle?.closed);
  const cycle = row?.cycle || row?.route?.cycle;
  if (!row || !cycle) return;
  row.route.discovery = {
    id: 'demo-market-signal', familyId: 'fam-tul-market-demo', league: demo.league,
    sourceHourUtc: cycle.sourceHourUtc, item: cycle.item, buyCurrency: cycle.startCurrency,
    sellCurrency: cycle.sellCurrency || { id: 'Metadata/Items/Currency/CurrencyModValues', name: 'Divine Orb', iconUrl: null, goldCostPerUnit: 800 },
    buyLeg: { ...cycle.buyLeg, goldVerified: false },
    sellLeg: { ...cycle.sellLeg, goldVerified: true },
    returnLeg: { ...cycle.returnLeg, goldVerified: true },
    buyRatio: { want: 1, have: 53, side: 'conservative-hourly' },
    sellRatio: { want: 1, have: 31, side: 'conservative-hourly' },
    returnRatio: { want: 170, have: 1, side: 'conservative-hourly' },
    buyRatioRange: {
      favorable: { want: 1, have: 28, side: 'favorable-hourly' },
      conservative: { want: 1, have: 53, side: 'conservative-hourly' },
      source: 'ggg-completed-hour-boundaries'
    },
    sellRatioRange: {
      favorable: { want: 1, have: 28, side: 'favorable-hourly' },
      conservative: { want: 1, have: 31, side: 'conservative-hourly' },
      source: 'ggg-completed-hour-boundaries'
    },
    returnRatioRange: {
      favorable: { want: 180, have: 1, side: 'favorable-hourly' },
      conservative: { want: 170, have: 1, side: 'conservative-hourly' },
      source: 'ggg-completed-hour-boundaries'
    },
    twoLegProfitPct: 50.6, closedCycleProfitPct: (340 / 265 - 1) * 100,
    startingQuantity: 265, finalStartingQuantity: 340, totalGold: null,
    estimatedTotalGold: 19100, estimatedGoldPerUnknownUnit: 250,
    goldEstimateBasis: 'Breach fallback: 250 gold per unit received',
    estimatedProfitDivine: 0.44, estimatedDivPer100kGold: 2.3037,
    goldVerified: false, itemHourlyVolume: 413, maxVolumeShare: 0.01,
    fillRisk: 0.08, fillRiskLabel: 'Low', ratioRangePct: 4,
    recommendation: 'WATCH',
    warning: 'Item gold fee is not verified; check the in-game fee before trading.'
  };
})();
