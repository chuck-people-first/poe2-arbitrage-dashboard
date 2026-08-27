# PoE2 Arbitrage Dashboard — handoff

**Repo** `chuck-people-first/poe2-arbitrage-dashboard`
**Branch** `feat/two-leg-item-flips` · **PR** #1 (draft, CI green, mergeable)
**Head** `9b838b6` · **Base** `main` @ `a6bb7d7`
**Production** https://poe2-arbitrage-dashboard.vercel.app (deploys from `main`)
**Preview** https://poe2-arbitrage-dashboard-git-f-a30977-chuck-hennemanns-projects.vercel.app
**Supabase** `eyuapmpubojcsnedzprn` · Edge Function `poe2-hourly-ingest` · hourly Cron + Vault-backed `x-poe2-ingestion-token`

Do not modify any PF-AI resource. Preserve the Edge Function's custom
`x-poe2-ingestion-token` auth — this branch changes only the version constant in it.

---

## ⚠️ Nothing on this branch is live yet

Production still runs the **old** scanner. Verified against the database:

```
latest_successful_source_hour : 2026-08-21T01:00Z
candidate_count               : 11
algorithm_version             : phase6-ratio-boundaries-1
```

The dashboard only renders rows carrying the new model, so the preview shows a
"waiting on the next hourly ingest" notice rather than rows. That is correct
behaviour, not a bug. **Three steps, in this order** (`ALGORITHM_VERSION` is now
`phase8-second-source-1`, and the projection changed):

```bash
supabase db push --project-ref eyuapmpubojcsnedzprn            # migration 016
supabase functions deploy poe2-hourly-ingest --project-ref eyuapmpubojcsnedzprn
curl -X POST "https://eyuapmpubojcsnedzprn.supabase.co/functions/v1/poe2-hourly-ingest" \
  -H "x-poe2-ingestion-token: $POE2_INGESTION_TOKEN"
```

Success looks like `algorithm_version` flipping to `phase8-second-source-1` and
the row count going from ~11 to ~90. Then merge PR #1 for production.

I could not do this myself: this session's Supabase access is scoped to a
different account (`list_projects` returns only `pfr-command-center` and one
other; `eyuapmpubojcsnedzprn` returns "You do not have permission").

---

## What changed, in four commits

### 1 · `d985be1` — why the list was one or two rows

Measured, not guessed, and pinned in `test/scanner-discovery-funnel.test.ts`:
`buildMarketSignalRows()` required a positive **conservative** closed cycle just
to list, collapsing 192 readable route families to ~16 before the UI filters
even ran. Discovery is now gated on the completed-hour **midpoint**.

Three profit figures are kept structurally separate on `MarketSignal.priceModel`
and must never be collapsed:

| field | what it is | where it may appear |
|---|---|---|
| `twoLegSpreadPct` | midpoint mispricing, gold excluded | row headline |
| `targetBidPotentialPct` | favourable boundaries compounded — **potential, not executable** | drawer only, labelled |
| `returnConfirmedCyclePct` | conservative boundaries + integer sizing + all gold | the only "closed cycle" |

`compoundPct()` applies one side-selector to *every* leg, so mixing boundaries
across markets is structurally impossible. On the fixture hour the favourable
compound still reaches +1613% against a best confirmed cycle of +131% — that gap
is what the separation keeps out of the headline.

### 2 · `16a6701` — the round trip is the product

`MarketSignal.flow` carries the whole chain as executable quantities in the
Exchange's own vocabulary (you HAVE this, you WANT that). The closing step
decides whether a net figure exists at all; when no integer size closes the loop
inside the hour's volume, `netUnits`/`netPct` are null and the row says so.
Flow presets default to *My flow* (buy with Exalted or Chaos → sell for Divine →
convert back).

### 3 · `9b62fdd` — an empty scanner explains itself

The table used to claim "Recalculating this completed hour…", which was false.
It now names how many rows are stored, which scanner version produced them, and
that the data is fine.

### 4 · `9b838b6` — second source + sizing (the big one)

**poe.ninja as an independent price source.** `src/integrations/poe-ninja.ts`
fetches 12 exchange categories (532 priced lines): per-item Divine prices,
deepest-market volume, 7-point history, hub rates. Every row shows both prices,
their deviation, and a label — agree / close / diverge / conflict / GGG only.
They are **never averaged**; a missing second opinion is never reported as
agreement. The fetch is best-effort so poe.ninja being down cannot block the
official hour.

**Identity from the art file, never from price.** The bridge decodes the poecdn
image token to the item's art path — same art file, same item. Ambiguous leaves
are dropped; each survivor is validated by both Divine prices agreeing within
25%. Price is only ever a *confirmation*: price-nearest matching scores 25–44%
against the known-good table, and on the live hour the nearest line to
`CurrencyCorrupt` is "Greater Essence of Command" (1.2%) while the correct Vaal
Orb sits at 1.8%.

**The hand-written table was stale.** `CurrencyVaal` and `AnnullOrb` are no
longer traded at all — the feed renamed them — so three high-volume currencies
were invisible. Naming coverage of traded paths went **23 → 43**; the scanner
went **51 → 90 rows** on the same live hour, adding Vaal Orb, Annulment, Chance,
Breach Splinter and twelve Omens.

**Pricing rule chosen by benchmark.** Six rules measured against the independent
source across all 41 dual-priced items:

| rule | mean dev | ≤10% | ≤25% | >60% |
|---|---|---|---|---|
| direct market preferred | 18.5% | 25 | 32 | 4 |
| deepest in Divine value | 17.2% | 26 | 31 | 2 |
| scarcer side's unit count | 18.8% | 25 | 26 | 2 |
| **where the item itself traded most** | **14.4%** | **27** | **32** | **1** |
| median of candidates | 19.3% | 21 | 28 | 2 |
| Exalted hop first | 19.3% | 22 | 26 | 2 |

Worth knowing: the "scarcer side" rule looked better on four hand-picked
examples and was worse overall. The benchmark is a test so it can't regress.

**Sizing to the player.** Enter what you hold; every row re-sizes to it, bounded
by 20% of the hour's item volume. Because each leg floors to whole units, sizing
runs from the output backwards — 378 Exalted buys 126 Baubles that floor to 1
Divine (−30% to rounding); 270 buys 90 and loses nothing. When a loop can't
close, the row distinguishes *your stake is too small* from *this market is too
thin*.

Plus: click-to-copy bids (raw text — `Glassblower's` no longer pastes as
`Glassblower&#39;s`), `/` search, `j`/`k` navigation, per-row sparkline and 7-day
trend, sortable Sources column, and persisted settings.

---

## Where things live

| area | path |
|---|---|
| Broad discovery, three figures, classification, flow | `src/domain/market-signals.ts` |
| Divine price book + benchmarked rule | `src/domain/divine-price.ts` |
| Two-source reconciliation | `src/domain/cross-source.ts` |
| poe.ninja client | `src/integrations/poe-ninja.ts` |
| Generated identity bridge (+ quarantine list) | `src/domain/mapping.ninja-bridge.ts` |
| Bridge generator | `scripts/generate-ninja-bridge.ts` |
| Scanner wiring | `src/domain/scanner.ts` |
| UI (sizing, copy, search, keyboard) | `public/dashboard.js` |
| Design notes + all invariants | `docs/DISCOVERY_MODEL.md` |
| Discovery history migration | `supabase/migrations/016_discovery_signal_history.sql` |

Fixtures: `fixtures/ggg-currency-exchange-*.json` (two real hours) and
`fixtures/poe-ninja/*.json` (12 categories).

---

## Verification performed

- **158 tests** (was 115 at branch start), `npx tsc --noEmit` clean, `npm run build` clean.
- `deno check` on the Edge Function plus a Deno-runtime parity run — identical
  output to Node, flow chain contiguous and closing in the start currency.
- Migrations 001–016 applied to a clean Postgres 16 (010/011 skip: `pg_cron` /
  `pg_net` are Supabase-only). Drove a real 49-row ingest through
  `begin_poe2_ingestion` → `complete_poe2_ingestion`: history rows written
  (previously 0 for scanner families), anon reads intact, replay confirmed
  append-only.
- Headless Chromium at 1920/1560/1366/768/390 exercising clipboard, search, live
  re-sizing, keyboard nav, drawer and persistence. No console errors. No
  page-level horizontal scroll at any width; below ~1400px the table scrolls
  inside its own container.

---

## Known limits and the honest next steps

1. **Naming coverage is still only 43 of 583 traded paths (7%).** This is the
   binding constraint on how big the list can get, not the discovery gate.
   `CurrencyVerisiumMetal1` alone traded **1.36M units** in one hour and cannot
   be named. Every third-party name source I tried is Cloudflare-blocked from
   this container (GGG trade2 static → 403, poe2db → 404, poe2wiki cargo → 403,
   poe2scout → 404). Someone on a normal network could pull a GGG-path → name
   table and multiply the row count. **This is the highest-value next task.**
2. **poe.ninja `details` endpoint returns 404** for the id/type combos I tried;
   only `overview` is wired. More per-item history may be available there.
3. ~~**Gold fees**: only 14 paths have a *verified* Currency Exchange fee.~~
   **Closed.** The fee is a static per-item constant in the game's data, not a
   market number, and poe2db publishes the whole table with each item's GGG
   metadata path. `src/domain/fees.generated.ts` now carries all 669 entries
   and `goldCostPerUnit()` reads it by path, so all 521 traded paths on the
   live hour are fee-verified (was 13). See `docs/GOLD_FEES.md` — including
   what the real fees say about which routes are worth running, and why an
   Exalted leg costs ~53x what the same value costs as Divine.
4. **Two hours of GGG history only.** The `spreadPct` and trend features get
   better with accumulated ingests; migration 016 starts that accumulating for
   scanner families for the first time.
5. **The 20% market-share cap is a judgement call**, not a measurement. It could
   reasonably be a user control.
6. Sources currently **diverge or conflict on ~20 of 90 rows**. Some of that is
   genuine (thin completed hours), some may be remaining mapping errors. Worth
   auditing the conflicting set specifically.

## Rules that must not be broken

- Never let the favourable-boundary compound reach a headline or a comparator.
- Never establish an item's identity from price similarity.
- Never report a missing second opinion as agreement.
- Never treat an unverified gold fee as zero, and never let a `poe-ninja`-sourced
  entry claim a verified fee.
- `TRADE NOW` stays reserved for the Verified Closed Cycles tab.
- Destructive DB operations go through Chuck.

---

# Next session (scheduled ~03:00 ET / 07:00 UTC) — references from Chuck

Three leads, aimed squarely at the naming gap (43 of 583 traded paths, the
ceiling on everything).

## 1 · poe2scout — likely the fix for item naming

- MCP wrapper: https://github.com/vanzan01/poe2scout-mcp
- Backend: https://github.com/poe2scout/poe2scout

**Confirmed by probing:** the API base is **`https://poe2scout.com/api/v1/`**.
Evidence: every other path returns a bare 404, while `/api/v1/leagues` returns
`400 "Invalid realm."` — the route exists and is rejecting a missing/invalid
parameter.

Still unknown: the realm parameter's NAME and accepted values, and the route
list. Ruled out already — `?realm=` with poe2 / pc / poe2-pc / standard / POE2 /
Poe2 / poe / xbox, a `realm:` header, an `X-Realm:` header, and path segments
`/api/v1/poe2/...` and `/api/v1/pc/...`. There is no OpenAPI schema at
`/api/v1/openapi.json`, `/docs` or `/redoc`, and the site is a Remix app that
loads data server-side, so the browser bundles contain no API calls to copy.

**Fastest route to the answer:** `add_repo` on `poe2scout/poe2scout` (it is
public but not in this session's GitHub scope — the plain API call was refused),
then grep the backend for its route definitions and the realm validator. That
gives the parameter name, the valid values and every endpoint in one pass.

The MCP README also notes the API is **rate limited to 2 req/sec (burst 5)** and
**requires an email** in the request, presumably in the User-Agent. Respect both.

Why it matters: if poe2scout exposes GGG metadata ids alongside item names, it
closes the naming gap directly and the row count multiplies. If it only exposes
names and prices, it still becomes a THIRD price source for the agreement check.

## 2 · falleng0d/poe2-arbitrage-calculator

A manual calculator, not a scanner: the user enters currencies and rates by hand
and it validates them. Two things worth stealing:

- **Per-currency gold cost values, user-editable.** That is our third-largest
  gap — only 14 of our items have a verified Currency Exchange fee, and
  poe.ninja does not publish fees. A small editable fee table (persisted, seeded
  from the poe2wiki values we already have) would move many rows from
  "estimated fees" to verified, and is a better answer than the current
  per-row OCR flow.
- **Rate validation with visual feedback**, i.e. telling the user when the
  numbers they typed cannot be right.

## 3 · Video — "Path of Exile 2 Arbitrage in under 5 minutes" (Path of Stonks)

https://www.youtube.com/watch?v=IsGV2rIJEE4 — not watchable from this container.
Worth having Chuck summarise the method, or check whether it describes a flow
the scanner does not model (e.g. vendor recipes, which Divine Tendies also
lists and we do not).

## Suggested order

1. `add_repo poe2scout/poe2scout`, read the routes + realm validator, probe the
   live API, and see whether it carries GGG metadata ids.
2. If it does: extend the identity bridge with it as a third corroborating
   source, using the same rule — identity structural, price only confirms.
3. ~~Editable gold-fee table seeded from poe2wiki.~~ Superseded: the real table
   is checked in. What is still worth building is the *gold intensity* column
   (`scripts/audit-gold-intensity.ts`) in the UI, and a gold-per-hour input so
   "worth running" is comparable to farming.
4. Re-audit the ~20 rows where GGG and poe.ninja diverge or conflict.
