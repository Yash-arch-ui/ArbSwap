# TruQuote Master Plan
### An open, professionally managed market-making vault on Solana
*Working name, rename freely. Version 3: synced with the Build Plan, math model added, vault accounting corrected.*

**One-liner:** TruQuote is an **AMM + propAMM hybrid**. It takes the open, pooled capital of a traditional AMM and the active, volatility-aware quoting of a propAMM, and runs it like a professional desk: risk limits, circuit breakers, audited accounting, bonded operators, and one hard promise to traders: **the price you are quoted is the price you get.**

---

## What changed in version 3 (read this first)
| # | Change | Why |
|---|---|---|
| 1 | **Math model added (Section 6)**: anchor-relative ladder of constant-product segments, LVR-based depth rule, vault share math | Gives the vault a professional, established mathematical core |
| 2 | **Vault shares are now pro-rata in both tokens** (v2-style, minimum-liquidity burn), not NAV-priced | No oracle in share math, which removes a manipulation surface |
| 3 | **MVP performance fee = share of trading fees**; hedged-profit fee with high-water mark is computed off-chain first | Simple, deterministic, auditable on-chain |
| 4 | **Flow accumulator resets on every quote update** | Inventory skew already moves the reservation price |
| 5 | **Instruction `crank_nav` replaced by `crank_epoch`** | No NAV pricing on-chain |
| 6 | New research rows R15 to R17, a math rigor row in the win map, and a math Q&A | Ties the math to sources and to the pitch |
| 7 | New items in the verification list (Section 18) | Keeps unverified claims visible |

The detailed, agent-ready specification is in **TruQuote Build Plan** (Section 5 holds the full math). This Master Plan is the strategy and pitch document.

---

## Table of contents
1. Problem and insight (simple words)
2. The hybrid: what we take from AMMs and from propAMMs
3. Research map (finding to design to proof)
4. Full scope: every module
5. System architecture
6. Math model and pricing engine specification
7. Honest-execution specification
8. Professional vault design
9. Threat model and security plan
10. Evaluation methodology (experiments E1 to E10)
11. Build plan by phase
12. Tech stack and repository layout
13. Testing plan
14. Reading plan (what to read, in what order, what to look for)
15. Win map: judges, demo, pitch, Q&A, startup framing
16. Roadmap after the hackathon
17. Honest limits and things to verify

---

## 1. Problem and insight (simple words)

**How a normal AMM loses money.** A passive AMM only changes its price when someone trades against it. If SOL jumps on Binance, the AMM still shows the old price for a moment. A fast trader (arbitrageur) buys the cheap SOL from the AMM and sells it elsewhere. The AMM's liquidity providers (LPs) pay for this. The loss is called **LVR** (loss-versus-rebalancing). It gets bigger when the price is more volatile and when the pool offers more liquidity near the current price.

**Evidence from the research.**
- Passive AMMs have negative "markouts" (the profit or loss of a fill, measured a few seconds later): about -0.22 bps on Solana, 2 seconds after the fill. propAMMs have positive ones, about +0.37 bps (Solmaz et al.).
- propAMMs now handle more than half of SOL/USDC volume on Solana (same paper).
- Retail-like trades (fills when the reference price is not moving) pay about 0.26 bps on Solana propAMMs versus 2.59 bps on AMMs.

**Why propAMMs are not the full answer.**
1. They are run by **one operator** with its own money. Normal users cannot earn that edge.
2. Their pricing is **closed-source**. Traders cannot inspect how a price is set.
3. On Base, one propAMM executed at the quoted price only **39%** of the time, and the average swap got **1.08 bps worse** than quoted (the paper calls this "spoofing"). 0x separately documented similar behavior and a "phantom liquidity" trick.

**The insight.** Nobody offers professional-style active quoting that is (a) open to anyone's capital, (b) transparent and rule-bound, and (c) honest about execution. That is the gap TruQuote fills.

## 2. The hybrid: what we take from each side

| From traditional AMMs | From propAMMs |
|---|---|
| Permissionless pooled capital: anyone deposits, gets shares | Active quoting: prices change by writing parameters, no trade needed |
| On-chain, deterministic swap logic that anyone can inspect | Anchor price + spread structure: one cheap write reprices the whole book |
| Composability with aggregators and other programs | Adverse-selection defenses: volatility-scaled spread, quote expiry, flow rules |
| Pro-rata LP shares and open entry/exit | Cheap, frequent, low-compute updates |

**Where TruQuote differs from a real propAMM:** many LPs own the inventory, and an *algorithm with on-chain bounds* sets prices instead of a private desk. **Where it differs from a passive AMM:** it does not wait for a trade to reprice.

**Closest prior art on Solana:** Lifinity uses an oracle as its main pricing input. Our differences: measured markouts and LVR benchmarking, a depth throttle, versioned honest quotes, an open keeper network, and a published methodology. (Always re-check prior art before demo day.)

## 3. Research map: finding to design to proof

| # | What we build | Finding that justifies it | Source | How we prove it |
|---|---|---|---|---|
| R1 | Reprice without a trade, one-write updates | Update costs ~485-676 CU versus 16,938+ for a swap on Solana | Solmaz et al. §7.1 | Report CU per update |
| R2 | Spread scales with volatility | LVR depends on volatility and marginal liquidity | Milionis et al. (LVR) | LVR reduction versus passive pool |
| R3 | Depth throttle (less liquidity when risky) | LVR is driven by marginal liquidity; narrow liquidity makes LVR per dollar blow up | LVR paper and its project report (verify) | Hedged PnL by regime |
| R4 | Inventory skew + price-move-aware spread | Fees linear in inventory that track external price approximate the optimum | Baggiani et al. | PnL versus fixed-spread version |
| R5 | Direction-aware add-on on the exposed side | Asymmetric dynamic fees mitigate toxic flow | Alexander & Fritz | Markouts by side |
| R6 | Zero-profit pricing objective for flow toxicity | Informed versus noise flow balance (Glosten-Milgrom) | ZeroSwap; Adaptive Curves | Toxicity ablation |
| R7 | Priority-fee penalty, same-side flow netting | Tessera uses these to protect against pick-offs | Solmaz §2, §7.2 | Markouts with/without the rule |
| R8 | Quote expiry: grace, then worse, then no fill | Guards against late updates | Solmaz §7.1 | Stale-quote loss test |
| R9 | Staleness and confidence checks on the oracle | Oracle deviation is real (~57 bps average on Chainlink, larger in volatility) | Nadler et al. | Stale-feed attack test |
| R10 | **Honest execution** (versioned quotes, no fee flips) | Quote versus fill: 39% identical, 1.08 bps worse; 1.23 bps inter-block versus 8.62 bps intra-block variance on another propAMM | Solmaz §7.4; 0x | Quote-versus-fill metric |
| R11 | LP warm-up and withdrawal queue | "Phantom liquidity" deposited before block end and withdrawn after | 0x | Attack simulation |
| R12 | Retail-quality metric | Quiet fills pay 0.26 bps on propAMMs versus 2.59 on AMMs | Solmaz §8 | Quiet half-spread |
| R13 | Hedged evaluation, not raw PnL and not IL | Market exposure dominates LP PnL variance; impermanent loss is a flawed metric | LVR project report (verify against original) | Fees minus LVR reporting |
| R14 | Why Solana | Cheap, frequent updates make on-chain active quoting viable; EVM gas and block times push it off-chain | Allium/Praxial | Positioning slide |
| R15 | **Ladder of constant-product segments, anchored to the oracle** | Concentrated-liquidity formulas are established; relative offsets let one write reprice the book | Uniswap v3 whitepaper; Solmaz et al. §2 (Tessera design) | Differential tests against a Python reference |
| R16 | **Depth rule from the LVR budget** (`V_active <= 8(R - gas)/sigma^2`) | For constant product, LVR rate is proportional to liquidity, and LVR/V = sigma^2/8 | Milionis et al. (verify against the original) | Throttle ablation (E5) |
| R17 | **Pro-rata share math with minimum-liquidity burn** | Removes oracle dependence and first-depositor attacks | Uniswap v2 design; ERC-4626 conventions (verify) | Fuzz and invariant tests |

## 4. Full scope: every module

| ID | Module | What it does | Phase |
|---|---|---|---|
| M1 | Vault core | Holds SOL and USDC reserves, mints and burns shares | P2 |
| M2 | Pro-rata share accounting + NAV reporting | Pro-rata two-token shares (no oracle in share math); NAV used only for reporting | P2 |
| M3 | Quote state | Anchor, half-spread, skew, depth multiplier, version, expiry | P2 |
| M4 | Swap engine | Walks price levels, applies fee rules, enforces expiry and min_out | P2 |
| M5 | Pricing engine | Volatility, inventory, staleness, confidence, directional add-on, depth throttle | P1 |
| M6 | Keeper client | Reads Pyth, computes quote, sends updates with adaptive priority fee | P3 |
| M7 | Keeper network | Open participation with bonds, rewards, and slashing | P5 |
| M8 | Risk limits | Hard caps on inventory, quote size, anchor step, spread | P2 |
| M9 | Circuit breakers | Auto-pause on stale or wide-confidence oracle or volatility spike | P2 |
| M10 | Warm-up and withdrawal queue | Delayed activation of deposits, epoch withdrawals | P2 |
| M11 | Fees and incentives | MVP: fixed split of trading fees (LPs, insurance, keepers, protocol); hedged-profit performance fee with high-water mark computed off-chain first | P4 |
| M12 | Insurance buffer | Portion of fees absorbs tail losses before LPs | P4 |
| M13 | Attribution | Per-epoch report: fees, LVR avoided, inventory PnL, gas | P4 |
| M14 | Simulator and backtester | Event-driven replay with baselines | P1 |
| M15 | Attacker bots | Stale-oracle, sandwich, phantom-liquidity, adversarial flow | P5 |
| M16 | Analytics API | Markouts, quote-versus-fill, LVR, retail half-spread | P4 |
| M17 | Dashboard | LP view, trader view, risk view, comparison view | P4 |
| M18 | Aggregator adapter | Makes the vault routable (Jupiter-style AMM interface; verify current spec) | P5 |
| M19 | Governance and timelock | Parameter changes behind a delay; multisig kill switch | P5 |
| M20 | Docs and reproducibility | Methodology doc, data scripts, one-command reproduce | P6 |

## 5. System architecture

```
   Pyth price + confidence + publish time        CEX reference (research/backtest)
              |                                          |
              v                                          v
   +----------------------+   quote params    +---------------------------------+
   | Keeper(s) (Rust)     | ----------------> | TruQuote Program (Anchor)       |
   |  - vol estimator     |  1 cheap write    |  Vault | QuoteState | Config    |
   |  - quote calculator  |  per update       |  RiskLimits | Breakers          |
   |  - adaptive priority |                   |  Swap | Deposit | Withdraw      |
   |    fee               |                   |  WithdrawQueue | KeeperBond     |
   +----------+-----------+                   +----------------+----------------+
              ^                                                |
              |  fills, inventory, events                      | events/logs
              +------------------------------------------------+
                                      |
                       +--------------v---------------+
                       | Indexer + Analytics service  |
                       | markouts, LVR, quote-vs-fill |
                       | attribution, retail metric   |
                       +--------------+---------------+
                                      |
                          +-----------v-----------+
                          | Dashboard (web)       |
                          | LP | Trader | Risk    |
                          | Passive vs TruQuote   |
                          +-----------------------+
```

### 5.1 On-chain accounts

**Vault**
- token reserve accounts (base, quote), share mint, authority
- `total_shares`, fee buckets (insurance, keeper pool, protocol), `min_liquidity` burned at first deposit
- `status` (Active, Paused, WindDown)

**QuoteState**
- `anchor_price`, `half_spread_bps`, `skew_bps`, `depth_mult`
- `levels[]`: per-level size and price multiplier (ladder, as in Tessera's design)
- `flow_n`: net base sold since the last update (resets to 0 on every `update_quote`)
- `version`, `update_slot`, `expiry_slot`
- `oracle_publish_time`, `oracle_conf_bps`

**Config (immutable bounds; changes via timelock)**
- `max_spread_bps`, `min_spread_bps`, `max_anchor_step_bps`, `max_staleness_slots`
- `max_inventory_bps`, `max_quote_size`, `max_conf_bps`, `max_vol_bps`
- `warmup_slots`, `epoch_slots`, fee rates, keeper reward and bond sizes

**WithdrawQueue / DepositTicket**
- per-user tickets with `activate_slot` and `epoch`

**KeeperBond**
- `keeper`, `bond`, `valid_updates`, `rejected_updates`, `slashed`

### 5.2 Instructions

| Instruction | Who | Key checks |
|---|---|---|
| `initialize_vault` | admin | sets config bounds, mints shares |
| `deposit` | LP | proportional two-token deposit; shares inactive until warm-up; minimum-liquidity burn on the first deposit |
| `request_withdraw` / `claim_withdraw` | LP | queue by epoch; pays pro-rata share of reserves; honors liquidity |
| `update_quote` | keeper | anchor within `max_anchor_step`, spread within bounds, oracle fresh and confident, slot monotonic |
| `swap` | trader/aggregator | `min_out`, `quote_version` window, expiry, size cap, inventory cap, breaker state |
| `crank_epoch` | anyone | advance the epoch and settle queue accounting |
| `trip_breaker` / `reset_breaker` | anyone / admin | automatic on stale, wide confidence, volatility spike |
| `bond_keeper` / `slash_keeper` | keeper / program | open participation with accountability |
| `set_params` | governance | only through timelock |

### 5.3 State machines

**Quote lifecycle:** Fresh (full depth) → Aging (spread widens each slot past grace) → Expired (no fills) → Fresh again on a valid update.
**Vault lifecycle:** Active → Paused (breaker or admin) → Active, or → WindDown (withdrawals only).
**LP lifecycle:** deposit ticket → warm-up → active shares → withdraw ticket → epoch settlement.

### 5.4 Off-chain services
- **Keeper (Rust):** subscribes to Pyth (Lazer or Core, depending on access), computes quote, signs and sends update, tunes priority fee to urgency.
- **Indexer:** parses program events and Solana transactions into a database.
- **Analytics service:** computes markouts against a reference, LVR, quote-versus-fill gap, retail half-spread, attribution.
- **Dashboard (TypeScript):** live and replay modes.

## 6. Math model and pricing engine specification

> **Principle:** use an established model for each job, and keep the spread coefficients honest as tunable heuristics. The full agent-ready version, with every formula, rounding rule, and parameter, is Section 5 of the **Build Plan**.

### 6.1 The math stack
| Layer | Model | Established? | Role |
|---|---|---|---|
| 1. Execution curve | Oracle-anchored ladder of **constant-product segments** (Uniswap v3-style sqrt-price math) | Yes | Fills trades with smooth price impact |
| 2. Inventory skew | Avellaneda-Stoikov reservation price | Yes | Sheds lopsided inventory |
| 3. Depth rule | **LVR budget** (Milionis et al.) | Yes | The core, defensible control |
| 4. Spread shape | Linear in inventory and price move (Baggiani et al.) | Yes | Theoretical support for the spread formula |
| 5. Flow toxicity | Glosten-Milgrom logic (optional belief update) | Yes (concept) | Optional depth |
| 6. Volatility | EWMA of 1-second returns plus jump detector | Yes | Feeds layers 3 and 4 |
| 7. Vault shares | Pro-rata two-token shares, minimum-liquidity burn, rounding in the vault's favor | Yes | Safe, oracle-free accounting |
| 8. Evaluation | Markouts, LVR, hedged PnL | Yes (the papers' methods) | Proof |

### 6.2 Core formulas
**Inputs:** oracle price `P`, confidence `c`, age `a`, inventory imbalance `q = (B*P - Q)/(B*P + Q)` in [-1, 1], volatility `sigma_s`, recent move `m`.

```
reservation price   P_res = P * (1 - g*q)
half-spread         s     = s_floor + a1*sigma_s + a2*|q| + a3*(c/P) + a4*max(0, a - grace) + a5*jump
                    s     = clamp(s, s_min, s_max)               # s_max also enforced on-chain
directional add-on  ask_extra = e*max(0, m) ; bid_extra = e*max(0, -m)
ladder (ask side)   lo_k = P_res*(1 + s + ask_extra + off_{k-1}) ; hi_k = P_res*(1 + s + ask_extra + off_k)
level capacity      C_k = w_k * depth_mult * u_max * B           # bid side uses Q the same way
level liquidity     L_k = C_k / (1/sqrt(lo_k) - 1/sqrt(hi_k))    # ask side
```
**Swap inside a level (constant-product segment):**
```
buy base with dy_in :  sqrt(p') = sqrt(p) + dy_in/L ;        dx_out = L*(1/sqrt(p) - 1/sqrt(p'))
sell base dx_in     :  1/sqrt(p') = 1/sqrt(p) + dx_in/L ;    dy_out = L*(sqrt(p) - sqrt(p'))
if the level is exhausted, fill it fully and carry the remainder to the next level
```
### 6.3 The LVR link and the depth rule
For a constant-product segment, holdings are `x(P) = L/sqrt(P)`, so `|x'(P)| = L/(2*P^1.5)`:
```
LVR rate = (1/2) sigma^2 P^2 |x'(P)| = sigma^2 * L * sqrt(P) / 4
value  V = 2 * L * sqrt(P)           =>   LVR / V = sigma^2 / 8
```
LVR is **proportional to liquidity `L`**, so cutting `L` in risky moments cuts LVR directly. Require expected revenue `R` to cover LVR plus gas:
```
V_active <= 8 * (R - gas_per_second) / sigma^2        # doubling volatility cuts allowed depth to a quarter
depth_mult = min( min(1, sigma_target/sigma_s) * max(0, 1 - c/c_max) , depth_budget )
```
This is the most defensible formula in the project, so it gets a slide.

### 6.4 Vault share math (decision changed in v3)
```
first deposit : shares = floor(sqrt(dB*dQ)) - MIN_LIQUIDITY        # MIN_LIQUIDITY burned permanently
later deposit : shares = min( floor(dB*S/B), floor(dQ*S/Q) )
withdraw      : out_B = floor(shares*B/S) ; out_Q = floor(shares*Q/S)
```
Deposits are proportional in both tokens, activate after the warm-up, and withdrawals settle by epoch. Single-sided deposits move to the roadmap.

### 6.5 Fixed-point and rounding
Q64.64 sqrt prices, `u128` intermediates, `u64` token amounts, checked arithmetic, no floats on-chain. Amounts the vault pays out round **down**; amounts it receives round **up**. *Verify the Q64.64 conventions against Orca's open-source code and check the license before adapting anything.*

### 6.6 What is proven versus tuned
| Proven or established | Tuned heuristic |
|---|---|
| Constant-product segment formulas | Spread coefficients `a1..a5`, `e`, `g` |
| LVR/V = sigma^2/8 for constant product | Ladder offsets and capacity weights |
| Pro-rata share math, rounding rules | Throttle parameters (`sigma_target`, `c_max`) |
| Markout and hedged-PnL definitions | Update cadence and thresholds |

**Verification:** a high-precision Python reference, golden test vectors, differential tests on the on-chain integer math, and invariant tests (no value created from nothing, shares and reserves consistent, rounding favors the vault). *Caveat:* the LVR formula assumes continuous prices and no fees; with oracle-anchored quotes, realized adverse selection differs, so treat the depth rule as a principled upper bound and validate it in the simulator.

## 7. Honest-execution specification

**Promise:** for any swap, the output is at least what the quote state implied when the trader or aggregator last read it, within a stated tolerance, or the swap fails.

1. **Versioned quotes.** Each `swap` carries `quote_version` and `min_out`. The program accepts if the output computed on the current state is at least `min_out`; a newer version that is *worse* fails the swap instead of silently filling worse.
2. **No discretionary fee flips.** Every fee is a public function of public state. There is no admin or keeper path to change fees inside a slot.
3. **Parameter step limits.** Updates can move the anchor and spread only within `max_anchor_step` and `max_spread_step` per slot.
4. **Expiry, not drift.** Past `expiry_slot`, the vault stops filling.
5. **Liquidity warm-up.** New deposits and queued withdrawals cannot change displayed depth within the same slot (blocks phantom liquidity).
6. **Published metric.** The **quote-versus-fill gap**: for each swap, compare the output implied by the state at the end of the previous slot (what an aggregator would have read) with the actual output. Report mean, volume-weighted mean, share identical, and tail.

**Important caveat:** the spoofing evidence (39% identical, 1.08 bps worse) is from Base and exploits Flashblock timing. Whether a comparable gap exists on Solana is **unverified**. We pitch TruQuote as honest *by construction*, and we measure Solana pools ourselves (E8) before saying anything about competitors.

## 8. Professional vault design

**8.1 Share accounting (M1, M2).**
- **Pro-rata two-token shares** (Section 6.4): no oracle in share math. NAV (reserves marked at the oracle) is for reporting and fee attribution only.
- First-depositor and donation attacks: minimum-liquidity burn at the first deposit (virtual offsets are an option).
- Rounding always favors the vault.

**8.2 Risk limits (M8).**
- Inventory band: quotes skew harder as `|q|` grows; the exposed side stops at the cap.
- Max quote size per slot and max cumulative one-sided flow per window.
- Hard bounds on anchor step, spread, depth multiplier.

**8.3 Circuit breakers (M9).**
Trip on: stale oracle (age above `max_staleness`), confidence above `max_conf`, volatility above `max_vol`, anchor deviating from the oracle by more than a bound, or repeated failed updates. Behavior: stop quoting, allow withdrawals, require a cool-down to reset.

**8.4 Warm-up and withdrawal queue (M10).**
Deposits activate after `warmup_slots`. Withdrawals request in epoch N and settle in epoch N+1 as a pro-rata share of reserves. Prevents running ahead of volatility and phantom liquidity. Emergency exit path always exists (pro-rata of reserves).

**8.5 Fee structure (M11).**
- **MVP (on-chain):** a fixed split of trading fees: LPs, insurance buffer, keeper pool, protocol.
- **Next (off-chain first):** a performance fee only on *hedged* profit (fees minus LVR, beta stripped) with a **high-water mark**, so the operator earns only on genuine alpha. Move it on-chain once the attribution is proven.
- Keeper reward per valid update, funded from trading fees.

**8.6 Insurance buffer (M12).** A fixed share of fees accumulates into a reserve that absorbs losses before they reach LP NAV, up to a cap.

**8.7 Keeper network (M7).** Anyone can run a keeper by posting a bond. Valid updates earn rewards; updates that violate bounds are rejected on-chain; provable misbehavior is slashed. Because the quote is a deterministic function of the oracle and vault state, keepers add *timeliness*, not discretion. Multiple keepers compete for the reward; the first valid update per slot wins.

**8.8 Attribution report (M13).** Per epoch: gross LP return, market-beta component, hedged return, fees collected, LVR avoided versus a passive benchmark, inventory PnL, gas, insurance contribution. Computed from the vault's risky-asset holdings and a reference price series.

**8.9 Governance and operations (M19).** Parameter changes via timelock; multisig kill switch that can only pause (never seize funds); public status page; incident runbook.

## 9. Threat model and security plan

| Threat | How it hurts | Mitigation | Test |
|---|---|---|---|
| Stale or lagging oracle | Arbitrageurs pick off old quote | Staleness/confidence widening, breaker, expiry | Stale-feed replay |
| Oracle manipulation or bad print | Wrong anchor | Confidence bounds, max anchor step, deviation breaker | Injected bad-tick test |
| Faster CEX feed than ours | Informational disadvantage | Directional add-on, depth throttle, spread floor | Latency-injection backtest |
| Sandwiching the vault's swaps | Trader or vault loses | `min_out`, size caps; document use of private/bundle submission | Sandwich bot |
| Keeper compromise or downtime | Bad or no updates | On-chain bounds; expiry stops fills; open keepers | Keeper-kill test |
| Share inflation / donation | Steals from later depositors | Virtual shares, burn minimum liquidity | Fuzz tests |
| Deposit/withdraw timing games | Phantom depth, run before volatility | Warm-up, epoch queue | Timing simulation |
| Account/PDA confusion, missing checks | Funds drained | Anchor constraints, owner/signer/seed checks, no unchecked CPIs | Audit checklist, fuzzing |
| Arithmetic overflow/rounding | Value leakage | Checked math, rounding in vault's favor | Property tests |
| Griefing (spam updates/fills) | CU/DoS, wear | Update rate limits, reward only valid updates, size minimums | Load test |
| Governance abuse | Param rug | Timelock, bounds in config, pause-only kill switch | Review |
| Toxic flow adapts to public rules | Rules gamed | Minimal rules, spread floor, ablations show robustness | Adaptive-attacker test |

Security process: written threat model, Anchor constraints everywhere, property-based and fuzz testing (Trident or equivalent; verify tooling), an internal review checklist, and an external review if time allows.

## 10. Evaluation methodology

**Baselines.**
- B1: passive constant-product pool (fee configurable; run at several fee levels, including low fees typical of major SOL/USDC pools).
- B2: TruQuote with a **fixed spread** (no engine).
- B3: TruQuote without the depth throttle (ablation).
- B4: TruQuote without honest-execution rules (to show the gap metric works).

**Data.**
- 1-second reference prices from a major CEX (the paper used Bybit's public order-book archive; Binance klines are an alternative). Pyth historical data for the oracle side.
- Optional on-chain swap data for real Solana pools (Old Faithful archive as in the paper, or an indexer/Dune-style source; verify access).
- Regimes: calm, trending, high-volatility/crash. Select dates in advance.

**Simulator design (M14).** Event-driven replay: reference price path; Pyth-like oracle with latency, noise, confidence; informed flow (arbitrageurs trade when mispricing exceeds fee+gas); noise flow (Poisson arrivals, size distribution); gas and priority-fee model; block/slot timing; optional adversarial flow. Report with seeds and confidence intervals.

**Experiments.**
| ID | Question | Output |
|---|---|---|
| E1 | Does TruQuote reduce LVR versus B1? | LVR reduction % by regime |
| E2 | Are markouts positive? | 2s notional-weighted markout, plus full curve (-5 to +15s) |
| E3 | What is hedged LP return? | Fees minus LVR, beta stripped |
| E4 | Is retail execution good? | Quiet-flow half-spread (fills with <1 bps reference move) |
| E5 | Does the depth throttle matter? | Ablation B3 |
| E6 | Do honest rules cost anything? | Fill rate and PnL versus B4 |
| E7 | Is it safe? | Stale-feed, bad-tick, sandwich, phantom-liquidity, keeper-down results |
| E8 | Quote-versus-fill gap on real Solana pools | Measured gap for 2 to 3 existing venues (verify data access) |
| E9 | Sensitivity | Fee level, volatility, latency, parameter perturbation |
| E10 | Cost on Solana | CU per update/swap; update cadence versus cost |

**Key definitions.** Markout (bps) = `1e4 * d * (m(t+tau) - p_exec)/p_exec`, with `d = +1` if the vault bought base and `-1` if it sold; positive means the vault gained. Hedged PnL = `sum_t [V_{t+1} - V_t - B_t*(P_{t+1} - P_t)]` (value change minus the delta-hedge gain on actual base holdings). Quote-versus-fill gap = `1e4*(out_quoted - out_executed)/out_quoted`, where `out_quoted` comes from the state at the end of the previous slot. Quiet fill = reference moves less than 1 bps from 5 seconds before to 1 second after.

**Reporting rules.** Walk-forward parameters, frozen before test; show losing regimes; include gas, fees, slippage; report both gross and net; state all assumptions. Never headline raw LP PnL or impermanent loss.

## 11. Build plan by phase

*Phases are sequential gates; lengths are suggestions and can stretch or compress.*

**P0: Foundations (week 0-1).** Read priority papers; write threat model and spec; set up repo; choose data sources; verify the open questions in section 17.
*Gate:* spec reviewed; data access confirmed.

**P1: Research core (weeks 1-3).** Build the simulator and baselines; implement the pricing engine in Python/Rust; reproduce a simple version of Solmaz-style markouts; calibrate; first E1 to E3 results.
*Gate:* TruQuote beats B1 and B2 in at least two regimes on paper, honestly reported.

**P2: On-chain program (weeks 3-6).** Anchor program with M1-M4, M8-M10; unit and property tests; local validator tests; devnet deployment.
*Gate:* deposit, swap, update, withdraw loop works with bounds enforced.

**P3: Keeper (weeks 5-7).** Rust keeper using Pyth; adaptive priority fee; failure handling; replay mode to match simulator.
*Gate:* keeper-driven quotes on devnet match the simulator's quotes within tolerance.

**P4: Analytics, fees, dashboard (weeks 6-9).** Indexer, analytics API, attribution, fee split (MVP) with the hedged-profit fee and high-water mark computed off-chain, insurance buffer, dashboard (LP, trader, risk, comparison views).
*Gate:* dashboard reproduces the E1 to E4 charts from live or replayed data.

**P5: Hardening and network (weeks 8-11).** Attacker bots (E7); keeper bonds and slashing; aggregator adapter; governance/timelock; fuzzing; fixes from review.
*Gate:* all E7 attacks fail or are contained; documented.

**P6: Story and submission (weeks 11-12).** Reproducibility package; write-up; deck; demo rehearsal; record backup AN.
*Gate:* a stranger can reproduce the headline chart from the README.

## 12. Tech stack and repository layout

**Stack (verify current versions):** Rust + Anchor for the program; Rust for the keeper; Python (pandas/numpy) for research; TypeScript (Next.js) for the dashboard; Postgres or ClickHouse for analytics; Pyth for oracle data; devnet for deployment.

```
truquote/
  programs/truquote/        # Anchor program
  keeper/                   # Rust keeper
  research/
    data/ (scripts only)    # download + clean
    sim/                    # simulator
    pricing/                # pricing engine (shared logic)
    notebooks/
  analytics/                # indexer + metrics (markout, LVR, gap)
  app/                      # dashboard
  attackers/                # adversarial bots
  docs/                     # spec, threat model, methodology
  tests/                    # integration + property tests
```

Design rule: **the same pricing code** (or a bit-exact port) powers the simulator and the keeper, so the backtest actually describes the product.

## 13. Testing plan
- **Unit:** share math, NAV, fee accrual, ladder walk, expiry behavior.
- **Property/fuzz:** invariants (no value created from nothing; shares and reserves consistent; swap never exceeds caps; rounding favors vault).
- **Integration:** full lifecycle on a local validator; keeper against devnet.
- **Differential:** on-chain quote equals simulator quote for the same inputs.
- **Adversarial:** E7 bots.
- **Load:** update spam, swap spam, CU budget.

## 14. Reading plan

**Read in this order. For each, answer the study question in writing.**

| # | Paper / source | Read | Study question | Link |
|---|---|---|---|---|
| 1 | Solmaz, Heimbach, Milionis: Active Liquidity On Chain (propAMMs) | §2, §6-8, App. C.3, App. G | How exactly is a markout computed, and what does "quiet flow" mean? | https://arxiv.org/abs/2609.38056 |
| 2 | Milionis et al.: Loss-Versus-Rebalancing | Intro, LVR definition, main theorem | Why does LVR scale with volatility and marginal liquidity? | https://arxiv.org/abs/2208.06046 |
| 3 | Baggiani et al.: Optimal Dynamic Fees | Abstract, intro, approximate-fee result | What does "linear in inventory" imply for our skew term? | https://arxiv.org/abs/2506.02869 |
| 4 | 0x: PropAMM Shenanigans | All | What exactly is the quoted-versus-executed gap, and how did they measure it? | https://0x.org/post/propamm-shenanigans |
| 5 | Alexander & Fritz: Fees in AMMs | Directional fee sections | Why are asymmetric fees better against toxic flow? | https://arxiv.org/abs/2406.12417 |
| 6 | Nadler et al.: Blockchain price oracles | Abstract, deviation results | How does volatility drive oracle deviation? | https://doi.org/10.1016/j.jcorpfin.2025.102908 |
| 7 | Pyth Lazer announcement | All | What update frequencies and trade-offs exist? | https://www.pyth.network/blog/introducing-pyth-lazer-launching-defi-into-real-time |
| 8 | ZeroSwap | Intro, model | What is the zero-profit condition and how is flow toxicity modeled? | https://arxiv.org/abs/2310.09413 |
| 9 | Adaptive Curves for Optimally Efficient Market Making | Intro | How can a curve adapt to trader behavior? | https://arxiv.org/abs/2406.13794 |
| 10 | Allium/Praxial: Borrowed Machinery | Summary and report | Why does the model work on Solana and not EVM? | https://www.allium.so/blog/praxial-and-allium-why-prop-amms-stay-a-solana-story-2/ |
| 11 | Blockworks/Solana Compass on HumidiFi | All | How do CU efficiency and landing infrastructure matter? | https://solanacompass.com/learn/Lightspeed/how-humidifi-became-solanas-largest-prop-amm |
| 12 | Ethresear.ch: Proprietary AMMs and Ethereum | Sections 3-4 | How does a propAMM trade flow through an aggregator? | https://ethresear.ch/t/proprietary-amms-and-ethereum/25543 |
| 13 | Avellaneda & Stoikov (2008), "High-frequency trading in a limit order book" | Main model | How does the reservation price move with inventory? | Search the title (link not verified) |
| 14 | Glosten & Milgrom (1985) | Concept | Why does the spread compensate for informed trading? | Search the title (link not verified) |

**Background you may want:** Melnikov et al. (IG zones, https://arxiv.org/abs/2604.28014) for the fee-as-regularizer idea (small pools, one arbitrageur: cite the mechanism only); Anchor and Solana program-security documentation; Pyth price-account and confidence documentation.

**Not needed for this project:** the liquidation-dynamics paper, except for general MEV context.

## 15. Win map

### 15.1 Judging criteria and our answers
| Criterion | Our answer | Evidence we show |
|---|---|---|
| Real problem | LPs lose to LVR; traders get worse-than-quoted fills; the propAMM edge is closed | E1, E2, E8 charts |
| Solana-native | Active on-chain quoting is viable because updates are cheap in compute | E10 CU numbers |
| Technical depth | Program + pricing engine + keeper network + simulator + analytics | Repo, tests |
| Novelty | Open, vault-based active liquidity with versioned honest quotes and bonded keepers | Comparison table versus Lifinity, propAMMs, passive AMMs |
| Rigor | Paper-grade methodology, ablations, losing regimes shown | E1-E9 |
| Math rigor | Established models per layer, an LVR-derived depth rule, a Python reference, golden vectors, fuzzing | Math slide; test report |
| Security | Threat model, attacker bots, bounds enforced on-chain | E7 |
| Demo | Live passive-versus-TruQuote replay and a crash scenario | Dashboard |
| Business | Performance fee on hedged alpha, keeper fees, integrator revenue | Fee model |

### 15.2 Three-minute demo
1. (20s) "Passive pools lose to arbitrage; here is the number." LVR chart.
2. (30s) Price jumps in replay. The passive pool is picked off; TruQuote reprices first.
3. (40s) Markout curves: passive negative, TruQuote positive.
4. (40s) Quote-versus-fill: ours is about zero.
5. (30s) Crash scenario: depth throttle and breaker keep LPs safe.
6. (20s) Roadmap and ask.

**Ten-minute version:** add the architecture walkthrough, a live devnet swap, the keeper network, the attribution report, and the attacker-bot results.

### 15.3 Pitch deck outline (10 slides)
1) Title and one-liner. 2) Problem (LVR, closed propAMMs, quote gaps). 3) Insight (open + active). 4) How it works (diagram). 5) Honest execution. 6) Professional vault features. 7) Results (three charts). 8) Security. 9) Business model and roadmap. 10) Team and ask.

### 15.4 Hard questions and answers
| Question | Answer |
|---|---|
| "Isn't this Lifinity?" | Lifinity uses an oracle too. We add measured markouts and LVR benchmarking, a depth throttle, versioned honest quotes, bonded open keepers, and a published methodology. |
| "Can you beat HumidiFi?" | Not on landing speed, and we don't claim to. We win on open capital and transparency. |
| "Pyth lags top CEX feeds." | True, so we widen on staleness and confidence, throttle depth, expire quotes, and show the latency-injection results. |
| "What if the keeper fails?" | Quotes expire and the vault stops filling; bounds are on-chain; other keepers can step in. |
| "LPs will run before volatility." | Warm-up and epoch withdrawal queue. |
| "Does it really beat a passive pool?" | Here are all regimes, including where it does not. |
| "Why would aggregators route to you?" | Executed equals quoted, and the quote is checkable. |
| "Isn't your toxicity rule gameable?" | Rules are minimal; we rely mainly on spread, throttle, and expiry, and we test an adaptive attacker. |
| "Why should I trust your math?" | Each layer uses an established model (constant-product segments, Avellaneda-Stoikov, the LVR result). The depth rule comes from the LVR formula. Coefficients are tuned heuristics, shown with sensitivity analysis. On-chain integer math is tested against a high-precision reference and fuzzed. |
| "Who captures the value?" | LPs, via fees minus LVR, after a performance fee only on hedged profit. |

### 15.5 Startup framing
- **Customer:** LPs wanting professional-grade returns without running a desk; traders and aggregators wanting reliable execution; token issuers wanting deep, honest liquidity.
- **Why now:** propAMMs already handle over half of SOL/USDC volume but remain closed.
- **Wedge:** one pair (SOL/USDC), one honest metric.
- **Moat over time:** proprietary data on flow toxicity and execution quality; keeper network effects; reputation for honest execution.
- **Revenue:** performance fee on hedged alpha, management fee, integrator revenue share, white-label vaults.
- **Risks:** competition from incumbents, informational edge, regulatory attention on vault products.

### 15.6 Hackathon execution rules
- Working devnet loop, not slides.
- One headline claim, three charts.
- Lead with the number, then the mechanism.
- Admit limits before judges find them.
- Reproducible repo and a recorded backup demo.
- Submission checklist: README, one-command reproduce, architecture diagram, demo video, deck, deployed addresses, methodology doc.

## 16. Roadmap after the hackathon
Multi-pair vaults; independent security audit; bonded keeper marketplace; options/hedge overlay to strip market beta for LPs (LVR as a variance exposure); arbitrage-rights auction (authorized-participant idea) to recapture residual LVR; RFQ/batch integration; cross-venue routing; formal verification of share accounting.

## 17. Honest limits and things to verify
1. **Spoofing on Solana is unverified.** The 39% and 1.08 bps figures are from Base (Flashblocks). Measure Solana (E8) before making claims.
2. **Priority-fee penalty feasibility:** confirm whether it is clean to read from inside a Solana program via instruction introspection.
3. **Pyth access:** confirm which Pyth product (Core or Lazer) is accessible and its real latency, and how historical data can be obtained for backtests.
4. **Aggregator integration:** confirm the current Jupiter AMM-interface requirements.
5. **LVR figures** such as the 99.991% variance share come from a secondary report on the paper; check them against the original LVR paper before citing.
6. **Edge risk:** the oracle-based vault may lack the informational speed of top propAMMs. The design mitigates this but does not remove it.
7. **Backtests are not live adversaries.** State this plainly and rely on attacker bots plus devnet testing.
8. **Prior art:** re-check Lifinity and any new Solana vault designs before the demo.
9. **Coefficients are heuristics**, not proven optima. Show the sensitivity analysis.
10. **Not financial advice;** vault products may carry regulatory considerations depending on jurisdiction.
11. **Q64.64 conventions and licenses:** check Orca's and Uniswap's fixed-point conventions and the license before adapting any code.
12. **LVR rate with oracle-anchored quotes:** the sigma^2/8 result is for constant-product pools in continuous time; validate the depth rule empirically.
13. **Pro-rata deposits reduce UX flexibility:** single-sided deposits are roadmap, and a zap needs separate security review.
14. **Compute budget:** confirm that swap-time ladder walking and update-time validation fit within Solana compute limits.