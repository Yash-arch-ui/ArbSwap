# THESIS.md — pre-registered closure thesis test (Amendment 3)

Model output (real price path, synthetic flow). Not a product result.

## T-A — "Beats passive" (Option 1)

**Holds: False**

- T-A.i real aggTrades flow with CI>0: **False** — real aggTrades study run (Amendment 4): 95% CI above zero on none; high-vol days 2026-02-06 / 2026-01-31; B1 real-flow residual remains negative (F-08)
- T-A.ii quiet half-spread ≤ B1 (all windows): **False**
- T-A.iii no-propAMM volume share ≥ 10%: **True** (share 27.9%)
- T-A.iv tolerance 1 bp + 20% insensitive: **False**

## T-B — competitiveness vs propAMM-like venues

| competitor half-spread (bps) | ArbSwap vol | B1 vol | prop vol | ArbSwap fill |
|---|---|---|---|---|
| 0.3 | 0.0% | 0.3% | 99.7% | 1.5% |
| 0.5 | 0.0% | 0.3% | 99.6% | 1.6% |
| 1.0 | 0.1% | 0.8% | 99.1% | 3.0% |
| 2.0 | 0.7% | 2.1% | 97.3% | 11.2% |

## T-C — retail execution (E4)

propAMM-like half-spread = 0.5 bps

| window | ArbSwap quiet half-spread | B1 | ArbSwap ≤ B1 |
|---|---|---|---|
| W2 | 8.26 | 2.26 | False |
| W3 | 8.05 | 2.17 | False |
| W4 | 8.32 | 2.21 | False |
| W5 | 8.29 | 2.05 | False |
| W6 | 7.89 | 1.99 | False |

## C2.7 — niche (no propAMM)

ArbSwap volume share 27.9%; better markout than B1: True

## C2.2 — calibration vs the paper

| | 2s markout (bps) | quiet half-spread (bps) |
|---|---|---|
| paper target | -0.2 | 2.6 |
| accept | [-0.5, 0.1] | [1.8, 3.4] |
| synthetic W1 fit | -0.020 | 2.409 |
| real-flow residual | -7.9 | 13.1 |

**CLOSED-BY-DECISION.** synthetic W1 fit is within tolerance (-0.02/2.41); real-flow adverse selection saturates at ~-7.9/13.1 bps (~40x/5x the paper), a venue/flow-definition gap that parameter tuning cannot close. Bounded impact: all headline numbers are model outputs and labelled so.

## C2.5 — operating envelope (routed world)

75 cells: **40 deploy-ok**, **35 not**. Axes: vault fee {1,3,5,10,20} bps, competitor half-spread {0.3,0.5,1,2,4} bps, regime {calm,trend,crash}. Not-ok = zero volume share or negative markout. Worst cells:

- calm vault_fee=3 prop_hs=0.3: share 0.0%, markout +0.00 bps
- calm vault_fee=3 prop_hs=0.5: share 0.0%, markout +0.00 bps
- calm vault_fee=3 prop_hs=1.0: share 0.0%, markout +0.00 bps
- calm vault_fee=5 prop_hs=0.3: share 0.0%, markout +0.00 bps
- calm vault_fee=5 prop_hs=0.5: share 0.0%, markout +0.00 bps

## F5 — high-volatility windows and T-A.i (Amendment 4)

- 2026-01-31: sigma 2.572e-04 (2.52x ref), E1 +171.8%, ArbSwap quiet HS 8.61 vs B1 1.98 bps
- 2026-02-06: sigma 3.869e-04 (3.79x ref), E1 +150.9%, ArbSwap quiet HS 12.80 vs B1 2.34 bps
- T-A.i (1 bps tier): CI above zero on no days of 5; **met: False**

## F4 — retail diagnosis

Quiet-flow half-spread decomposition (bps): age 0.02, confidence 1.50, floor 2.00, inventory 0.92, jump 0.00, volatility 3.22. **Dominant term: volatility.**
- Routed world without a propAMM: ArbSwap filled volume share 27.5% (informed 0.0%, noise 27.5%); B1 72.5%; quiet half-spread ArbSwap 2.58 vs B1 6.94 bps.

## F4(d) — coefficient re-choice (Amendment 6)

Decision: **no-feasible-candidate**. No candidate satisfied hedged PnL ≥ 0 **and** quiet half-spread ≤ B1, so the frozen parameters are retained and Option 1 remains not shown.

## Decision

**Option 1 not shown**

## C2.4-fix / F5 — Amendment 4 (committed before the run)

**Registered 2026-10-10, before any high-volatility simulation was run.**

**Window rule (fixed here, applied mechanically):**

1. Baseline σ_ref = equal-weighted mean realised per-sqrt-second volatility of
   the five held-out windows W2–W6 = **1.02×10⁻⁴** (computed from the same
   USDC-converted 1 s series used by the study).
2. Candidate period: single UTC days in **2026-01-01 … 2026-02-28**, Binance
   `SOLUSDT` 1 s archives (the only period scanned).
3. Selection: the **two highest-σ non-overlapping days with σ ≥ 2·σ_ref**.
4. Applying the rule yields **2026-02-06** (σ = 3.80×10⁻⁴, 3.73·σ_ref) and
   **2026-01-31** (σ = 2.49×10⁻⁴, 2.44·σ_ref). Both are `NOT DONE` no longer:
   they are downloaded and used.
5. Held-out protocol on each selected day: the E1–E6 venue comparison
   (`run_venues`) on the USDC-converted real price path with synthetic flow, the
   routed world, and the honesty cost.
6. **T-A.i design:** real `aggTrades` flow (the whole flow; no synthetic
   informed/noise) for ArbSwap and B1 at fee tiers **1 / 5 / 30 bps**, run on the
   two selected days **and** the three archived aggTrades days (2026-09-10,
   2026-09-17, 2026-10-01). For each day and tier, a **5-minute block bootstrap**
   (2,000 resamples) gives a 95% CI on the hedged-PnL difference
   (ArbSwap − B1). T-A.i is **MET** iff the CI lower bound is > 0 in at least
   **3 of the 5 days**, including at least one high-volatility day.

The two selected days are held out from every calibration (calibration stays on
W1 only); no coefficient is re-chosen here.

## F4(d) — Amendment 5 (committed before the re-choice)

**Registered 2026-10-10, before the coefficient re-choice was run.**

The F4 diagnosis finds the **inventory term dominates** the ArbSwap quiet
half-spread (~55% of the raw spread), so the dominant term is coefficient-driven.
This amendment re-chooses **one coefficient** on the calibration window only.

- **Data:** the 12 pre-registered one-hour calibration blocks of **W1** (never a
  headline row), headline clock, seed 20261006.
- **Grid:** `inventory_coeff ∈ {0.0, 0.0001, 0.00025, 0.0004, 0.0005}`; every
  other frozen parameter unchanged.
- **Per candidate, per block:** the routed world **without a propAMM**
  (`b1_fee=1` bps, insensitive share 0.2, slippage 1 bp) gives ArbSwap's volume
  share; a separate ArbSwap-vs-B1 pair run gives ArbSwap hedged PnL and the
  ArbSwap/B1 quiet half-spreads.
- **Feasible** iff mean ArbSwap hedged PnL ≥ 0 **and** mean ArbSwap quiet
  half-spread ≤ mean B1 quiet half-spread.
- **Objective:** among feasible candidates, maximise mean ArbSwap volume share;
  tie-break on the smaller `inventory_coeff`.
- **If no candidate is feasible**, the frozen parameters are retained and the
  decision rule leaves the thesis unchanged.
- The winner (if any) is frozen with a hash and used unchanged for W2–W6.

## F4(d) — Amendment 6 (corrects the target; committed before the re-run)

**Registered 2026-10-10.** The **corrected** F4 diagnosis (venues initialised at
the path's start price, matching `run_venues`) finds the **volatility term
dominates** the quiet-flow half-spread (**~42%**; floor 2.0, volatility 3.22,
confidence 1.5, directional 1.22, inventory 0.92, age 0.02 bps). Amendment 5
swept `inventory_coeff` on the basis of an earlier diagnosis that mis-priced the
initial reserve; that target is **superseded**.

Amendment 6 re-chooses **`volatility_coeff` ∈ {0.0, 0.25, 0.5, 1.0}** (every
other frozen parameter unchanged) with the Amendment-5 objective, on W1's 12
calibration blocks only:

- feasible iff mean ArbSwap hedged PnL ≥ 0 **and** mean ArbSwap quiet
  half-spread ≤ mean B1 quiet half-spread;
- among feasible candidates, maximise mean routed volume share (no propAMM,
  `b1_fee=1` bps, insensitive 0.2, slippage 1 bp), tie-break on the smaller
  `volatility_coeff`;
- if none is feasible, retain the frozen parameters and leave the decision
  unchanged.
