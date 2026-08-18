# Phase 0 — Data/Algorithm Spike Report

**Date:** 2026-08-18 · **League:** Runes of Aldur · **Source hour:** 2026-08-18T03:00:00Z (unix 1787022000)

## Gate result: PARTIAL PASS — calculations proven plausible; mapping coverage is sufficient for hubs + 20 liquid items, not yet the full top-100. In-game gold-fee verification for exotic currencies (Omens, Soul Cores, Verisium) is the binding dependency for full coverage.

---

## 1. Fixtures saved (real data, not synthetic)

| File | Contents |
|---|---|
| `fixtures/ggg-currency-exchange-1787022000.json` | Full GGG completed-hour payload — 1,712 markets, 1,324 in Runes of Aldur, 584 unique item paths, 2,152 directed edges derived |
| `fixtures/poe-ninja-currency-overview.json` | poe.ninja PoE2 exchange overview (Currency) — 51 items, rates vs divine, sparklines |
| `fixtures/poe-ninja-soulcores.json` / `-expedition.json` / `-breach.json` | Additional exchange categories (35/23/28 items) |

Fixture vs. research-day numbers: poe.ninja now reports **331.6 Exalted and 9.91 Chaos per Divine** (research said 332.7 / 9.90 — consistent drift, use fixtures for smoke tests, never hardcode).

## 2. `arb-engine.ts`

Not present anywhere in the workspace — consistent with the research note. The domain package in `src/domain/` was written from scratch (clean-room) and treats route enumeration/scoring per the spec.

## 3. Metadata mapping — hubs PROVEN by independent cross-validation

The poe.ninja icon URLs embed GGG asset paths (base64 `"f":"2DItems/..."` → `Metadata/Items/...`), giving a **data-driven mapping mechanism with provenance**, plus a naming-pattern hypothesis for variants (e.g. `CurrencyRerollRare2` = Greater Chaos Orb). Every hypothesis is cross-validated: the GGG market ratio must match the poe.ninja implied rate within 25%.

**Hub proof (the plan's critical requirement):**

| Market | GGG observed rate | poe.ninja implied | Match |
|---|---|---|---|
| chaos → divine | 0.1056 | 0.1009 | **1.05×** |
| chaos → exalted | 33.5 | 33.45 | **1.00×** |
| mirror → divine | 4,758 | 4,759 | **1.00×** |
| divine → exalted | 246.5 | 331.6 | 0.74× (wide intra-hour range) |

**Result:** 20 paths verified & auto-generated into `src/domain/mapping.generated.ts` (via `scripts/generate-mapping.ts`); 13 quarantined (failed cross-validation). All three hub currencies verified. Top-100-by-volume coverage: **68.7%** of volume; the gap is exotic currencies (Omens, Verisium metals, Jeweller's-quality orbs, Soul Cores) that poe.ninja's exchange overview doesn't track — these require in-game or wiki gold-fee verification before they can be mapped with fees.

## 4. Gold costs

Verified for 28 items from the poe2wiki exchange-market table (Divine 800, Exalted 120, Chaos 160, Mirror 25,000, GCP 1,000, etc.). **Unknown fees are a hard reject** — `goldCostPerUnit()` returns `verified: false` and the route is dropped with a clear reason. The engine never guesses a fee and never treats an unknown fee as zero. Exotic currencies (Omens, Soul Cores, Verisium) have no public fee source — **needs in-game verification (human) or a live-verify override via the Phase 4 companion.**

## 5. Route generation from independent observations — WORKS

1295 two-leg flips + 1018 closed triangles enumerated from the real hour. The **anti-fabrication invariant is enforced by construction and by test**: every edge links to its `reverseEdgeKey`; route enumeration rejects any path containing an edge plus its reverse (same market reused); `chainUsesIndependentObservations()` validates chains.

**Scored candidates from real data (conservative, after haircuts):**

```
=2 100 Chaos → 3,350 Exalted → 744 Gemcutter's Prism
   gross +3.39 div → conservative +2.21 div | gold 1,146,000 | ROI 20.9% | conf 71% | bottleneck 5.1% vol
▲3 100 Chaos → 3,350 Exalted → 744 GCP → 139 Chaos
   gross +4.12 div → conservative +0.60 div | gold 1,168,240 | ROI 5.7%  | conf 44% | bottleneck 11.1%
```

The triangle is correctly ranked below the two-leg route (extra leg, extra risk).

## 6. Reciprocal-edge test — PASSES (the Phase 0 gate test)

`test/phase0-gate.test.ts` (6 tests, all green):
- Two-leg route from one market's own reciprocal → **zero candidates**
- Same-market-twice triangle → rejected by independent-observation check
- Single-price round-trip → never emitted (0 flips, 0 triangles)
- Genuinely inconsistent 3-market triangle → detected & all legs independent
- Integer floor conservation (150:1 → exactly 1; 2.5 → 2)
- Volume-share ceiling enforced

## 7. In-game manual verification of candidates — OUTSTANDING (human step)

The two scored candidates above cannot be verified against the live Exchange from here. Required: open the in-game Currency Exchange, confirm the displayed chaos/exalted/gcp ratios and gold fees match the playbook, then record pass/fail and false-positive reasons. This is the one Phase 0 gate item that requires a human at the keyboard.

## Key findings for Phase 1

1. **The hosted pipeline can truthfully state source age** — every edge carries `hourUtc`; the dashboard can display "complete hour 03:00 UTC".
2. **Integer playbook + gold math reproduce exactly** — `planLeg()` floors received units and multiplies by the received item's fee (never the giving side).
3. **Volume share is the hardest filter** — most "profitable-looking" raw routes die at the 20% ceiling (e.g. buying 170k minion-quality orbs on a market that traded 585/hour = 290× volume). Correct.
4. **Fee coverage is the scaling bottleneck** — with 28 fee-verified items the engine finds 1-2 conservative candidates/hour. Full coverage needs: (a) poe.ninja category metadata for exotic currencies where available, (b) in-game fee verification for the rest.
5. **Round-trip economics are honest** — the closed triangle's SaaS profit after haircuts (0.60 div on 100 chaos) is much smaller than the two-leg flip (2.21 div), exactly as the ranking model intends.

## Files produced

```
src/domain/types.ts            core types (ItemId, GggMarket, DirectedEdge, Route, ...)
src/domain/ggg.ts              Zod schemas + GGG payload parser
src/domain/edges.ts            directed-edge derivation + anti-reciprocal invariants
src/domain/playbook.ts         integer trade planning + gold fees + chain walking
src/domain/routes.ts           two-leg flip + closed-triangle enumeration
src/domain/scoring.ts          conservative haircuts, confidence, ranking
src/domain/mapping.ts          lookup + goldCostPerUnit (+ever-guess-never rule)
src/domain/mapping.generated.ts  AUTO-GENERATED 20 verified mappings
scripts/generate-mapping.ts    mapping generator (run after fixture refresh)
src/spike.ts                   end-to-end pipeline on the real fixture
src/spike-fee-subgraph.ts      fee-verified-subgraph diagnostic
test/phase0-gate.test.ts       the 6 gate tests (reciprocal, integer, volume)
fixtures/*.json                real data snapshots (GGG hour + 4 poe.ninja categories)
```

## Gate recommendation

Proceed to Phase 1 with the mapping-expansion task added: while domain math is proven, "top 100 liquid items mapped with verified fees" still needs the exotic-currency fee table (in-game spot-check script or manual entry) before Phase 2 ingestion can serve full coverage. The engine degrades gracefully: unmapped items are quarantined, never guessed.