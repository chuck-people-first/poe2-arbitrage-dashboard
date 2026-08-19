# Phase 0 Math Audit — Published Opportunities

Audit inputs: raw GGG completed-hour fixtures for 2026-08-18 21:00Z and 22:00Z; base currency is Divine Orb. All quantities below are integer Exchange quantities.

> These are cross-currency flips, not closed arbitrage loops: they end in Exalted Orb and require an independently observed Exalted→Divine valuation for comparison.

## Published row 1

- **Source hour:** 2026-08-18T22:00:00+00:00
- **Strategy:** two-leg-cross (cross-currency flip; not a closed loop)
- **Start:** 100 Chaos Orb
- **End:** 3300 Exalted Orb
- **Observed route legs:** 2

### Raw independent observations

1. **Chaos Orb → Divine Orb**, observation `Metadata/Items/Currency/CurrencyRerollRare|Metadata/Items/Currency/CurrencyModValues`
   - GGG pair: `Metadata/Items/Currency/CurrencyRerollRare | Metadata/Items/Currency/CurrencyModValues`
   - Low/high ratio rates in this direction: 0.090909090909 / 0.111111111111; midpoint used: **0.101010101010**
   - Executed hourly volume basis: **167365**; route receipt: **10**; share: **0.005975%**
   - Integer playbook: give **100** Chaos Orb, receive **10** Divine Orb
   - Gold: **10 × 800 = 8000**
2. **Divine Orb → Exalted Orb**, observation `Metadata/Items/Currency/CurrencyModValues|Metadata/Items/Currency/CurrencyAddModToRare`
   - GGG pair: `Metadata/Items/Currency/CurrencyModValues | Metadata/Items/Currency/CurrencyAddModToRare`
   - Low/high ratio rates in this direction: 300.000000000000 / 360.000000000000; midpoint used: **330.000000000000**
   - Executed hourly volume basis: **1198142**; route receipt: **3300**; share: **0.275426%**
   - Integer playbook: give **10** Divine Orb, receive **3300** Exalted Orb
   - Gold: **3300 × 120 = 396000**

### Published calculation reproduction

- Current engine input valuation: **2.533724340176 Divine Orb** via an alternate path selected after excluding the route edges.
- Output valuation: **64.960629921260 Divine Orb** via an independently observed path excluding the route edges.
- Published gross: **62.426905581084 = 64.960629921260 − 2.533724340176**.
- Published conservative: **62.173533147066**.
- Published expected: **47.906190819429**.
- Published ROI: **2453.839676%**.
- Gold total: **8000 + 396000 = 404000**.
- Profit/trade: **62.173533147066 ÷ 2 = 31.086766573533**.
- Profit/1M gold: **62.173533147066 ÷ 404000 × 1,000,000 = 153.894884027391**.
- Haircut components: ratio range **20% ÷ 2 = 10%**; EWMA/MAD volatility term **0%** for the two-point audit series; market-impact term **0.1 × √0.002754265 × 100 = 0.524811%**; selected haircut **max(10%, 0%, 0.524811%) = 10%**. Confidence **0.770524** is the labeled fill estimate.

### Defect determination and corrected calculation

The displayed **62.17 Divine / 2453.8%** is caused by an incorrect input valuation path: the engine excludes the route’s first Chaos→Divine observation, then finds an unrelated alternate path that values 100 Chaos at **2.533724 Divine**. The actual first Exchange leg is itself an independently observed Chaos→Divine conversion at **0.101010101010 Divine/Chaos**, so the input capital is **10.101010 Divine**.

Corrected: output **64.960630 Divine** − input **10.101010 Divine** = gross **54.859620 Divine**; movement haircut **10% × 10.101010 = 1.010101**; conservative **53.849519 Divine**; expected (between conservative and gross) **54.081313 Divine**; ROI **533.110236%**.

## Published row 2

- **Source hour:** 2026-08-18T21:00:00+00:00
- **Strategy:** two-leg-cross (cross-currency flip; not a closed loop)
- **Start:** 100 Chaos Orb
- **End:** 2970 Exalted Orb
- **Observed route legs:** 2

### Raw independent observations

1. **Chaos Orb → Divine Orb**, observation `Metadata/Items/Currency/CurrencyRerollRare|Metadata/Items/Currency/CurrencyModValues`
   - GGG pair: `Metadata/Items/Currency/CurrencyRerollRare | Metadata/Items/Currency/CurrencyModValues`
   - Low/high ratio rates in this direction: 0.090909090909 / 0.100000000000; midpoint used: **0.095454545455**
   - Executed hourly volume basis: **198325**; route receipt: **9**; share: **0.004538%**
   - Integer playbook: give **100** Chaos Orb, receive **9** Divine Orb
   - Gold: **9 × 800 = 7200**
2. **Divine Orb → Exalted Orb**, observation `Metadata/Items/Currency/CurrencyModValues|Metadata/Items/Currency/CurrencyAddModToRare`
   - GGG pair: `Metadata/Items/Currency/CurrencyModValues | Metadata/Items/Currency/CurrencyAddModToRare`
   - Low/high ratio rates in this direction: 300.000000000000 / 360.000000000000; midpoint used: **330.000000000000**
   - Executed hourly volume basis: **1202662**; route receipt: **2970**; share: **0.246952%**
   - Integer playbook: give **9** Divine Orb, receive **2970** Exalted Orb
   - Gold: **2970 × 120 = 356400**

### Published calculation reproduction

- Current engine input valuation: **3.471074380165 Divine Orb** via an alternate path selected after excluding the route edges.
- Output valuation: **12.063829787234 Divine Orb** via an independently observed path excluding the route edges.
- Published gross: **8.592755407069 = 12.063829787234 − 3.471074380165**.
- Published conservative: **8.277203190690**.
- Published expected: **6.668713251308**.
- Published ROI: **238.462282%**.
- Gold total: **7200 + 356400 = 363600**.
- Profit/trade: **8.277203190690 ÷ 2 = 4.138601595345**.
- Profit/1M gold: **8.277203190690 ÷ 363600 × 1,000,000 = 22.764585232921**.
- Haircut components: ratio range **18.181818% ÷ 2 = 9.090909%**; EWMA/MAD volatility term **0%** for the two-point audit series; market-impact term **0.1 × √0.002469522 × 100 = 0.496943%**; selected haircut **max(9.090909%, 0%, 0.496943%) = 9.090909%**. Confidence **0.805672** is the labeled fill estimate.

### Defect determination and corrected calculation

The displayed **8.28 Divine / 238.5%** is caused by an incorrect input valuation path: the engine excludes the route’s first Chaos→Divine observation, then finds an unrelated alternate path that values 100 Chaos at **3.471074 Divine**. The actual first Exchange leg is itself an independently observed Chaos→Divine conversion at **0.095454545455 Divine/Chaos**, so the input capital is **9.545455 Divine**.

Corrected: output **12.063830 Divine** − input **9.545455 Divine** = gross **2.518375 Divine**; movement haircut **9.090909% × 9.545455 = 0.867769**; conservative **1.650607 Divine**; expected (between conservative and gross) **1.819238 Divine**; ROI **17.292070%**.

## Duplicate determination

The two rows are **not sizing variants**: they have identical route currencies and legs but different source hours (21:00Z vs 22:00Z), different observed rates, integer receipts (2,970 vs 3,300), and different profits. They are alternative historical-hour observations of the same route family. The main dashboard must expose only the latest successful hour; historical alternatives belong in a separate history projection.

## Proposed safe changes (feature branch only)

1. `scoreCandidate()` values input capital with the first observed leg when that leg directly converts into the base currency; it no longer searches an unrelated alternate route and inflates ROI.
2. Expected profit is defined between conservative and gross: `expected = conservative + (gross - conservative) × (1 - confidence)`.
3. `validateCalculatedRoute()` rejects structured invariant violations: invalid observations/quantities, missing valuation paths, non-closed loops, non-positive conservative profit, stale rows, volume-cap breaches, profit ordering, ROI, gold, trade-count, and bottleneck mismatches.
4. `013_latest_hour_view.sql` keeps the security-invoker safe projection but filters each league to `max(source_hour)`. It is not applied remotely in this phase.
5. `dedupeSizingVariants()` is deterministic and is intended to run within one source-hour set. The two currently published rows are different hours, so they must not be deduplicated as sizes; the latest-hour view removes the older row from the main count.

Supabase guidance consulted: [RLS and security-invoker views](https://supabase.com/docs/guides/database/postgres/row-level-security) and [view security](https://supabase.com/docs/guides/database/tables). No Supabase deployment was changed.

## Golden-test coverage added locally

- valid cross-currency flip;
- genuine closed-loop finish requirement;
- mixed-unit/gross mismatch;
- inverted/non-positive observed rate;
- missing base valuation;
- integer rounding to zero;
- gold/movement eliminating profit;
- stale observation;
- volume above 20% cap;
- duplicate sizing variants;
- genuinely different routes sharing currencies;
- corrected 2026-08-18 22:00 source-hour calculation;
- actual `opportunity_public` snake_case fixture normalization remains covered by the existing 3 dashboard normalization tests.
