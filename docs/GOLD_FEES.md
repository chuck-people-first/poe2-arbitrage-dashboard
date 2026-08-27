# The gold cost, and which items are worth working on

Short version: the gold fee is not a market number and never needed
estimating. It is a static per-item constant that ships in the game's own
data, it is published in full, and we now carry **all 669 of them** instead of
the 13 that were entered by hand. Of the 521 paths that actually traded in the
last ingested hour, the fee-verified count went from **13 to 521**.

The second half of this note is the more useful half: with real fees in place,
the thing that decides whether a route is worth running is **which
denomination each leg lands in**, and it is not close.

## How the fee works

An order's gold cost is

```
gold = (units received on the "I want" side) x (that item's fee)
```

The fee is a fixed number per item — 120 for an Exalted Orb, 800 for a Divine
Orb, 25,000 for a Mirror — and it does not move with price, volume, or the
size of your order. The seller pays nothing; the buyer pays all of it, and
pays it again on the way back.

Three independent checks that this is the rule and not a coincidence:

| observation | our arithmetic |
|---|---|
| A player quoted an 80k fee buying ~660 Exalted to reach 3 Divine ([GGG forum](https://www.pathofexile.com/forum/view-thread/3855933)) | 660 x 120 = **79,200** |
| 39,000 gold for one Divine's worth of Exalted at ~325:1 ([r/PathOfExile2](https://www.reddit.com/r/PathOfExile2/comments/1q5tul8/gold_cost_of_exchanging_currency)) | 325 x 120 = **39,000** |
| The community rule of thumb — "the fee tends to be about the amount of individual currency you'd get" | the same statement, for a fee near 100/unit |

`flipLeg()` in `src/domain/market-signals.ts` already computed
`receive x fee`, so the model was right all along. Only the table was thin.

## Where the numbers come from

[poe2db's Currency Exchange page](https://poe2db.tw/us/Currency_Exchange)
publishes the game's exchange table verbatim: every tradeable item, grouped by
the tab it appears under, with its fee. Each item's own page carries its
`Metadata/Items/...` path. **Identity and fee therefore arrive off the same
page** — no name matching, no price-similarity inference, nothing guessed.
That is what makes these fees verified rather than estimated.

- `scripts/generate-exchange-fees.ts` — the scraper. `--refetch` re-reads
  poe2db; without it, it regenerates from the checked-in fixture.
- `fixtures/poe2db/currency-exchange-fees.json` — the captured table.
- `src/domain/fees.generated.ts` — 669 entries, keyed by GGG metadata path.

`goldCostPerUnit()` reads this table by path, so a fee no longer depends on how
an item's *name* was established. A path that is not on the exchange still
reports `{ cost: 0, verified: false }`; an unknown fee is never spent as zero.

Two things the generator refuses to do quietly, both learned the hard way:

- A page that comes back without a metadata path is a **failed fetch**, not an
  item without one. It is retried serially and then raises, because dropping
  it silently would remove a fee and turn a priced route into an unpriceable
  one.
- Where a page names more than one path, quest-item variants are excluded by
  path **segment** (`/Quest...`), and the path the GGG feed actually quotes
  wins. A loose case-insensitive search for "quest" silently ate a real item:
  `CurrencyVerisiumOreUniqueStolvarheim` contains "queSt".

Re-run `--refetch` after a patch that adds or reprices exchangeable items.
Nothing else changes it.

## What was wrong before

The 13 hand-entered fees were all **exactly right** — the wiki table was
correct, just tiny. Everything else fell through to a per-category guess, and
those guesses were badly wrong, because a category is not a price:

| exchange tab | real fees (min / median / max) | old category guess | median error |
|---|---|---|---|
| Gems | 1,000 / 1,000 / 1,000 | 9,000 | **800%** |
| Atziri's Temple | 250 / 250 / 1,500 | 1,000 | **300%** |
| Essences | 50 / 315 / 1,000 | 1,000 | **218%** |
| Currency | 1 / 405 / 25,000 | 1,000 | **150%** |
| Breach | 3 / 560 / 5,000 | 250 | 81% |
| Delirium | 3 / 610 / 1,500 | 1,000 | 68% |
| Expedition | 10 / 1,500 / 16,107 | 1,000 | 50% |

The Currency row is the point: fees inside one tab span **1 to 25,000**. No
single number per category could have worked.

## Which ones are worth working on

Because the fee is per *unit*, the gold cost of a leg is set by how many units
it takes to hold a given amount of value. Call that **gold intensity**: the
gold it costs to move one Divine of value through an item.

```
gold intensity = fee per unit / item's Divine price
```

Reproduce with `npx tsx scripts/audit-gold-intensity.ts`. On the last ingested
hour (2026-08-21T01:00Z, Runes of Aldur):

| currency | fee/unit | gold to move 1 Divine of value |
|---|---|---|
| Mirror of Kalandra | 25,000 | **5** |
| Hinekora's Lock | 6,000 | **5** |
| Fracturing Orb | 1,000 | **118** |
| Divine Orb | 800 | **800** |
| Chaos Orb | 160 | 1,760 |
| Orb of Annulment | 1,000 | 2,500 |
| Perfect Jeweller's Orb | 1,000 | 5,000 |
| Vaal Orb | 160 | 20,800 |
| **Exalted Orb** | 120 | **42,300** |
| Regal Orb | 120 | 84,600 |
| Orb of Alchemy | 200 | 140,200 |

**One Exalted leg costs ~53x what the same value costs as Divine.** A round
trip that touches Exalted starts ~42,000 gold in the hole per Divine of
capital before the spread has done anything. Ranking every pair that
traded on both sides this hour by gold spent per Divine of profit:

- Divine-denominated pairs on chunky items: **800–2,000 gold** per round trip
  per Divine of capital, i.e. roughly **3,000–6,000 gold per Divine of
  profit**.
- Anything quoted in Exalted: **~42,000 gold** per round trip, i.e.
  **1.1M–4.5M gold per Divine of profit**, and that is on the pairs whose
  spread is still positive.

So the shortlist is not "widest spread". It is:

1. **Both legs land in Divine or something dearer than Divine.** Lineage
   support gems (~250–450 Divine each, 1,000 gold flat), Mirrors, Hinekora's
   Locks, Fracturing Orbs, high-tier fragments and idols. These are
   effectively gold-free to trade — the fee is a rounding error against the
   value moved — so their whole spread is yours.
2. **Chaos as the small-denomination leg, never Exalted.** Chaos is 24x
   cheaper per unit of value moved (1,760 vs 42,300) for the same job.
3. **Avoid Exalted, Regal, Alchemy, Transmutation, Augmentation and the
   Jeweller's line as *transit* currencies.** Trading them as the destination
   is fine when the spread is genuinely large; routing *through* them to reach
   something else is what burns the gold.

### The default flow preset is the expensive one

`public/dashboard.js` defaults *My flow* to "buy with Exalted or Chaos → sell
for Divine → convert back". The Exalted half of that default is the single
most gold-expensive leg on the exchange. Changing it is a product decision, so
it has been left alone here, but the recommendation is to default to Chaos and
show gold intensity per row so the trap is visible rather than implied.

## What this changed in the scanner

- Traded paths carrying a **verified** fee: **13 → 521 of 521** on the live
  hour (Runes of Aldur, 2026-08-21T01:00Z).
- Readable families: 1,372 → 1,390.
- `real-data-golden`: the 22:00Z hour went from **zero** publishable two-leg
  signals to **nine** — all short Chaos → item → Divine/Exalted crosses that
  were previously dropped for an unknown fee, not for bad economics.
- No row in the scanner now reports an unverified fee, so the
  estimate-and-label path (`estimatedGoldCostPerUnit`) is dead code on live
  data. It is kept, and tested directly, for a future patch that adds an
  exchangeable item before we re-scrape.

## Still open

- **Gold has no price.** Every figure here is gold *per Divine*; turning that
  into "is this worth my time" needs a gold-per-hour rate for the player.
  A user-set gold budget already exists in `RunSettings.goldBudget`; a
  gold-per-hour input would make the ranking directly comparable to farming.
- **Gold intensity is not surfaced in the UI.** It is the strongest single
  filter we have and currently only exists in the audit script.
- **One realm.** The table is scraped from poe2db's `us` realm. Fees are
  client data and are not expected to differ by realm, but that is an
  assumption, not a measurement.
