(function (root) {
  const HUBS = {
    'Metadata/Items/Currency/CurrencyAddModToRare': { name: 'Exalted Orb', short: 'Exalted' },
    'Metadata/Items/Currency/CurrencyRerollRare': { name: 'Chaos Orb', short: 'Chaos' },
    'Metadata/Items/Currency/CurrencyModValues': { name: 'Divine Orb', short: 'Divine' },
  };

  const PAIRS = [
    ['Metadata/Items/Currency/CurrencyAddModToRare', 'Metadata/Items/Currency/CurrencyRerollRare'],
    ['Metadata/Items/Currency/CurrencyAddModToRare', 'Metadata/Items/Currency/CurrencyModValues'],
    ['Metadata/Items/Currency/CurrencyRerollRare', 'Metadata/Items/Currency/CurrencyModValues'],
  ];

  const key = (from, to) => `${from}->${to}`;

  function latestRows(rows) {
    const valid = (Array.isArray(rows) ? rows : []).filter(row => Number.isFinite(Date.parse(row?.source_hour)));
    if (!valid.length) return { sourceHour: null, byDirection: new Map() };

    const latestMs = Math.max(...valid.map(row => Date.parse(row.source_hour)));
    const byDirection = new Map();
    for (const row of valid) {
      if (Date.parse(row.source_hour) !== latestMs) continue;
      const direction = key(row.from_currency, row.to_currency);
      if (!byDirection.has(direction)) byDirection.set(direction, row);
    }
    return { sourceHour: new Date(latestMs).toISOString(), byDirection };
  }

  function rateValue(row) {
    const value = Number(row?.rate);
    return Number.isFinite(value) && value > 0 ? value : null;
  }

  function pairModels(rows) {
    const latest = latestRows(rows);
    return {
      sourceHour: latest.sourceHour,
      pairs: PAIRS.map(([left, right]) => ({
        left: HUBS[left],
        right: HUBS[right],
        leftToRight: rateValue(latest.byDirection.get(key(left, right))),
        rightToLeft: rateValue(latest.byDirection.get(key(right, left))),
      })),
    };
  }

  function ageLabel(sourceHour, nowMs = Date.now()) {
    const sourceMs = Date.parse(sourceHour);
    if (!Number.isFinite(sourceMs)) return 'Source time unavailable';
    const minutes = Math.max(0, Math.floor((nowMs - sourceMs) / 60000));
    if (minutes < 1) return 'just updated';
    if (minutes < 60) return `${minutes}m old`;
    const hours = minutes / 60;
    return `${hours < 10 ? hours.toFixed(1) : Math.floor(hours)}h old`;
  }

  function currencyName(path) {
    return HUBS[path]?.name || null;
  }

  root.POE2CurrencyRates = { HUBS, PAIRS, latestRows, pairModels, ageLabel, currencyName };
})(window);
