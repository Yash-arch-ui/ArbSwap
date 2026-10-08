# P1 Pre-registration (fixed before any new experiment)

Fixed 2026-10-08, before running any Phase-1 completion experiment. This file is
not edited after seeing results; any change is a dated amendment explaining why.

## 1. Calibration targets (baseline B1 only)

| Metric | Target | Accept |
|---|---|---|
| B1 passive pool, 2s markout | −0.2 bps | −0.5 … +0.1 bps |
| B1 passive pool, quiet-flow half-spread | 2.6 bps | 1.8 … 3.4 bps |

Competing tight propAMM-like venue (reference ranges from Solmaz et al.): 2s
markout **+0.37 … +1.19 bps**, retail half-spread **≈ 0.26 bps**.

**Rule:** we tune the *flow model and the passive baseline* to hit the B1 targets.
We never tune anything so that ArbSwap looks better. ArbSwap parameters are
calibrated only on the calibration window (W1) and frozen; held-out windows
(W2-W6) are never used for tuning.

## 2. Competing venue and fee tiers

- **PropAMM-like venue:** quotes at `reference ± half_spread`, half-spread swept
  in **0.3, 0.5, 1.0 bps**, repriced on the same `OracleModel` (latency-limited).
- **B1 passive pool fee tiers:** **1, 5, 30 bps** (the paper's passive range).

## 3. Windows (fixed in advance)

Reused from `simulation/sim/windows.py` (unchanged): **W1** 2026-08-24…08-30 is
calibration; **W2…W6** (2026-08-31…2026-10-04) are held out and all reported.

**Stress windows (fixed candidate rule).** Two additional high-volatility weekly
candidates are fixed here before download/measurement: **S-A = 2026-07-06…07-12**
and **S-B = 2026-07-13…07-19**. Windows are labelled by **measured** realized
volatility-per-√s and drift, not by assumed regime names. The two existing
"unlabelled" windows (W2, W5) are relabelled by the same measured rule.
**Injected jumps:** on W4, jump sizes **50, 100, 300 bps** at a fixed schedule.

## 4. Metrics

2s markout (notional-weighted), quiet-flow half-spread, hedged PnL, quote-vs-fill
gap (**would-be** before rejection and **post-rejection**), fill rate, rejection
rate, and per-venue **volume share** and **fill share**.

## 5. Calibration method and sensitivity grid

- **B1 baseline calibration** (depth ×10^k, noise trade-size distribution,
  noise/informed mix) is fit to the Section-1 targets; report fitted params and
  SSE.
- **ArbSwap params:** the existing 81-candidate grid on W1 only (unchanged).
- **Sensitivity grid:** depth {…}; mean_size {…}; price-insensitive flow share
  {0, 20, 50}%; slippage tolerance {0, 0.5, 1, 2, 5} bps; oracle latency
  {0.2, 1.0, 4.0} s; vault fee {1, 3, 10} bps; passive fee {1, 5, 30} bps.

## 6. Acceptance criteria for P1 = PASSED

- (a) B1 within tolerance of the paper targets + fit report.
- (b) Router built/tested; every results row includes fill/volume share.
- (c) Would-be gap and rejection-vs-tolerance tables present.
- (d) Real-flow and stress-window results present; windows labelled by measured vol.
- (e) Pre/post-fix before/after on held-out windows present.
- (f) Operating envelope published, incl. losing regions.
- (g) All tests green; frozen-parameter file with hashes; one-command reproduction.
- (h) No ArbSwap parameter tuned on a held-out window (commit evidence).

## 7. Data manifest

All raw data stays gitignored; per-file SHA-256 hashes are recorded in
`docs/DATA_MANIFEST.md`.