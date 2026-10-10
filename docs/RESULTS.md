# RESULTS.md — what the evidence shows, with limits

Stranger-facing summary. Sources: `docs/HEADLINE.md`, `docs/CLAIMS.md`,
`docs/METHODOLOGY.md`, `docs/P1_RESULTS.md`, `docs/CLAIMS.md`. Every number
here is either **on-chain SUPPORTED** (a named passing test) or a **model output**
(simulation). Nothing here is an audit or a product claim.

## The headline claim

> ArbSwap is an **open, oracle-anchored, two-sided market-making vault** whose
> execution is **bounded and honest by construction** (`min_out`/`min_version`,
> expiry, on-chain spread/anchor/capacity/flow caps), with **no known issues in
> self-review, independent audit pending**. It is **not** claimed to beat
> tight-spread propAMMs on routed price, and its economic value is **not yet
> demonstrated** on real order flow.

## Generated numbers (single source of truth)

All numbers below are rendered from `simulation/data/results/artifacts.json`
(commit, date, flow type, frozen-parameter hash and data hashes are in that file).
The routed chart is `docs/headline_chart.svg` (`./scripts/headline.sh`).

<!-- BEGIN GENERATED NUMBERS -->

_Generated from `simulation/data/results/artifacts.json` (commit `d060676`, 2026-10-10, flow: synthetic (real price path)). Do not edit by hand; run `scripts/render_docs.py`._

**Calibration (W1):** B1 best 2s markout **-0.02 bps** (target -0.2, accept [-0.5, 0.1]); quiet half-spread **2.409 bps** (target 2.6, accept [1.8, 3.4]).

**Routed world (W1-W6 mean; flow synthetic, price path real):**

| Venue | Volume share | Fill share | 2s markout (bps) |
|---|---|---|---|
| ArbSwap | 0.0% | 1.6% | +1.99 |
| B1_passive | 0.3% | 16.9% | -5.13 |
| PropAMM | 99.6% | 81.5% | -1.19 |

**Held-out E1 (ArbSwap vs B1):** W2 +686.9%, W3 +469.9%, W4 +726.1%, W5 +2406.5%, W6 +750.5%.

**Retail execution (E4):** ArbSwap quiet half-spread W2 8.26, W3 8.05, W4 8.32, W5 8.29, W6 7.89 bps; B1 2.26, 2.17, 2.21, 2.05, 1.99 bps.

**Cost (E10, source: `cargo build-sbf + litesvm_lifecycle.rs::measure_instruction_compute_units`):** `update_quote` **48,209 CU**, `swap` **59,327 CU**; cost/update 0.00076 quote @ SOL=150.

**Compute units (single source: `artifacts/public/cu.json`; build `cargo build-sbf (no idl-build)`; `.so` sha256 `c5ba3d1fba5a…`).**

| Instruction | CU |
|---|---|
| `accept_admin` | 9,367 |
| `bond_keeper` | 24,630 |
| `cancel_admin` | 7,555 |
| `claim_keeper_reward` | 13,828 |
| `claim_withdraw` | 23,728 |
| `crank_epoch` | 5,162 |
| `deposit` | 45,153 |
| `propose_admin` | 8,060 |
| `request_withdraw` | 19,662 |
| `slash_keeper` | 13,901 |
| `swap` | 59,327 |
| `update_quote` | 48,209 |
| `update_quote_wide_conf_rejected` | 15,518 |

**Tests:** 154 Rust / 202 Python. **Guard mutations:** 54 caught (docs/SECURITY_CHECKLIST.md).

<!-- END GENERATED NUMBERS -->

**Honest reading:** ArbSwap loses the routed volume share to a tighter propAMM
(~2 bps effective vs ~0.5–0.9 bps) and gets ~0 share. Its model markout is
positive and better than B1's, but on synthetic flow. The propAMM-like venue's
negative model markout contradicts the paper's profitable propAMM — the known
calibration gap (F-08), not a claim about real propAMMs.

## Bounded / honest execution (on-chain, SUPPORTED)

Each is a named LiteSVM test in `vault/program/tests/` (see `docs/CLAIMS.md`):

- Executed output ≥ quoted output (`min_out`/`min_version`); expired quotes
  always reject.
- Keeper bounded: anchor↔oracle band, level↔anchor band, min/max spread, ladder
  capacity ≤ `utilization_max × available reserves`, `update_slot` age cap,
  per-window one-sided flow cap.
- Every account bound to its vault (PDA seeds / address / mint-owner);
  cross-vault substitution rejected.
- Breaker is permissionless but **state-only**; `reset_breaker` admin-only.
- Keeper math parity (Rust ↔ Python) and 997 bit-exact golden vectors.
- 31-guard mutation table: every guard has a caught mutation
  (`docs/SECURITY_CHECKLIST.md` §2c).

## Sensitivity (E9) and cost (E10) — model output

- **E9:** passive fee × vault fee × latency grid — **45 of 81 cells have negative
  E1** (losing regimes reported, not hidden).
- **E10:** `cu_update_quote = 48,209`, `cu_swap = 59,327`; cost per update
  ≈ 0.00076 quote, ≈ 2.75 quote/hour; ~71–99× the paper's update floor and 3.5×
  its swap floor (not like-for-like: the paper excludes on-chain oracle
  verification).

## E8 (real Solana pool quote/fill gap) — PROXY RUN (P1)

One-hour real-quote sample from the public Jupiter quote API
(`lite-api.jup.ag`, no key): 1,800 ticks at 2 s over ~77 min, 1,245 usable
(30.8% transient errors, recorded). **Quote persistence** = 0.997 (95% CI
0.992–0.999). **Round-trip quote-cost proxy** = **−0.29 bps** (95% CI −0.31 …
−0.26) — effectively zero at sub-second spacing — over real Solana routes
(BisonFi, HumidiFi, GoonFi, Flux, TesseraV, Obsidian, Aquifer, Meteora DLMM,
Whirlpool, Raydium CLMM, …). This is a **proxy, not a fill gap**: no transaction
is submitted, so there is **no measured claim about competitors' fill quality**.
Raw: `simulation/data/results/e8_proxy_raw.json`.

## Provenance and superseded numbers (C1.3)

Numbers in this repo have changed as bugs were fixed; **do not cite superseded
tables**. Provenance for each table is the `commit` in `artifacts.json`.

| Superseded | Why it changed | Status |
|---|---|---|
| E1 ≈ +16 bps markout, +375% E1 (pre-`b083ba5`) | **price-150 bug**: every study venue was initialized at price 150 while the market traded ~100 | **SUPERSEDED** — see `docs/SECURITY_CHECKLIST.md` header |
| E1 ≈ −100% (early synthetic) | arbitrageur sizing + ladder-consumption correctness fix | **SUPERSEDED** |
| `update_quote` ≈18k CU / `swap` ≈72k CU | old figures were a short/rejected update path measured with a different Cargo profile; a full two-sided ladder update is 48,209 CU under the deployed `cargo build-sbf` | **SUPERSEDED** — see `artifacts/public/cu.json` |
| Calibration best −98.7 / 52.9 bps (synthetic) | synthetic flow uncalibrated | **SUPERSEDED** by real-flow calibration attempt |
| Real-flow B1 saturating at ≈ −7.9 / 13.1 bps | the model's passive adverse selection is ~40× the paper's | **CLOSED-BY-DECISION** (F-08, bounded impact) |

Flow type for the headline tables is **synthetic** on a **real price path**; the
only real-flow layer is the router (routed world) and the latency study S3.

## Limits (do not omit)

- Flow is synthetic; only the price path is real. Markout/spread/PnL are **model
  outputs**.
- Calibration gap (F-08): the passive benchmark is not yet the paper's benchmark.
- The propAMM-like venue is a model, not a measured competitor.
- Priority-fee and landing-delay inputs are heuristics (A-15).
- Losing / zero-share regimes are reported as prominently as wins.
- Independent audit pending; same-agent self-review only.

## Reproduce

```bash
./scripts/headline.sh                       # headline chart (no data/keys needed)
cargo test --workspace && .venv/bin/pytest simulation -q
python -m simulation.sim.router             # routed-world table
python -m simulation.sim.e9_e10             # E9 sensitivity + E10 cost
```
