# METHODOLOGY.md

How ArbSwap's results are produced, and their limits. Read with
`docs/HEADLINE.md`, `docs/P1_PREREGISTRATION.md`, `docs/P1_RESULTS.md` and
`docs/CLAIMS.md`.

## Pre-registration trail

- `docs/P1_PREREGISTRATION.md` fixes the calibration targets, the windows
  (W1 calibrate; W2–W6 held out), the metrics, the grid and the acceptance
  criteria **before** any run; amendments are dated and explain why.
- Calibration tunes **only the baseline flow model and the passive pool** to the
  paper's targets. ArbSwap parameters are tuned only on W1 and frozen. Held-out
  windows are never used for tuning.

## Baselines and the routed world

- B1: passive constant-product pool at fee tiers 1/5/30 bps.
- B2/B3/B4: the vault with a fixed spread / no depth throttle / no honesty.
- ArbSwap: the full vault.
- A **propAMM-like** venue (half-spread 0.3–2.0 bps) for context only.
- `simulation/sim/router.py` routes each order to the best executed price with a
  price-insensitive share and a slippage tolerance, and reports per-venue volume
  and fill share.

## Metrics (definitions in `docs/FORMULA.md` §13)

2s markout (notional-weighted), quiet-flow half-spread, hedged PnL, LVR
(`σ²/8 · V · T`), quote-versus-fill gap (would-be before rejection and
post-rejection), fill/rejection rate, volume/fill share, CU per instruction.

## Honest limits (do not omit)

- **Flow is synthetic** (noise + informed). Only the price path is observed, so
  markout, quiet half-spread and PnL are **model outputs**, not measurements of
  live order flow. The real aggTrades layer exists (`simulation/sim/real_flow.py`)
  but the headline study uses synthetic flow.
- **Calibration gap (F-08):** with real flow the passive pool saturates at
  ≈ −7.9 bps markout / 13 bps half-spread vs the paper's −0.2 / 2.6. The
  benchmark is therefore not yet the paper's benchmark.
- **Priority-fee rate and landing-delay distribution are heuristics**
  (`docs/ASSUMPTIONS.md` A-15); absolute PnL carries that uncertainty.
- **Losing / zero-share regimes are reported as prominently as wins** (see the
  routed table: ArbSwap ~0% volume share).
- **E8 (real Solana pool quote/fill data) — PROXY RUN (P1).** A one-hour
  real-quote sample (`scripts/e8_proxy.py`, 1,800 ticks at 2 s over ~77 min,
  1,245 usable) measures **quote persistence** (0.997 change rate, 95% CI
  0.992–0.999) and a **round-trip quote-cost proxy** (−0.29 bps, CI −0.31…
  −0.26, i.e. effectively zero at sub-second spacing) across real Solana routes
  (BisonFi, HumidiFi, GoonFi, Flux, TesseraV, Obsidian, Aquifer, Meteora DLMM,
  Whirlpool, Raydium CLMM, …). This is a **proxy, not a fill gap**: no
  transaction is submitted. A fill gap still needs funded mainnet trades, so
  there remains **no measured claim about competitors' fills**. Raw samples:
  `simulation/data/results/e8_proxy_raw.json`; summary: `e8_proxy.json`.
- Never headline raw LP PnL or impermanent loss; use hedged PnL.

## Reproduce

```bash
./scripts/headline.sh                   # headline chart (no data/keys needed)
cargo test --workspace && .venv/bin/pytest simulation -q
python -m simulation.sim.study calibrate && python -m simulation.sim.study evaluate
python -m simulation.sim.study studies && python -m simulation.sim.study render
python -m simulation.sim.router          # routed-world table
python -m simulation.sim.edge_breaker    # honest-replay breaker trip rate
```

`scripts/p1_all.sh` chains the P1 phases. Raw data is gitignored; download
scripts are in `simulation/data/`.
