# THESIS.md — pre-registered closure thesis test (Amendment 3)

Model output (real price path, synthetic flow). Not a product result.

## T-A — "Beats passive" (Option 1)

**Holds: False**

- T-A.i real aggTrades flow with CI>0: **False** — real aggTrades held-out study with bootstrap CIs not run; measured real-flow B1 saturates at ~-7.9/13 bps (F-08)
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

## Decision

**Option 1 not shown**

## C2.4 — held-out, stress and injected jumps

- **Injected-jump sensitivity (synthetic `jump` regime):** E9 over 27 cells
  (passive fee × vault fee × latency) → **0 negative-E1 cells**; worst +0.21,
  best +1.22. (Specific 50/100/300 bps step injections are **NOT RUN**.)
- **Two genuinely high-volatility real windows (σ ≥ 2× existing):** **NOT RUN** —
  requires downloading new real archives; the pre-registered stress weeks S-A/S-B
  measured mid/low vol, not ≥ 2×. Marked **EXTERNAL (data)**.
- **E5/E7/E9/E10 re-run on the current engine:** E9 (calm/trend/crash) and E10 are
  current (see `docs/RESULTS.md`); E7 unchanged (containment); E5 ablation is in
  `docs/P1_RESULTS.md`. The held-out PnL tables are from the last full study and
  will be regenerated on the next full run (see `docs/PROGRESS.md`).

Status: **PARTIAL** (jump sensitivity done; real high-vol windows EXTERNAL).
