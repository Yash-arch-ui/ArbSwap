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

## A-03. "1.23 bps inter-block vs 8.62 bps intra-block variance" (Master Plan R10) — ASSUMPTION
Not found in the 0x blog text (which states intra-block variance runs **5–7×**
higher than inter-block) nor in any cached paper. The ratio is consistent with
0x's claim. Source-confirm before citing in writing.

## A-04. LVR paper numbers — VERIFIED (upgrade vs Master Plan §17.5)
The 99.991% variance-share figure appears in the **original** LVR paper v6
(abstract, §1, §7.2) — no "secondary report" needed. σ²/8 for constant product is
Example 3; narrow-liquidity LVR/V → ∞ (Master Plan R3) is Example 4.

## A-05. Solana update-cost economics — VERIFIED
propAMM paper §7.1: median updates 485–676 CU (Solana) vs ≥16,938 CU for a swap;
HumidiFi reported ~300 → 47 CU per update. The <1,000 CU target in Build Plan
§2.5 is conservative. Formal confirmation that ArbSwap's update + swap fit the
CU limit remains a P2/P3 build-time test (Build Plan §17.14).

## A-06. New prior art to read before demo — OPEN (action item)
**arXiv:2609.33799** — *Oracle-Parametrized Constant Function Market Makers*
(Amini & Feinstein, Sep 2026). Same design space as ArbSwap: oracle + reserves
pricing, LVR decomposition into market-lag vs oracle-error components, stale /
discrete-update oracle analysis, and a **sandwich-around-oracle-updates** attack
(added to `attackers/`). Read fully and add to the comparison table.

## A-07. Pyth product choice (Build Plan decision D-09) — OPEN
- **Pyth Core:** pull-based price feeds with confidence intervals; the safe,
  trust-minimized default. Verified existence of confidence + publish-time fields
  as required by Build Plan §5.11.
- **Pyth Lazer:** 1 ms / 50 ms / 200 ms channels, richer data (bid-ask, depth),
  **15K CU for 20 feeds on Solana**, permissioned/custom integration, designed to
  be cross-checked against Core with circuit breakers.
Access model and historical-data availability for backtests are unconfirmed.
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
- Directional fees vs toxic flow: Alexander & Fritz (arXiv:2406.12417) — with
  drift, revenue rises with fee on the exposed side; f_opt ≈ √α−1; best case the
  venue retains 2/3 of the arbitrage surplus.
- Zero-profit quoting: ZeroSwap (arXiv:2310.09413) ask/bid = conditional
  expectations; steady-state spread Θ(σ/λ). Adaptive Curves (arXiv:2406.13794)
  derive the optimal-curve ODE + Kalman update; robust to ≤50% adversarial flow.
- Reservation price: Avellaneda–Stoikov (2008), r = s − q·γσ²(T−t) — ArbSwap's
  `P_res = P(1 − g·q)` is the inventory-linear skew in bps form (state the adaptation).
- propAMM edge sources (Solmaz et al., arXiv:2609.38056): cheap updates,
  counterparty pricing, winning arb leg, spoofing — ArbSwap keeps the first three
  by design and removes spoofing via versioned quotes + the gap metric.
- Spoofing evidence (39% identical / 1.08 bps worse) is **Base/Flashblocks**;
  whether a comparable gap exists on Solana is unverified (Build Plan §17.1; E8).

## A-11. Structural keeper risk — documented, mitigated by design
ethresear.ch (Jul 2026): a profit-maximizing proposer could censor oracle updates
and auction the resulting stale-price arb; on Ethereum PBS this is the default
(hence trusted-builder propAMM services). On Solana it is detectable but not
protocol-preventable. Mitigation in ArbSwap: quote expiry stops fills, breakers,
multiple bonded keepers. Record in THREAT_MODEL.md.
