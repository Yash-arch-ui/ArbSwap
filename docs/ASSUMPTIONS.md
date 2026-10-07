# ASSUMPTIONS.md

Per Build Plan §0 rule 1: nothing is invented; anything that cannot be verified
from official docs or source is written here and escalated to the human.
Statuses: **VERIFIED** (checked against primary source), **ASSUMPTION** (acting
on it, needs human confirmation), **OPEN** (blocks a decision; see Build Plan §14).

## A-01. Orca Whirlpools license — VERIFIED, ACTION CHANGED
`orca-so/whirlpools` was Apache 2.0 **only until 2025-02-26**; since 2025-02-27 it
is under a custom proprietary "Orca License" (GitHub reports NOASSERTION).
**Consequence:** do not copy Orca code. Implement Q64.64 / segment math from the
published formulas (Uniswap v3 whitepaper; formulas independently confirmed in
the LVR paper, Example 4). Build Plan §6.5's "verify against Orca's code" is
superseded by this note.

## A-02. Nadler et al. "~57 bps average oracle deviation" — ASSUMPTION
Paper identity verified: *Blockchain price oracles: Accuracy and violation
recovery*, Nadler, Schuler, Schär — **Journal of Corporate Finance vol. 96 (2026)**
(not 2025 as cited in Build Plan §13), 150M+ observations, 40 Chainlink feeds on
Ethereum over 18 months; findings describe "economically significant deviations"
correlated with configuration and market stress. The **57 bps figure could not be
verified** (SSRN and ScienceDirect block automated access). Do not cite the number
until a human reads the paper. Citation year corrected here to 2026.

## A-03. "1.23 bps inter-block vs 8.62 bps intra-block variance" (Master Plan R10) — VERIFIED (2026-10-06)
Found in the 0x post itself, inside the **chart alt-text**: "Charts comparing
inter-block price variance of 1.23 basis points to intra-block price variance of
8.62 basis points for a second propAMM on Base, a 7x inversion indicating
aggregator spoofing". Earlier text-only extraction missed it (the numbers live in
image descriptions, not body text); the body states intra-block variance runs
**5–7×** higher than inter-block, consistent with the figure. Cite as 0x,
*PropAMM Shenanigans* (second propAMM measured on Base).

## A-04. LVR paper numbers — VERIFIED (upgrade vs Master Plan §17.5)
The 99.991% variance-share figure appears in the **original** LVR paper v6
(abstract, §1, §7.2) — no "secondary report" needed. σ²/8 for constant product is
Example 3; narrow-liquidity LVR/V → ∞ (Master Plan R3) is Example 4.

## A-05. Solana update-cost economics — VERIFIED
propAMM paper §7.1: median updates 485–676 CU (Solana) vs ≥16,938 CU for a swap;
HumidiFi reported ~300 → 47 CU per update. The <1,000 CU target in Build Plan
§2.5 is conservative. Formal confirmation that ArbSwap's update + swap fit the
CU limit remains a P2/P3 build-time test (Build Plan §17.14).

## A-06. New prior art to read before demo — SKIMMED, deep read still OPEN
**arXiv:2609.33799** — *Oracle-Parametrized Constant Function Market Makers*
(Amini & Feinstein, 27 Sep 2026, 45 pp). Same design space as ArbSwap.
Verified from the skim:
- Quoted price is a **convex combination of oracle and inventory price**:
  `p = λ·π + (1−λ)·π*(r)` under an oracle-contraction condition (Thm 2.8);
  price-tracking / inventory-tracking / geometric-average constructions.
- LVR split (Cor 3.4): market-lag term `(1−p_π)²σ²`, oracle-error term
  `p_π²(σ^η)²`, and a covariance term — i.e. an oracle-anchored curve converts
  LVR into lag + oracle error rather than eliminating it.
- **Oracle-update sandwich attacks** (§3.2.1): front-run the stale curve,
  back-run the refreshed one; attacker profit can equal the full pool value if
  boundary divergence fails (Prop 3.11); proportional fees can kill the
  incremental front-run value (Lemma 3.14). Bot #7 in `attackers/` targets this.
Still owed before demo: full read + row in the comparison table.

## A-07. Pyth product choice (Build Plan decision D-09) — OPEN, mechanics VERIFIED
- **Pyth Core:** pull-based price feeds with confidence intervals; the safe,
  trust-minimized default. Verified: `PriceUpdateV2` account exposes
  `Price { price: i64, conf: u64, exponent: i32, publish_time: i64 }` in **one
  account read**; account owner is the Pyth Solana Receiver program (enforced by
  Anchor `Account<PriceUpdateV2>`). Verified update mechanics: updates are
  **in-band** — the keeper fetches Hermes data and includes
  `update_price_feeds` (CPI, caller pays) in the *same transaction* as
  `update_quote` (alternative: sponsored push price-feed accounts updated by a
  separate crank).
  **Consequence for §6.3/CU accounting:** one keeper tx = ComputeBudget +
  Pyth verification + our update. Report CU for our instruction *separately*
  from total-tx CU; the Build Plan's "one cheap tx" claim is about our part.
- **Pyth Lazer:** 1 ms / 50 ms / 200 ms channels, richer data (bid-ask, depth),
  **15K CU for 20 feeds on Solana**, permissioned/custom integration (no public
  pricing tiers found), designed to be cross-checked against Core with circuit
  breakers.
Still open: historical-data availability for backtests (T0.4).
Decision: start Core (P0), evaluate Lazer at P3.

## A-08. On-chain priority-fee introspection (decision D-08) — OPEN
No precedent found in the papers or docs read for cheaply reading the tx priority
fee inside the program. Fallback per Build Plan: no priority penalty component
(a4-style), rely on spread/throttle/expiry.

## A-09. Jupiter aggregator interface — VERIFIED (shape), integration OPEN
`jup-ag/jupiter-amm-interface` is a Cargo workspace: DEXs implement the `Amm`
trait (`interface/` crate) and must pass `jupiter-amm-test-kit` (snapshot pool →
SDK quote → execute native swap in LiteSVM → assert parity). License field empty
on GitHub — check before shipping an adapter (P5/T5.4).

## A-10. Master Plan study notes — VERIFIED sources behind the design
- Spread linear in inventory tracking the external price: Baggiani et al.
  (arXiv:2506.02869) — linear approximation of optimal fees ≈ fully optimal in
  their Monte Carlo; constant fees lose ~19–20% revenue. Two fee regimes (deter
  arbitrageurs / attract noise). Cite the two-regime nuance, not just linearity.
  **Nuance (2026-10-06):** their linear term is **signed** (an antisymmetric
  skew: sell-fee up / buy-fee down when long), and what tracks the CEX price is
  the **fee-adjusted spread midpoint**, not the marginal price. Our symmetric
  `a2·|q|` widening term is therefore a heuristic on top of the signed skew that
  `P_res` already provides — keep it labeled as such (MATH.md).
- Directional fees vs toxic flow: Alexander & Fritz (arXiv:2406.12417) — with
  drift, revenue rises with fee on the exposed side; f_opt ≈ √α−1; best case the
  venue retains 2/3 of the arbitrage surplus.
- Zero-profit quoting: ZeroSwap (arXiv:2310.09413) ask/bid = conditional
  expectations; steady-state spread Θ(σ/λ). Adaptive Curves (arXiv:2406.13794)
  derive the optimal-curve ODE + Kalman update; robust to ≤50% adversarial flow.
- Reservation price: Avellaneda–Stoikov (2008), r = s − q·γσ²(T−t) — ArbSwap's
  `P_res = P(1 − g·q)` is the inventory-linear skew in bps form (state the
  adaptation). Note: the A–S *total spread* is q-independent; only the quote
  mid/skew moves linearly in q, which is exactly what `P_res` models.
- propAMM edge sources (Solmaz et al., arXiv:2609.38056): cheap updates,
  counterparty pricing, winning arb leg, spoofing — ArbSwap keeps the first three
  by design and removes spoofing via versioned quotes + the gap metric.
- Spoofing evidence (39% identical / 1.08 bps worse) is **Base/Flashblocks**;
  whether a comparable gap exists on Solana is unverified (Build Plan §17.1; E8).
  Nuance: the propAMM paper notes affected traders *sometimes* receive a better
  price than quoted; 0x's framing ("always in operator's favor") is the stronger
  claim. Present both.
- Uniswap v2 min-liquidity: whitepaper §3.4 states first mint `√(x·y)` then
  *burn* the first 1e-15 of shares (1000× the minimum 1e-18) to the zero
  address. The `shares = floor(√(dB·dQ)) − MIN_LIQUIDITY` form is the contract
  code's equivalent — cite the whitepaper for the mechanism, the code for the
  formula.

## A-11. Structural keeper risk — documented, mitigated by design
ethresear.ch (Jul 2026): a profit-maximizing proposer could censor oracle updates
and auction the resulting stale-price arb; on Ethereum PBS this is the default
(hence trusted-builder propAMM services). On Solana it is detectable but not
protocol-preventable. Mitigation in ArbSwap: quote expiry stops fills, breakers,
multiple bonded keepers. Record in THREAT_MODEL.md.

## A-12. Lifinity comparison nuance (prior art, re-check before demo) — VERIFIED
Lifinity docs: the oracle is the *key* pricing mechanism (not pool balances);
trades are only allowed when the oracle was **updated in the current slot** and
the confidence interval is narrow (their anti-front-running rule); concentration
is `x·y = c·k` (a multiplier on k, not tick ranges); custom in-house oracle
(vendor not named). **Consequence:** Lifinity's freshness/confidence rules are
closer to ArbSwap's §5.11/§5.12 checks than the Build Plan's comparison table
implies. Differentiators that still hold: versioned honest quotes + measured
quote-versus-fill gap, LVR-derived depth throttle, open bonded keepers, published
methodology. Add a Lifinity row with the freshness rule to the table.

## A-13. "propAMMs handle >50% of SOL/USDC volume" — NOT VERIFIED (deck claim)
This figure appears in both spec documents (§1.2 / R14 context) but was not
located in the sources skimmed on 2026-10-06. Re-check the propAMM paper's exact
wording (or its underlying data) before citing it in the deck or README.

## A-14. P2/P3 delivery boundary — P2 ORACLE VERIFIED, PRODUCTION OPEN
P2 `update_quote` now requires a Pyth Receiver `PriceUpdateV2` account with Full
verification, the configured feed ID, freshness, decoded Q64 price equality,
and confidence equality. The public breaker uses stored quote expiry only. P3
still has a deterministic dry-run sender rather than live RPC/private-key
transport; local lifecycle tests and devnet deployment remain pre-production
gates.

## A-15. Simulation clock and cost model (Task 1) — CLOCK DECIDED, COST MIX VERIFIED/HEURISTIC
- **Headline clock:** `step_seconds = 0.4` (Solana slot-native) with
  `source_step_seconds = 1.0` (the reference series is observed on a 1 s
  staircase; the vault reacts on a 400 ms grid). 1 s and 0.1 s runs are reported
  as **clock sensitivity only**, never as headline numbers.
  *Direction of the bias:* a coarser clock hands the arbitrageur fewer reaction
  opportunities, so a 1 s clock **understates** adverse selection on a lagging
  oracle. Measured (synthetic crash, 20 min, seed 4): vault hedged PnL 12.78 at
  1 s vs 9.64 at 400 ms vs 8.66 at 100 ms — 400 ms and 100 ms have converged,
  1 s has not. Asserted in `test_simulation_clock_is_a_sensitivity_not_a_free_parameter`.
- **Slot and landing:** `slot_seconds = 0.4`; keeper decisions sit on a
  wall-clock grid (multiples of `keeper_update_interval_seconds`) and are taken
  at the first slot boundary at or after the target, so decision times, decision
  counts and the order of the landing-delay draws are identical on any
  simulation clock (`test_keeper_decision_grid_does_not_depend_on_the_simulation_clock`).
  Landing = `ceil((t + delay) / slot) · slot`.
  `LANDING_DELAY_SECONDS = ((0.4,0.55),(0.8,0.25),(1.2,0.12),(2.0,0.05),(3.2,0.03))`
  (mean 0.76 s) is a **HEURISTIC** — not measured on Solana. Replace with a
  live-mempool measurement before any P4 claim.
- **Costs:** compute units are *measured* in LiteSVM (update 12,802 CU; swap
  201,119 CU) → VERIFIED; `base_fee_lamports = 5000` is the protocol parameter;
  `priority_micro_lamports_per_cu = 1000` is a **HEURISTIC** (priority fees are
  set by a leader auction). Gas and priority are converted to quote at the
  current reference SOL price.
- **Cost attribution:** update gas + priority are debited from the vault's quote
  on every refresh (the vault pays for its own crank); swap costs are recorded
  on `SimResult` but **not** debited, because the swapper signs that transaction.
- **Volatility clock:** the EWMA variance advances on *reference samples*, not on
  loop iterations, so the spread does not silently change with the simulation
  clock (bit-identical at `step_seconds = 1.0`).

## A-16. Three simulator defects found and fixed during Task 1 (2026-10-07)
1. **Displayed-ladder double-spend (high).** `VaultVenue.fill` consumed reserves
   but left `quote_state` intact, so every fill inside one `update_quote` window
   re-walked the original ladder and a fast arbitrageur could drain the vault many
   times between two keeper updates (gross turnover 120,850 on a 100 ms clock vs
   43,378 on a 400 ms clock). Fixed by `_consume()`, which removes the filled span
   from the displayed levels. Regression: `test_ladder_capacity_is_spent_once_per_quote_window`.
2. **Insolvency.** `_preview_fill` raises instead of driving a reserve negative
   (a negative base reserve previously broke `inventory_imbalance`).
3. **Zero-profit arbitrage sizing (high).** `_informed_trade` sized to the
   *average-price* breakeven, producing self-sustaining round trips that donated
   fees to the passive benchmark (B1 gross turnover ≈ 5.3M/h before the fix,
   ≈ 237k/h after). Replaced with golden-section maximisation of the *marginal*
   profit (`reference·out − in` for a buy, `in·(out′ − reference)` for a sell).
