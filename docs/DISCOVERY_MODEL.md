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

## The round trip is the product

The flow the player actually runs is three trades, not two:

```
pay Exalted or Chaos  →  hold the item  →  sell for Divine  →  convert Divine back
```

A two-leg spread that stops at "you now hold Divine" has not produced any of
the currency the player started with. So `MarketSignal.flow` (`SignalFlow`)
carries the whole chain as executable quantities — each step in the Exchange's
own vocabulary, *you HAVE this, you WANT that* — and it is the closing step
that decides whether a net figure exists at all:

- `closesInStartCurrency` is false when no integer order size closes the loop
  inside the observed hourly volume. `finalUnits`, `netUnits` and `netPct` are
  then null. The steps still describe the path; they do not describe a
  completed trip, and the row says so rather than implying one.
- `netUnits` is the number that matters: what the player ends with minus what
  they started with, in the currency they started with.

`test/signal-flow.test.ts` pins the chain: each step's WANT is the next step's
HAVE (both currency and quantity), the first HAVE is the starting currency, the
last WANT is the starting currency again, and a net figure never appears for a
loop that did not close.

### Flow presets

The scanner opens on **My flow** — buy with Exalted or Chaos, sell for Divine,
convert back — because that is what gets run most of the time. **Exalted only**
narrows to `Exalted → item → Divine → Exalted`; **All paths** restores every hub
pair, including Divine-funded routes. On the fixture hour: 23 / 11 / 49 rows.

### Ranking

Default order is: return-confirmed first, then loops that actually close in
profit, then Div / 100K gold, then the lighter liquidity footprint, then depth,
then the raw spread. The gold-efficiency metric is measured on the *midpoint
spread*, so ranking on it alone floats rows whose real loop loses money to the
top — the closed-and-profitable tier exists to stop that.

### Liquidity band

`liquidityBand()` reads only the order's share of the observed hour: ≤5% Low,
≤20% Medium, above that High. The shared `estimateFillRisk` blends in the
hourly ratio range, which is wide for nearly every GGG completed-hour market,
so its label saturates at High and stops distinguishing anything. That heuristic
still drives the other tabs and the drawer, where the share and range that
produced it are on screen beside it.
