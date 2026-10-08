# Reading notes — study questions answered (Build Plan T0.1)

One paragraph per study question from the Master Plan reading plan (§14), in
reading order. Sources were read on 2026-10-06; numbers marked VERIFIED appear
in the cited primary source, others are marked unverified. Status legend:
✅ read, 🟡 skimmed only (deep read still owed).

---

**1. Solmaz, Heimbach, Milionis — "Active Liquidity On Chain" (propAMMs), arXiv:2609.38056 ✅**
*How exactly is a markout computed, and what does "quiet flow" mean?*
A markout is the profit/loss of a single fill measured against the *market*
microprice τ seconds later: `markout(τ) = 1e4 · d · (m(t+τ) − p_exec) / p_exec`,
where `d = +1` if the venue bought base and `−1` if it sold, and `m` is the
Bybit **microprice** — the size-weighted mid of the top of book (Appendix A.3),
computed on the USDT pair and converted via the USDC/USDT mid. Positive markout
means the venue gained relative to the market. "Quiet flow" is the retail proxy:
a fill is *quiet* if the reference price moved less than 1 bps between t−5s and
t+1s (`|m(t+1s) − m(t−5s)| / m < 1 bps`); everything else is "moving" flow.
VERIFIED: Solana 2s markouts −0.22 bps (AMM) vs +0.37 bps (propAMM); quiet-flow
costs 0.26 bps on propAMMs vs 2.59 bps on AMMs; update 485–676 CU vs swap
≥16,938 CU; Base quote-vs-fill 39% identical / 1.08 bps worse.

**2. Milionis, Moallemi, Roughgarden, Zhang — LVR, arXiv:2208.06046 ✅ (v6 full text)**
*Why does LVR scale with volatility and marginal liquidity?*
LVR is the residual of LP returns after subtracting the "rebalancing strategy"
(the delta-hedged replication that holds the same base as the pool and trades at
CEX prices). The pool's only microstructural loss is *price slippage*: every
rebalance trades at a slightly worse price than the CEX. In continuous time the
instantaneous LVR rate is `ℓ = ½·σ²·P²·|x*'(P)|` where `x*'(P)` is the
**marginal liquidity** — how much base the pool must trade per unit of price
move. Volatility enters as variance (σ²: prices move further, so slippage per
trade is larger); marginal liquidity enters linearly (a pool that rebalances
more for the same price move trades more often at adverse prices). For constant
product, `x(P) = L/√P`, so `|x'| = L/(2P^1.5)` and `ℓ/V = σ²/8` — VERIFIED
in the paper (Example 3; the σ²/8 expectation was first derived by Angeris et
al. 2019, the paper extends it to a path-by-path result for all CFMMs). The
paper also shows 99.991% of v2 ETH-USDC LP return variance is beta — hedged
(alpha) returns are the right thing to measure, never raw LP PnL or IL.

**3. Baggiani, Herdegen, Sánchez-Betancourt — Optimal Dynamic Fees, arXiv:2506.02869 ✅**
*What does "linear in inventory" imply for our skew term?*
Their approximate-optimal fee is a first-order Taylor expansion of the HJB
optimum around the midpoint: `fee_lin = fee*(y⁰, s) + β·(y − y⁰)` — a term
**linear and signed in inventory** (y − y⁰), with level and slope both functions
of the external price s; simulations show this linear rule's revenue is
"indistinguishable" from the full optimum (constant fees lose ~19–20%). Two
regimes: high fees to deter arbitrageurs, low/negative fees to attract noise
trade. For ArbSwap this justifies (a) the *skew* in `P_res = P(1 − g·q)` as the
main inventory response — the fee/spread on the ask side rises and the bid side
falls when long base (antisymmetric), and (b) the fee-adjusted spread *midpoint*
tracking the oracle. It does **not** directly justify our symmetric `a2·|q|`
widening term — that remains a labeled heuristic (ASSUMPTIONS A-10).

**4. 0x — "PropAMM Shenanigans" ✅**
*What exactly is the quoted-versus-executed gap, and how did they measure it?*
They simulated fills at the top, middle, and bottom of each block against the
propAMM's on-chain quotes over ~1 month, comparing the *executed* output to the
quote an aggregator would have read at the end of the previous block — the same
baseline the Solmaz paper formalizes. Pattern 1 (Base Flashblocks): the tight
price is posted in the final ~200ms flashblock (final update lands in the last
10% of blocks, 97.4% of 461 blocks sampled) while the first flashblock of the
next block reprices worse — average 3–6 bps worse, outliers 40 bps, ~5–10
bps/trade, ≈ $500k/month per $1B traded. Measured intra-block price variance
**8.62 bps vs 1.23 bps inter-block (7× inversion) for a second propAMM on
Base** — VERIFIED (in the post's chart alt-text; A-03). Pattern 2: the spread
snaps 2 bps → 8/12/16 bps mid-flight. Appendix: *phantom liquidity* — deposit
in the last flashblock, withdraw in the first (non-flashblock-aware LP
rewards), pushing price impact from 2 bps to 8+ bps. Our warm-up + epoch queue
(§5.14) and versioned quotes are the direct countermeasures.

**5. Alexander & Fritz — Fees in AMMs, arXiv:2406.12417 ✅**
*Why are asymmetric fees better against toxic flow?*
Fee revenue is a hitting-time game: with a driftless reference price, trade
frequency scales as 1/f² and revenue per trade as f², so revenue is
fee-independent — but *with drift*, the frequency of trades arriving from the
(toxic, arbitrage) direction saturates instead of falling, so revenue rises
with the fee on the side the market is moving toward. A directional fee that
mimics the drift therefore harvests the informed side without suppressing
overall flow; the optimal fee is `f ≈ √α − 1` where α is the arbitrage
threshold, and in the best case the venue keeps 2/3 of the arbitrage surplus
(arb losses capped at ≤1/3). This is the theoretical basis for our §5.6
directional add-on (`ask_extra` when the market is rising, `bid_extra` when
falling): widen exactly the side the market is about to run through.

**6. Nadler, Schuler, Schär — Blockchain price oracles 🟡 (paywalled; abstract verified)**
*How does volatility drive oracle deviation?*
Verified from the abstract/metadata: 150M+ observations, 40 Chainlink feeds on
Ethereum over 18 months vs Binance, deviations measured in bps with
OLS/FE regressions and a Markov-style violation-recovery analysis; findings
describe economically significant deviations that grow with configuration
choices and market stress (i.e. volatility). The frequently cited "~57 bps
average" could **not** be verified (paywall) — ASSUMPTIONS A-02: do not cite
the number until a human reads it; the citation is J. Corp. Finance 96 (2026),
not 2025. Design implication regardless: widen on staleness/confidence (§5.11),
treat oracle error as a first-class risk — the OP-AMM paper (A-06) even splits
LVR into market-lag and oracle-error components, showing an oracle-anchored
pool trades LVR for oracle error rather than eliminating it.

**7. Pyth — Lazer announcement ✅**
*What update frequencies and trade-offs exist?*
Lazer offers a 1 ms channel plus 50 ms and 200 ms/custom channels, 1,000+
feeds, and richer payload (bid-ask, depth; averages coming) at ~15K CU for 20
feeds on Solana. The explicit trade-off: it "trades some elements of
decentralization for speed" — permissioned, custom-integration access (no
public pricing found), meant to be cross-referenced against Pyth Core with
circuit breakers. Core remains the pull-based, trust-minimized default:
`PriceUpdateV2` gives price/conf/publish_time in one read, updated in-band by
the caller in the same transaction as `update_quote` (A-07). Decision: ship on
Core, evaluate Lazer at P3; backtest history availability still open (T0.4).

**8. ZeroSwap, arXiv:2310.09413 ✅**
*What is the zero-profit condition and how is flow toxicity modeled?*
The zero-profit condition is Glosten–Milgrom efficiency: the ask equals the
conditional expectation of the external price given a buy (`p_a = E[p_ext | H, buy]`)
and symmetrically for the bid, so expected loss to informed traders is exactly
zero — any deviation earns profit but loses competitiveness. Toxicity is modeled
explicitly: with prob α traders are informed and know the hidden external price
(a discrete random walk with jump prob σ) and arbitrage whenever it crosses the
quotes; the rest trade uninformed. Spread scalings: Θ(√σT) with no trades,
Θ(σ/λ) in steady state, exponential decay after a single jump. Relevance: our
spread floor and the *shape* (wider when vol/uncertainty high) follow this
logic; the exact conditional-expectation pricing is the "zero-profit objective"
ablation (R6), not the MVP.

**9. Adaptive Curves, arXiv:2406.13794 ✅ (intro)**
*How can a curve adapt to trader behavior?*
Instead of fixing the bonding curve and only moving fees, they derive a
differential equation the *curve itself* must satisfy to minimize arbitrage
losses while keeping the same Glosten–Milgrom zero-profit condition (stay
competitive), then solve it online with a Kalman filter on a Gaussian/lognormal
price model — oracle-free adaptation to observed trader behavior; robust to
≤50% adversarial flow, with a Uniswap v4 on-chain implementation. For ArbSwap
this is roadmap-grade: our ladder offsets/weights are fixed heuristics (§5.7)
tuned offline; an adaptive curve is the "learn the flow" layer to consider
after the measurement pipeline (E1–E10) exists.

**10. Allium/Praxial — "Borrowed Machinery" 🟡 (summary read)**
*Why does the model work on Solana and not EVM?*
Because continuous requoting is only affordable where updating a quote is
cheap *and* fast: Solana's ~400ms slots with ~15ms sub-slots plus tiny
per-instruction cost make in-protocol quote updates (hundreds of CU) viable
multiple times per block, while EVM's ~12s blocks and gas-priced updates push
the same economics off-chain into RFQ/privately relayed quotes. The data backs
the mechanism: prop-AMM instructions grew from ~2M/month (late 2024) to
>350M/month (late 2025). Their conclusion — displacing Uniswap/Curve on EVM is
unlikely until sub-cent, sub-second updates exist — is the "why Solana" slide
(R14): our keeper's one-cheap-write repricing (R1) only pencils out here.

**11. Solana Compass — HumidiFi 🟡 (article read)**
*How do CU efficiency and landing infrastructure matter?*
CU efficiency is a competitive axis, not a footnote: HumidiFi cut update cost
from ~300 CU to **47 CU** over six months, and lower CU directly improves
inclusion priority in Solana's fee-per-CU greedy ordering — the "CU race" —
because oracle updates must land *before* trading takes or the edge is gone.
Landing is engineered: TPU + Jito bundles, with optimization help (Temporal).
Scale shows the model: ~$8M TVL supporting $500M–$1B daily volume (just-in-
time liquidity), no frontend, entirely aggregator-routed (Jupiter, DFlow,
Titan, OKX). Implications for us: (a) set tight compute-budget limits and
report CU per update as a first-class metric (E10), (b) the keeper needs
priority-fee scaling to win the same race (§7.1), (c) an aggregator adapter
(P5) is the distribution channel, not a nice-to-have.

**12. Ethresear.ch — "Proprietary AMMs and Ethereum" ✅ (sections 3–4)**
*How does a propAMM trade flow through an aggregator?*
Jupiter-style aggregators read on-chain state from every integrated venue
inside the routing computation, so the propAMM's cheap oracle updates
(~100× cheaper CU than a take; HumidiFi ~6M updates/day) refresh the state the
router sees; Solana's fee-per-CU ordering lets those updates land before takes,
giving the operator a weak form of application-controlled execution / last
look. Critical caveat (A-11): update-precedes-take is **not consensus-
enforceable** — a rational proposer could censor updates and auction the
stale-price arb (on Ethereum PBS this is the default, hence trusted-builder
propAMM services); on Solana it is detectable but not preventable. Our honest
execution does not rely on ordering guarantees: versioned quotes + `min_out` +
expiry enforce the promise regardless of ordering, and the threat model carries
the censoring-proposer threat with keeper-kill tests.

**13. Avellaneda & Stoikov (2008) ✅ (formulas verified via secondary sources)**
*How does the reservation price move with inventory?*
Reservation price: `r(s,t) = s − q·γ·σ²·(T−t)` — linear in inventory q: long
base (q>0) pushes the reservation *below* the reference, so both quotes shift
down, encouraging buys and shedding inventory; the coefficient is risk-aversion
γ times variance σ². The total spread `δᵃ+δᵇ = γσ²(T−t) + (2/γ)·ln(1+γ/κ)`
depends on vol and time, **not** on q — inventory moves the *mid* (skew), it
does not widen the spread in A–S. ArbSwap's `P_res = P(1 − g·q)` is exactly
the skew, recast in bps-per-unit-q form (a finite-horizon adaptation to be
stated as such in MATH.md); our symmetric `a2·|q|` spread term is an extra
conservative heuristic beyond A–S, again to be labeled as such.

**14. Glosten & Milgrom (1985) 🟡 (concept; classic)**
*Why does the spread compensate for informed trading?*
The market maker sets ask = conditional expectation of value given a buy and
bid = conditional expectation given a sell; because the counterparty may know
more (informed traders pick the side that is about to move), the expectations
are pulled inward from the midpoint — the wider the probability and depth of
informed order flow, the wider the spread needed for expected losses to
informed traders to be covered by profits on noise trades. This is the
qualitative engine behind every term in our half-spread formula (§5.5): σ, oracle
confidence c, staleness age, and jump flags are all proxies for "probability
the next taker knows something we don't," and the spread floor `s_floor` is the
minimum compensation for showing size at all.

---

**Background read/confirmed (not study questions):** Melnikov et al. (IG zones)
for the fee-as-regularizer idea is mechanism-only citation; Anchor/Solana
security docs and Pyth price-account docs feed §11 and A-07 directly; the
Sadeghi–Feinstein liquidation paper is MEV background only (confirmed not
needed otherwise). **Not needed:** nothing further beyond the priority list —
if time-constrained, the four that carry the pitch remain #1, #2, #3, #4 above.

**New must-read discovered during P0 (A-06):** Amini & Feinstein,
arXiv:2609.33799 (Oracle-Parametrized CFMMs) — skimmed; full read + comparison
table row still owed before demo.
