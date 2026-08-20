# Discovery model: three figures, one classification

The Market Scanner has two jobs that pull in opposite directions. It has to be
*broad* — a long list of items mispriced across the Exalted, Chaos and Divine
markets, the way Divine Tendies is broad — and it has to be *honest*, because
the official GGG feed cannot prove most of what a broad list shows.

The resolution: list broadly, but never let one number carry two meanings.

## Why the list used to be one or two rows

Measured on the checked-in real GGG hour (`fixtures/ggg-currency-exchange-1787090400.json`,
2026-08-18T22:00Z). These counts are asserted in `test/scanner-discovery-funnel.test.ts`,
so a change to any of them is a deliberate product change:

| Stage | Count |
|---|---|
| Markets in league | 1,389 |
| Readable hub → item → hub families | 98 |
| Families with a direct return market | 98 |
| Positive using favorable boundaries | 83 |
| Positive using the hourly midpoint | 49 |
| Midpoint profit ≥ 25% | 28 |
| Positive using every conservative edge | 14 |

The old scanner required a positive **conservative** closed cycle just to
appear. That is the 98 → 14 collapse. The UI then applied a 25% minimum cycle
P&L and a volume floor on top, which is how production ended up showing one or
two rows.

Discovery is now gated on the **midpoint**, so the list is the 49.

## The three figures

They live on `MarketSignal.priceModel` and must never be collapsed into one.

**`twoLegSpreadPct` — discovery.** The item's price in the starting currency
from the buy market, versus its price implied by (sell market → return market),
every leg at that market's completed-hour midpoint. Gold excluded. This is the
"same item, mispriced across two currencies" number, and the only one the list
is ranked on.

**`targetBidPotentialPct` — potential, never executable.** The same path with
every leg at its *favorable* boundary. It exists so the width of the hourly
range is visible. It appears exactly once, in the drawer, under a label saying
it is not executable profit. It is never in a row headline and never in a
comparator — `test/currency-rate-ui.test.ts` asserts both.

**`returnConfirmedCyclePct` — the only closed cycle.** Exact integer sizing at
the *least-favorable* observed boundary on all three legs, with all three gold
fees. Null when no independent return market was observed, or when no integer
sizing closes inside the observed hourly liquidity.

### The rule these exist to enforce

GGG publishes an hourly aggregate, not an order book. `rateHigh` is the most
favorable trade seen *somewhere* in that hour. Three favorable boundaries from
three different markets may have occurred at three different moments and may
never have been simultaneously executable. Multiplying them produced the
+25,900% results; on the fixture hour the favorable compound still reaches
+1613%, against a best return-confirmed cycle of +131%.

`compoundPct()` in `src/domain/market-signals.ts` takes a *side selector* and
applies it to every leg, so each published percentage is reproducible from one
consistent side of every leg's range. Mixing sides is structurally impossible.

## The classification

`MarketSignal.classification` says how much of the equation a row has proven.
It — not the score — decides what a row is allowed to claim.

| Classification | Meaning |
|---|---|
| `return-confirmed` | Conservative closed cycle is positive and every gold fee is verified. The only row that may be called a closed cycle. |
| `fee-check-needed` | Conservative closed cycle is positive but at least one item gold fee is a category estimate. |
| `return-quote-available` | A return market exists and is priced, but the conservative cycle is not positive. The spread is real; the round trip is not proven. |
| `two-leg-spread` | Item mispricing only; no independent return market observed. |
| `high-risk` | No sizing fits inside the observed hourly liquidity, or the sizing consumes more than 20% of it. Overrides the others: liquidity, not price, is the binding constraint. |

`TRADE NOW` remains reserved for the Verified Closed Cycles tab, which runs the
separate scored-route path. No discovery row can reach it.

## Sizing

`chooseSizing()` reports the best plan that stays **inside** the liquidity cap
(`RunSettings.maxVolumeSharePct`), not the best plan at any size. Two failure
modes are being avoided: sizing up until `maxVolumeShare` — the number the
classification keys on — becomes an artifact of the sizer's ambition, and
sizing down until integer flooring, rather than the market, dictates the
closed-cycle percentage. A batch whose return leg floors to zero units is
rejected: reporting its −100% as the closed-cycle result is noise.

## Price source

The broad scanner uses the GGG completed-hour **midpoint**. poe.ninja's
directional rates (`/poe2/api/economy/exchange/current/{overview,details}`)
remain the intended independent price source for discovery; until that
integration lands, the midpoint is the consistent model and the conservative
boundary stays the risk/verification source. The official GGG feed continues to
serve as audit source, currency reference, historical fallback and boundary
information.

## History

`supabase/migrations/016_discovery_signal_history.sql` extends
`complete_poe2_ingestion` so discovery families get the same append-only hourly
retention as verified cycles. What is retained is the ratio that *caused* the
row — the conservative boundaries the player was told to type — alongside the
midpoint metric the list is ranked on, so the series is comparable hour over
hour. Before this, no scanner family had any history and every drawer read
INSUFFICIENT HISTORY forever.
