# Phase 0 Math Audit — Published Opportunities (corrected)

Audit inputs: raw GGG completed-hour fixture `fixtures/ggg-currency-exchange-1787090400.json`
for league "Runes of Aldur", base currency **Divine Orb**; source hour 2026-08-18T22:00:00Z.
All quantities below are integer Exchange quantities. The engine is exercised by
`test/current-hour-math.test.ts` against the real fixture at reference time equal to the
source hour, so every figure below is what the code actually computes and asserts.

> **These are cross-currency flips, NOT closed arbitrage loops.** They end in Exalted Orb
> and are valued back to Divine through an *independent* observation path (see
> "exact output-valuation path" below). `profitKind = mark-to-market`, never
> `closed-realized`. **The 533% figure is a mark-to-market ROI on the input capital — it is
> not, and must not be presented as, guaranteed or fully-realized executable profit.**

## Published row 1 (source hour 2026-08-18T22:00Z)

- **Strategy:** `two-leg-cross` (cross-currency flip; not a closed loop)
- **Start:** 100 Chaos Orb → 10 Divine Orb → end 3300 Exalted Orb
- **Observed route legs:** 2

### Raw independent observations

1. **Chaos → Divine**, pair `CurrencyRerollRare | CurrencyModValues`
   - rates low/high 0.090909091 / 0.111111111; midpoint **0.101010101 Divine/Chaos**
   - volume_traded: Chaos 167365, Divine 16640
   - integer playbook: give **100** Chaos, receive **10** Divine; gold 10 × 800 = **8000**
2. **Divine → Exalted**, pair `CurrencyModValues | CurrencyAddModToRare`
   - rates low/high 300 / 360; midpoint **330 Exalted/Divine**
   - volume_traded: Divine 3541, Exalted 1198142
   - integer playbook: give **10** Divine, receive **3300** Exalted; gold 3300 × 120 = **396000**

### Corrected input valuation (root defect)

The published defect was an **incorrect input-valuation path**: the old engine excluded the
route's own first Chaos→Divine leg and searched an unrelated alternate path, valuing 100 Chaos
at **2.533724 Divine** and inflating ROI to ~2453%. The observed first leg IS itself an
independent Chaos→Divine conversion at **0.101010101 Divine/Chaos**, so input capital is
100 × 0.101010101 = **10.101010 Divine**. The engine now values input capital with the first
observed leg whenever that leg converts directly into the base currency.

### Corrected unit-safe volume share (old vs new)

The legacy calculation mixed denominations — e.g. leg 1 used `receipt_to = 10` against the
*from-side* chaos volume, giving **0.005975%**. That is not comparable. The unit-correct share
of each leg is `max(fromUnits/volumeFrom, toUnits/volumeTo)`, and the route bottleneck is the
maximum leg share.

| Leg | fromUnits / volumeFrom | toUnits / volumeTo | leg share (max) | old (single-side) |
|-----|------------------------|--------------------|-----------------|-------------------|
| 1 Chaos→Divine | 100/167365 = **0.05975%** | 10/16640 = **0.06010%** | **0.060096%** | 0.005975% |
| 2 Divine→Exalted | 10/3541 = **0.28241%** | 3300/1198142 = **0.27543%** | **0.282406%** | 0.275426% |

- **Old bottleneck:** max over the legacy single-side figures = **0.275426%**.
- **Corrected bottleneck:** max leg share = **0.2824061%** (leg 2's from-denominated share,
  10 Divine vs 3541 Divine volume). ~0.28%, well under the 20% cap.

The legacy **0.005975%** figure was computed against the wrong (mixed-denomination) denominator
and is **not** retained as any route figure.

### Corrected expected-profit confidence formula

- **Old (reversed):** `expected = conservative + (gross − conservative) × (1 − confidence)` —
  low confidence approached gross, high confidence approached conservative.
- **Corrected (monotone, bounded):** `expected = conservative + (gross − conservative) × confidence`,
  with `conservative ≤ expected ≤ gross`. Increasing confidence never reduces expected profit
  (`expectedProfit()` in `src/domain/scoring.ts`; verified in `phase0-release-blockers.test.ts`).

| Field | Divine | note |
|-------|--------|------|
| Input capital | 10.101010 | 100 Chaos × 0.101010101 |
| Output valuation | **64.96062992** | via exact path below |
| Gross | **54.859619820** | 64.96062992 − 10.10101010 |
| Movement haircut | 10.000000% | = max(range-half 10%, market impact 0.531%) |
| Conservative | **53.849518810** | gross − 10% × 10.101010 |
| Fill confidence | 0.770468 | labeled estimate, not a measured fill probability |
| Expected | **54.627769339** | monotone formula at confidence 0.770468 |
| Capital ROI | **533.110236%** | mark-to-market, NOT closed-realized |

### Exact output-valuation path (64.960630 Divine)

The route ends in Exalted, so the engine values the 3300 Exalted back to Divine through an
**independent** observation path (`valuationPath`, excluding the route's own edges):

1. `CurrencyAddModToRare → ThesisOfExperiments` @ **0.007874016** (Exalted→SoulCore-Thesis)
2. `ThesisOfExperiments → CurrencyModValues` @ **2.5** (Thesis→Divine)

3300 × 0.007874016 × 2.5 = **64.96062992 Divine**. (Input path: the route's own
`CurrencyRerollRare → CurrencyModValues` @ 0.101010101 → 100 × 0.101010101 = 10.101010 Divine.)

### Mark-to-market vs fully-closed realized profit

- **Mark-to-market (`profitKind = mark-to-market`):** the output is your route's end asset
  (3300 Exalted) valued to base through an independent path. The route does **not** execute
  that Exalted→Divine conversion; `returnToBaseIncluded = false`, `returnToBaseLegs = []`,
  and **no gold for the return-to-base trade is included**. The 533% ROI is this signal.
- **Closed-realized:** would require an independent *executable* Exalted→Divine conversion leg
  (priced with its own quantities, gold, movement risk and trade count) that actually closes
  the loop back to base capital. No such independent executable conversion leg is selected in
  this phase, so no closed-realized profit is computed or claimed.
- Because base conversion is excluded, `conservativeProfitBase` is a **cross-currency
  mark-to-market** haircut — the UI and docs must **not** label it "fully realized
  base-currency profit". This separation is enforced by the `profitKind` / `valuation`
  disclosure persisted on every route.

### Movement terms are separate, and temporal movement is unavailable

- **Ratio-range uncertainty** (`ratioRangeUncertaintyPct = 20.000000%`, halved to a 10% haircut):
  from the completed-hour low/high spread — this is RANGE UNCERTAINTY, not movement over time.
- **Estimated market impact** (`estimatedMarketImpactPct = 0.531419%`): separate
  `coefficient × √volumeShare` term.
- **Temporal movement** (`temporalMovementPct = null`, `movementStatus = "insufficient-history"`):
  **unavailable until real hourly history is retained.** No historical price is ever fabricated
  (the old `ewmaVolatility([rate, rate*0.95])` synthetic second observation was removed).
  Haircut = `max(range-half, market-impact)`; the null temporal term contributes nothing.

## Other audited rows

The second historical-hour observation (21:00Z) of the same route family is handled by the
**duplicate determination**: it is a different source hour with different observed rates and
receipts, so it is **not** a sizing variant and is **not** deduplicated by
`dedupeSizingVariants()`; only the latest successful hour is exposed in the main view, and
historical alternatives belong in a separate history projection.

## New deterministic identities & zero-opportunity projection

### Route-family and opportunity identities (deterministic, collision-safe)

- **`routeFamilyId`** = SHA-256 of `family|<strategy>|<canonical ordered observation/path>`.
  Two historical hours re-observing the same currency path with the same legs share this id,
  regardless of sizing. Example for this route:
  `d05b08ee9665b4aa3ab9f25506484fbf9d25c6bae6787cfe8de18c3739a7d5b3`.
- **`opportunityId`** = SHA-256 of `opp|<familyId>|<league>|<sourceHourUtc>|<startUnits>`.
  Distinct source hours or distinct execution sizing produce distinct opportunities.

Both use stable SHA-256 over canonical serialization (`src/domain/identity.ts`) — **not**
shortened currency names, which collide and would block future history charts.

### Zero-opportunity projection behavior (migration 013)

- A successful ingestion hour that yields **zero** opportunities still advances the safe
  per-league status row (`opportunity_run_status`) to that hour with `candidate_count = 0`, and
  **deletes the league's prior public rows** — so the dashboard renders
  **"Completed HH:00 UTC — 0 candidates"** instead of silently falling back to the previous
  hour's rows.
- `data_age = now() − source_hour` is computed **live at read time** by the public view; it is
  never the stored, frozen-at-insert value. Migration 013 exposes exactly **one** `data_age`
  column and replays idempotently.
- The public view exposes only the league's latest successful hour; no hour-A/B opportunity can
  fall back into it after a later zero-opportunity hour.
- Browser roles (`anon`/`authenticated`) may `SELECT` only `opportunity_public` and the safe
  `opportunity_run_status` projection; the private run/market/opportunity tables,
  INSERT/UPDATE/DELETE on the projection, and all administrative functions remain denied
  (verified by `test/db-safe-status.integration.{sql,sh}`).

## Migration replay + advisor baseline

- Local reset replays migrations 001–013 cleanly; migration 013 re-applies without failure
  (executable proof in the integration test).
- Security advisor: 1 WARN — `pg_net` extension installed in the `public` schema. This is the
  standard Supabase-provided async-networking extension used by the ingestion path; it is not
  introduced by migration 013. Reported for transparency; moving it to another schema is a
  hardening item outside this change's scope.
- Performance advisor: 3 INFO-level "unused index" findings on `market_hours_lookup_idx`,
  `market_hours_market_idx`, `ingestion_state_last_run_idx`. These back the ingestion query
  paths and show 0 scans only because the freshly-reset local DB has no real workload; they are
  not introduced by migration 013 and are retained.

## How to reproduce the corrected figures

```
npx tsx scripts/generate-math-audit.ts   # audit doc figures
npm test                                  # current-hour-math asserts gross 54.859620,
                                          #   conservative 53.849519, ROI 533.110236%
docker run / bash test/db-safe-status.integration.sh   # DB integration + role matrix
```
