(function () {
  if (!window.POE2_DEMO_DATA) return;
  const sourceHour = new Date();
  sourceHour.setUTCMinutes(0, 0, 0);
  const hour = sourceHour.toISOString();
  const EXALTED = 'Metadata/Items/Currency/CurrencyAddModToRare';
  const CHAOS = 'Metadata/Items/Currency/CurrencyRerollRare';
  const DIVINE = 'Metadata/Items/Currency/CurrencyModValues';
  const rate = (from, to, value) => ({ from_currency: from, to_currency: to, rate: value, source_hour: hour });
  window.POE2_DEMO_DATA.currencyRates = [
    rate(EXALTED, CHAOS, 0.049228),
    rate(CHAOS, EXALTED, 23.5),
    rate(EXALTED, DIVINE, 0.002928),
    rate(DIVINE, EXALTED, 341.5),
    rate(CHAOS, DIVINE, 0.095455),
    rate(DIVINE, CHAOS, 10.5),
  ];
})();
