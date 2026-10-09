# HEADLINE.md — the single claim the evidence supports

**Decision: Option 2 — "open, transparent, honest, bounded active liquidity."**
Option 1 ("beats passive pools") is **not shown** at the required bar; Option 3
("beats propAMMs") is **not claimed**.

## The headline claim

> ArbSwap is an **open, oracle-anchored, two-sided market-making vault** whose
> execution is **bounded and honest by construction** (`min_out`/`min_version`,
> expiry, on-chain spread/anchor/capacity/flow caps), with **no known issues in
> self-review, independent audit pending**. It is **not** claimed to beat
> tight-spread propAMMs on routed price, and its economic value is **not yet
> demonstrated** on real order flow.

## Evidence

**Routed world (fresh, `python -m simulation.sim.router`, W1–W6 one-hour
slices; ArbSwap vs B1 vs a propAMM-like venue at ~0.5 bp half-spread):**

| Venue | Volume share | Fill share | 2s markout (bps) | Quiet half-spread (bps) |
|---|---|---|---|---|
| ArbSwap | **0.0%** | ~1–2% | +0.6 … +2.5 | ~2.0 |
| B1 passive | 0.3–0.4% | 16–18% | −0.3 … −18.6 | 3.7–13.3 |
| PropAMM-like | **99.6%** | ~81% | −0.6 … −2.3 | 0.4–0.9 |

- **ArbSwap loses the routed volume share** to a tight propAMM because its
  effective spread (~2 bps) is wider than the competitor's (~0.5–0.9 bps). This
  is the honest competitive conclusion and the reason the pitch is Option 2.
- ArbSwap's markout is **positive** in the model and better than B1's, but it is
  a **model output** on synthetic flow (F-08 calibration gap), not a measured
  product result, and it comes with ~0 routed flow.
- The competitor's **negative** model markout (−0.6 … −2.3 bps) contradicts the
  paper's profitable propAMM (+0.37 … +1.19); this is the calibration gap, not a
  claim about real propAMMs.

**Bounded / honest execution (on-chain, SUPPORTED):** see `docs/CLAIMS.md`
items 1–4, 8, 9. Every guard has a passing test and a caught mutation
(`docs/SECURITY_CHECKLIST.md` §2c).

## Why not Option 1

The decision rule requires "beats B1 on hedged PnL in ≥3 regimes on **real
flow** including stress windows, with confidence intervals excluding zero." The
existing held-out numbers (`docs/P1_RESULTS.md`) are **model outputs** with a
known calibration gap (real-flow B1 saturates at ≈ −7.9 bps / 13 bps vs the
paper's −0.2 / 2.6), and the routed world gives ArbSwap ~0 share. The bar is not
met. **Option 1 is not shown.**

## Limits

- Flow is synthetic; only the price path is real. Markout/spread/PnL are model
  outputs.
- The propAMM-like venue is a model, not a measured competitor. E8 (real Solana
  pool quote/fill data) is **NOT DONE** — no data source was available, so there
  is **no measured claim about competitors**.
- Devnet is not deployed; the live keeper transport is NOT DONE.
- Independent audit pending.
