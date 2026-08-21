# PoE2 Arbitrage Dashboard — brief for the next model

Read this, then `HANDOFF.md` (deeper background), then `docs/` if a file is
referenced. Everything below is measured, not assumed.

---

## 0. The one thing that must happen first (Chuck, not the model)

The site and the data pipeline deploy **separately**. The site auto-deploys
from `main` (Vercel). The data does not — it comes from a Supabase Edge
Function that must be redeployed by hand:

```bash
supabase functions deploy poe2-hourly-ingest --project-ref eyuapmpubojcsnedzprn

# then force one ingest instead of waiting for the hourly cron:
curl -X POST "https://eyuapmpubojcsnedzprn.supabase.co/functions/v1/poe2-hourly-ingest" \
  -H "x-poe2-ingestion-token: <token from Supabase Vault>"
```

**Do not change the function's auth.** It uses a custom
`x-poe2-ingestion-token` header, not a JWT. `verify_jwt` must stay off.

Until that deploy happens, production keeps serving `phase8-second-source-1`
rows. Check what is actually live at any time:

```bash
curl -s -H "apikey: sb_publishable_Jf-g6WqT7KGQdiF7iVuxHw_BuHANYdI" \
  "https://eyuapmpubojcsnedzprn.supabase.co/rest/v1/opportunity_run_status?select=*"
```

`algorithm_version` in that response is the truth. The checked-in scanner is
currently `phase9-poe2scout-identity-1`.

---

## 1. What the product is

Chuck buys an item with **Exalted or Chaos**, sells it for **Divine**, then
converts the Divine **back** to what he started with. The round trip is the
product — a two-leg spread with no return leg is not a number he can act on.
Every row is measured back into the starting currency.

Ratios are always shown in `I WANT : I HAVE` form, because that is the order
the in-game Exchange takes them.

Benchmark to beat: <https://www.divinetendies.com/dashboard>.

---

## 2. Three profit figures — never collapse them

| Field | Meaning | Use |
|---|---|---|
| `twoLegSpreadPct` | Midpoint mispricing | **Discovery only.** Not a promise. |
| `targetBidPotentialPct` | Favorable boundary | **POTENTIAL only.** Label it as such. |
| `returnConfirmedCyclePct` | Conservative boundary, integer sizing, gold included | The only figure that is a claim |

`compoundPct()` in `src/domain/market-signals.ts` applies **one** side-selector
to every leg, which makes mixed-boundary math structurally impossible. Do not
"optimize" that away — mixing boundaries is how a losing trade gets shown as a
winner.

Chuck caught exactly that bug once: the table showed `30.64 Div/100K` from the
midpoint next to a `-30 net` from the conservative model. `planDivPer100k()`
now derives Div/100K from the plan's own net. Keep it that way.

---

## 3. The two gates (recently added — understand before touching)

```
MIN_ITEM_HOURLY_VOLUME  = 25   src/domain/market-signals.ts
MAX_PLAUSIBLE_SPREAD_PCT = 300
```

Widening the item map from 23 to 574 named paths surfaced hundreds of markets
that traded once. They arrive looking like the best rows on the board
("buy for 6 Exalted, sell for 1 Divine, +5,316%"). On the checked-in fixture
hour, the volume floor cut profitable rows 175 -> 32 and the worst spread
36,325% -> 7,540%; the spread cap took it to 232%.

These are **duplicated on purpose** in `public/dashboard-data.js`
(`credibilityFault`), because the browser renders whatever the last ingest
wrote — possibly an older algorithm version. `test/client-credibility-gate.test.ts`
fails if the two copies drift. Keep both in sync.

Sorting: `SCANNER_SORTS` wraps every column comparator so `profits(r)` always
outranks the column key. A losing round trip never sits above a winning one,
whatever column is sorted.

---

## 4. Where things are

| Area | File |
|---|---|
| Scanner core: `compoundPct`, `chooseSizing`, `buildFlow`, `classify`, both gates | `src/domain/market-signals.ts` |
| Divine price book (benchmarked: item-volume rule, 14.4% mean dev) | `src/domain/divine-price.ts` |
| GGG vs poe.ninja agreement bands | `src/domain/cross-source.ts` |
| poe.ninja client (12 categories, 532 lines) | `src/integrations/poe-ninja.ts` |
| Identity map — 643 poe2scout rows, generated | `src/domain/mapping.poe2scout.ts` |
| Map layering (poe2scout -> ninja bridge -> hand-verified wins) | `src/domain/mapping.ts` |
| Browser table, sizing, sorting, presets, clipboard | `public/dashboard.js` |
| Shared row normalization + credibility gate | `public/dashboard-data.js` |
| Ingest Edge Function (Deno) | `supabase/functions/poe2-hourly-ingest/index.ts` |

Types for the three figures, `SignalFlow`, `sourceCheck`, `liquidityLabel`:
`src/domain/types.ts`.

---

## 5. Data sources, and what each can and cannot give you

- **GGG official currency exchange** — hourly *completed* aggregates. Low/high
  ratio boundaries only. **There is no live ladder and no Competing Trades
  data in the API.** Any feature that needs the live book cannot be built from
  this source. Say so rather than approximating it.
- **poe2scout** (`https://poe2scout.com/api`, realm segment `poe2`, PascalCase
  routes) — publishes `BaseItemTypeId` (the GGG metadata path) and `Text` (the
  human name) in the same record. This is why naming is not guesswork.
  Note the base is `/api`, **not** `/api/v1` — v1 gets parsed as the realm.
- **poe.ninja PoE2 exchange** — per-item Divine prices, sparklines, hub rates.
  Used as the second source for agreement banding, never as the primary price.

Coverage today: **574 of 583 traded paths named = 100% of hourly volume**,
43/43 cross-source agreement, 0 conflicts.

---

## 6. Open work, highest value first

1. **Editable per-currency gold-fee table.** Only 14 fees are hand-verified.
   Everything else carries `goldCostPerUnit: -1` and falls back to a labeled
   category estimate, which is why most rows say "Fee check needed" instead of
   "Return confirmed". Fixing this converts the largest block of rows from
   *estimated* to *claimable*. Highest leverage item on the list.
2. **Re-audit the ~20 rows where GGG and poe.ninja diverge or conflict.**
   Decide per row whether it is an identity error or a real market split.
3. **Table fits 1440px, still scrolls 73px at 1280.** The Status column
   carries the risk signal, so it should never be the part that goes
   off-screen.
4. **Approach 1280 by narrowing content, not by hiding columns.** The Sources
   column is 154px driven by chip text ("Both sources agree").

---

## 7. Rules that are not negotiable

1. **Do not modify any PF-AI resource.** Different project, different repo.
2. **Preserve the Edge Function's `x-poe2-ingestion-token` auth.** No JWT.
3. **Destructive DB operations go through Chuck** — paste SQL for the Supabase
   SQL Editor, never run deletes.
4. **Never dress a loser as a winner.** No mixed boundaries, no midpoint
   figure sitting next to a conservative one, no row with a negative net
   ranked as an opportunity. This has broken trust twice already.
5. **Empty is an acceptable answer.** If the gates suppress everything, say
   what was held back and why. Do not lower a threshold to fill the table.

---

## 8. How to verify a change before claiming it works

```bash
npm install
npx vitest run          # 169 tests, 24 files
npx tsc --noEmit
npm run build
deno check supabase/functions/poe2-hourly-ingest/index.ts
```

To see the real board without deploying: snapshot production's REST tables to
local JSON, serve `public/` with `config.js` pointed at `http://127.0.0.1:4173`,
and let the page fetch `/rest/v1/<table>` from the snapshot. That runs the
exact production code path against exact production data. Chromium lives at
`/opt/pw-browsers/chromium`.

Do not report a UI change as working without rendering it.
