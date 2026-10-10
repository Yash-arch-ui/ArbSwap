# TruQuote Build Plan and Agent Specification
### From zero to advanced: context, architecture, code flow, math, resources

*Working name. Document version 1.0. Audience: a coding agent (and the human directing it). Read Section 0 first.*

---

## Contents
0. How to use this document (rules for the coding agent)
1. Context: the problem, the evidence, the opportunity
2. Product description
3. System architecture
4. Repository layout and tech stack
5. Math specification (the core)
6. On-chain program specification
7. Keeper specification
8. Research simulator and evaluation specification
9. Analytics and dashboard specification
10. Testing and verification plan
11. Security checklist (Solana-specific)
12. Phased build plan with tasks and acceptance criteria
13. Learning path (zero to advanced) and resources
14. Decisions log, open questions, risk register
15. Definition of done and demo requirements
16. Glossary

---

## 0. How to use this document (rules for the coding agent)

**Your goal:** build TruQuote, an open vault on Solana that quotes like a professional market maker, and prove with data that it beats a passive AMM.

**Working rules**
1. **Do not invent APIs, versions, account layouts, or numbers.** Where this document says *verify*, check the official docs or source code first. If you cannot verify, write the assumption in `docs/ASSUMPTIONS.md` and ask the human.
2. **Math lives in one place.** Write the math once as a pure, well-tested module (Section 5). The program, keeper, and simulator must all use the same logic (a bit-exact port, tested against a Python reference).
3. **No floating point on-chain.** Integers only, with checked arithmetic. Floats are allowed in the simulator and analytics only.
4. **Test first for math and accounting.** Write the Python reference and golden test vectors before the Rust implementation.
5. **Security over speed.** Every instruction follows the checklist in Section 11.
6. **Small, reviewable commits.** One concern per commit. Update docs with code.
7. **Stop and ask the human** when: a decision in Section 14 is marked OPEN and blocks you; a *verify* item fails; a design change would alter the math spec; any step would handle real funds (mainnet).
8. **Never** put private keys in the repo, deploy to mainnet, or claim a result you have not measured.

**Conventions:** prices in quote tokens per base token (USDC per SOL); `bps` = 1/10,000; "base" = SOL, "quote" = USDC; "slot" is about 400 ms on Solana.

**Honesty rule for results:** report losing regimes. If a number is a design heuristic, label it as such.

---

## 1. Context

### 1.1 The problem in simple words
A normal AMM (automated market maker) only changes its price **after someone trades with it**. When SOL moves on Binance, the AMM still shows the old price for a moment. A fast trader (arbitrageur) buys the cheap SOL from the AMM and sells it elsewhere for profit. The people who deposited money in the AMM (liquidity providers, LPs) pay for this. That loss is called **LVR** (loss-versus-rebalancing). It grows with volatility and with how much liquidity the AMM offers near the current price.

### 1.2 What the research shows
| Fact | Source |
|---|---|
| Passive AMMs have negative markouts (about -0.22 bps on Solana, 2 seconds after a fill); propAMMs have positive ones (about +0.37 bps) | Solmaz, Heimbach, Milionis (2026) |
| propAMMs handle more than half of SOL/USDC volume on Solana | same |
| Updating a propAMM quote costs about 485 to 676 compute units versus 16,938 or more for a swap | same, §7.1 |
| Quiet (retail-like) trades pay about 0.26 bps on Solana propAMMs versus 2.59 bps on AMMs | same, §8 |
| One propAMM on Base executed at the quoted price only 39% of the time; the average swap got 1.08 bps worse | same, §7.4 (Base, Flashblocks) |
| LVR depends on volatility and marginal liquidity; for constant product, LVR/value is about sigma squared over 8 | Milionis, Moallemi, Roughgarden, Zhang |
| Optimal fees are approximately linear in inventory and track the external price | Baggiani, Herdegen, Sanchez-Betancourt |
| Oracle prices deviate from markets (about 57 bps average on one Chainlink sample), more in volatile times | Nadler et al. |

### 1.3 The gap
propAMMs are **closed**: one operator, private logic, and traders cannot verify execution quality. Passive AMMs are **open but lose to arbitrage**. Nobody offers **open, active, honest** liquidity.

### 1.4 Our idea (the hybrid)
TruQuote combines **AMM-style open pooled capital** with **propAMM-style active quoting**, run like a professional desk (risk limits, circuit breakers, bonded operators), with one promise: **the price you are quoted is the price you get**.

### 1.5 Closest prior art (check again before demo)
- **Lifinity:** Solana AMM that uses an oracle as its main pricing input. We differ by: measured markouts and LVR benchmarking, depth throttle derived from the LVR formula, versioned honest quotes, open bonded keepers, and a published methodology.
- **propAMMs (HumidiFi, SolFi, Tessera, BisonFi and others):** closed operator-run pools.

---

## 2. Product description

### 2.1 Who uses it
| User | What they do | What they get |
|---|---|---|
| **LP** | Deposits SOL and USDC, receives shares | Fees minus LVR, a transparent attribution report |
| **Trader / aggregator** | Swaps against the vault | Tight spread and executed price equal to quoted price |
| **Keeper** | Runs the quoting bot, posts a bond | Reward per valid update |
| **Governance** | Sets bounded parameters via timelock | Can pause, cannot seize funds |

### 2.2 What the system does (one paragraph)
LPs deposit into one vault. A keeper reads the Pyth price and computes a bid/ask ladder around a reservation price, widening the spread when volatility, oracle uncertainty, staleness, or inventory imbalance rise, and shrinking depth when risk is high. The keeper writes a small set of parameters on-chain (one cheap transaction). Traders swap against the ladder, and the program enforces bounds, quote expiry, and versioned quotes. An indexer feeds a metrics engine and dashboard that show markouts, LVR avoided, and the quote-versus-fill gap.

### 2.3 Promises (testable)
1. **Honest execution:** the executed output is at least the user's `min_out`, and the quote-versus-fill gap is reported and near zero.
2. **Bounded keeper power:** a keeper can never set a price outside on-chain bounds.
3. **Safe failure:** if the keeper or oracle fails, quotes expire and the vault stops filling.
4. **Fair accounting:** deposits and withdrawals are pro-rata and cannot be gamed by timing.

### 2.4 Non-goals (for the first version)
Multi-pair vaults, a token, cross-venue routing, single-sided deposits, an LVR auction, on-chain hedging. These are roadmap items (Section 15.3).

### 2.5 Success metrics
| Metric | Target (to be measured, not promised) |
|---|---|
| LVR versus passive pool | Lower in most regimes |
| 2s markout | Positive overall |
| Hedged return (fees minus LVR) | Higher than passive |
| Quote-versus-fill gap | About 0 bps on TruQuote |
| Quiet-flow half-spread | At or below passive pool |
| CU per update | Under about 1,000 (verify what is achievable) |

---

## 3. System architecture

```
 Pyth price (+confidence, publish time)        CEX reference (research only)
            |                                           |
            v                                           v
 +-----------------------+  update_quote   +------------------------------------+
 | KEEPER (Rust)         | --------------> | TRUQUOTE PROGRAM (Anchor)          |
 |  vol estimator        |  1 cheap tx     |  Vault, QuoteState, Config        |
 |  quote calculator     |                 |  WithdrawTicket, KeeperBond        |
 |  priority-fee sender  | <-------------- |  swap, deposit, withdraw, crank    |
 +-----------------------+  state reads    |  guards: bounds, expiry, version   |
            ^                              +------------------+-----------------+
            |                                                 | events
            |                                                 v
            |                              +------------------------------------+
            |                              | INDEXER -> DB -> METRICS ENGINE    |
            |                              | markouts, LVR, gap, attribution    |
            |                              +------------------+-----------------+
            |                                                 v
            |                              +------------------------------------+
            +------------------------------| DASHBOARD (LP, Trader, Risk, Demo) |
                                           +------------------------------------+

 SIMULATOR (Python/Rust): same pricing code -> baselines B1-B4 -> experiments E1-E10
```

### 3.1 Components
| Component | Language | Responsibility |
|---|---|---|
| `programs/truquote` | Rust (Anchor) | Custody, share accounting, swap execution, guards |
| `crates/tq-math` | Rust | Pure fixed-point math (no Solana deps), shared by program, keeper, tests |
| `keeper` | Rust | Compute quotes, send updates, handle failures |
| `research/` | Python | Reference math, simulator, backtests, charts |
| `analytics/` | Python or TypeScript | Indexer and metrics |
| `app/` | TypeScript (Next.js) | Dashboard and demo mode |
| `attackers/` | Rust or Python | Adversarial bots |

### 3.2 Trust model
- **Trusted:** the Solana runtime, the Pyth program and feed (with checks), the program code.
- **Semi-trusted:** keepers (bounded by on-chain config).
- **Untrusted:** traders, LPs, other programs, RPC nodes.
- **Admin:** timelocked parameter changes; pause-only kill switch.

### 3.3 End-to-end flow
1. Keeper reads Pyth price `P`, confidence `c`, publish time.
2. Keeper updates volatility and computes `P_res`, `s`, `depth_mult`, ladder.
3. Keeper sends `update_quote` (priority fee scaled to urgency).
4. Program validates bounds, freshness, and monotonic slot, then stores the new `QuoteState` and increments `version`, and resets the flow accumulator.
5. Trader or aggregator reads `QuoteState`, simulates, sends `swap(amount_in, min_out, quote_version_min)`.
6. Program walks the ladder, applies the deterministic fee, checks `min_out`, expiry, and caps, transfers tokens, updates the accumulator, emits an event.
7. Indexer stores the event; metrics engine computes markouts, LVR, gap.
8. Dashboard shows results; fees accrue to LP shares.

---

## 4. Repository layout and tech stack

```
truquote/
  Cargo.toml                       # workspace
  crates/tq-math/                  # pure Rust math (fixed-point, ladder, vault math)
  programs/truquote/               # Anchor program
  keeper/                          # Rust keeper binary
  research/
    reference/                     # Python high-precision reference of tq-math
    sim/                           # event-driven simulator
    data/                          # download scripts only (no raw data in git)
    notebooks/
  analytics/                       # indexer + metrics
  app/                             # Next.js dashboard
  attackers/                       # attack bots
  tests/                           # integration tests, test vectors
  docs/                            # SPEC.md, MATH.md, THREAT_MODEL.md, ASSUMPTIONS.md
```

**Stack (verify current versions before pinning):** Rust, Anchor, Solana CLI and local validator, Pyth SDK for Solana, Python 3 (numpy, pandas, mpmath or decimal, matplotlib), TypeScript, Next.js, Postgres or ClickHouse, OBS for demo recording.

**Why a separate `tq-math` crate:** it has no Solana dependency, so it is testable natively and fuzzable, and the keeper can reuse it.

---

## 5. Math specification (the core)

### 5.1 Notation
| Symbol | Meaning |
|---|---|
| `P` | oracle (reference) price, quote per base |
| `c` | oracle confidence (same units as `P`) |
| `B`, `Q` | vault base and quote reserves |
| `q` | normalized inventory imbalance in [-1, 1] |
| `P_res` | reservation price |
| `s` | half-spread (fraction) |
| `m_k` | extra offset of ladder level k (fraction) |
| `L_k` | liquidity of level k (constant-product segment) |
| `sigma` | volatility per sqrt(second) |
| `V` | vault value in quote units |

### 5.2 Fixed-point rules
- Prices as **Q64.64 square-root prices** (`sqrtP`), as used by Uniswap v3 and Orca. *Verify exact conventions and the license of Orca's open-source math before adapting any code.*
- Token amounts as `u64`; intermediates as `u128` (or wider via a library, verify).
- Basis-point parameters as `u32` (1 bps = 1/10,000).
- **Rounding:** amounts the vault pays out round **down**; amounts the vault receives round **up**. Never the reverse.
- All math is checked; overflow returns an error, never wraps.

### 5.3 Inventory and reservation price
```
q     = (B*P - Q) / (B*P + Q)            # 0 when value is balanced 50/50
P_res = P * (1 - g*q)                    # g = inventory aversion (bps per unit q)
```
Too much base (`q > 0`) lowers both quotes slightly, encouraging buyers and shedding base. Source idea: Avellaneda-Stoikov (verify the original model before citing details).

### 5.4 Volatility estimator (off-chain, keeper and simulator)
```
r_t       = ln(P_t / P_{t-1})            # per 1-second tick
var_t     = lam*var_{t-1} + (1-lam)*r_t^2
sigma_s   = sqrt(var_t)                  # short window, lam ~ 0.94 (tune)
jump_flag = 1 if |r_t| > k_j * sigma_s   # k_j ~ 4 (tune)
```
Keep a second slower estimate `sigma_m` (lam ~ 0.99). A jump starts a cool-down of `J` seconds with wider spread and lower depth.

### 5.5 Half-spread
```
s = s_floor
  + a1 * sigma_s
  + a2 * |q|
  + a3 * (c / P)
  + a4 * max(0, age - grace)
  + a5 * jump_flag
s = clamp(s, s_min, s_max)               # s_max also enforced on-chain
```
`s_floor` covers fees, gas, and a minimum edge. **All coefficients are design heuristics, tuned in the simulator.**
Support: spread widening with volatility and inventory follows the structure found in Baggiani et al. (fees linear in inventory and price move). Verify the exact result in the paper before citing details.

### 5.6 Directional add-on
```
move = (P_t - P_{t-W}) / P_{t-W}         # recent reference move over window W
ask_extra = e * max(0,  move)            # market rising: asks become stale first
bid_extra = e * max(0, -move)
```
Rationale: arbitrageurs hit the side the market is moving toward. Source idea: asymmetric dynamic fees (Alexander and Fritz).

### 5.7 Ladder construction
Per side, N levels (default N = 6) with cumulative offsets `m_k` (bps) and capacity weights `w_k`:

| Level k | 1 | 2 | 3 | 4 | 5 | 6 |
|---|---|---|---|---|---|---|
| `m_k` (bps, default) | 0 | 2 | 5 | 10 | 20 | 40 |
| `w_k` (share of side capacity) | 0.10 | 0.15 | 0.20 | 0.20 | 0.20 | 0.15 |

```
ask_lo_k = P_res * (1 + s + ask_extra + m_{k-1})   with m_0 = 0 for k = 1
ask_hi_k = P_res * (1 + s + ask_extra + m_k)
bid_hi_k = P_res * (1 - s - bid_extra - m_{k-1})
bid_lo_k = P_res * (1 - s - bid_extra - m_k)
```
(Level 1 spans from the touch price out to offset `m_1`; later levels continue outward. Keep boundaries strictly increasing; the program rejects non-monotonic ladders.)

**Side capacity (never exceeds holdings):**
```
base_cap  = depth_mult * u_max * B       # base the vault may sell across all ask levels
quote_cap = depth_mult * u_max * Q       # quote the vault may spend across all bid levels
C_k       = w_k * base_cap               # per-level base capacity on the ask side
```
`u_max` (utilization cap, default 0.5, tunable) keeps reserves in hand for withdrawals and safety.

### 5.8 Constant-product segment math (Uniswap v3 style)
For a level between prices `Pa < Pb` with liquidity `L`:
```
base amount available   dx = L * (1/sqrt(Pa) - 1/sqrt(Pb))
quote amount            dy = L * (sqrt(Pb) - sqrt(Pa))
liquidity from capacity L  = C_k / (1/sqrt(lo_k) - 1/sqrt(hi_k))      (ask side)
liquidity from capacity L  = Qcap_k / (sqrt(hi_k) - sqrt(lo_k))        (bid side)
```
**Trader buys base with `dy_in` quote (ask side), starting at price `p`:**
```
sqrt(p') = sqrt(p) + dy_in / L             # if it stays inside the level
dx_out   = L * (1/sqrt(p) - 1/sqrt(p'))
# if sqrt(p') would exceed sqrt(hi_k): fill the level fully, carry the remainder to level k+1
```
**Trader sells base with `dx_in` (bid side), starting at price `p`:**
```
1/sqrt(p') = 1/sqrt(p) + dx_in / L
dy_out     = L * (sqrt(p) - sqrt(p'))
# if sqrt(p') would fall below sqrt(lo_k): fill fully, carry the remainder to level k+1
```
Source: Uniswap v3 whitepaper (concentrated liquidity math). *Verify formulas against the whitepaper and Orca's code in tests.*

### 5.9 Flow accumulator (netting)
`n` = net base sold by the vault since the last `update_quote` (can be negative).
- Ask-side capacity consumed first by `max(n, 0)`; bid-side capacity consumed first by `max(-n, 0)`.
- A sell by the vault increases `n`; a buy decreases `n`.
- **Design decision D-04:** `n` resets to 0 on every `update_quote`, because inventory skew already moves `P_res`. (This differs from the netting described for Tessera; the choice is documented and testable.)

### 5.10 Depth throttle and the LVR budget
For a constant-product segment: base holdings `x(P) = L/sqrt(P)`, so `|x'(P)| = L / (2 P^1.5)`.
```
LVR rate  = (1/2) * sigma^2 * P^2 * |x'(P)|  =  sigma^2 * L * sqrt(P) / 4
value     V = 2 * L * sqrt(P)
LVR / V   = sigma^2 / 8
```
(`sigma` per sqrt(second); the LVR rate is per second.)

**LVR-budget cap.** Let `R` = expected fee/edge revenue per second and `g_gas` = update gas cost per second. Require revenue to cover LVR:
```
sigma^2 * L * sqrt(P) / 4  <=  R - g_gas
=>  L  <=  4 * (R - g_gas) / (sigma^2 * sqrt(P))
=>  V_active <= 8 * (R - g_gas) / sigma^2
```
Doubling volatility cuts allowed active depth to a quarter.

**Rule-based throttle:**
```
depth_rule = min(1, sigma_target / sigma_s) * max(0, 1 - c / c_max) * (1 - jump_cool_down_factor)
depth_mult = min(depth_rule, depth_budget)       # depth_budget from the LVR cap, normalized to [0,1]
```
*Caveat:* the LVR formula assumes continuous prices and no fees; with an oracle-anchored quote, realized adverse selection differs. Treat the cap as a principled upper bound and validate in the simulator. Sources: LVR paper (verify against the original).

### 5.11 Oracle checks (program and keeper)
```
reject if (now - publish_time) > max_staleness
reject if (c / P) > max_conf_ratio
reject if |P - anchor_prev| / anchor_prev > max_anchor_step   # unless breaker-approved reset
```

### 5.12 Quote age and expiry
```
age = current_slot - update_slot
age <= grace_slots           : no penalty
grace_slots < age < expiry   : extra spread  kappa * (age - grace_slots)
age >= expiry_slots          : swap fails (QuoteExpired)
```
Defaults (tunable): `grace_slots = 2`, `expiry_slots = 10`.

### 5.13 Fees
`fee = ceil(amount_in * fee_bps / 10_000)`, deterministic, retained in the vault, and split by fixed shares into: LP (accrues to reserves), insurance buffer, keeper reward pool, protocol. No code path may change `fee_bps` outside a timelocked `set_params`.

### 5.14 Vault accounting (pro-rata, v2-style)
**Decision D-05 (changes earlier plans):** deposits and withdrawals are **proportional in both tokens**, which needs no oracle price and removes a manipulation surface. Single-sided deposits are roadmap.
```
first deposit:   shares = floor(sqrt(dB * dQ)) - MIN_LIQUIDITY      # burn MIN_LIQUIDITY permanently
later deposit:   shares = min( floor(dB * S / B), floor(dQ * S / Q) )
withdraw:        out_B = floor(shares * B / S);  out_Q = floor(shares * Q / S)
```
Deposits activate after `warmup_slots`; withdrawals go through an epoch queue and settle against reserves at settlement time. Liabilities (accrued reward pools) are excluded from `B`, `Q` used for share math.
Ideas: ERC-4626 conventions (virtual offsets, rounding direction) and Uniswap v2 minimum-liquidity burn. *Verify the Uniswap v2 whitepaper details before citing.*

### 5.15 Performance fee (MVP and roadmap)
- **MVP (on-chain):** the protocol takes a fixed share of **trading fees** only. Simple, deterministic, auditable.
- **Roadmap (off-chain attribution first):** performance fee on **hedged** profit with a high-water mark; compute it in analytics, publish, and only later move on-chain.

### 5.16 Default parameter table (all tunable; bounds on-chain)
| Param | Default | On-chain bound |
|---|---|---|
| `s_floor` | 1.0 bps | min 0.5, max 50 |
| `s_max` | 50 bps | hard cap |
| `g` (inventory aversion) | 5 bps per unit q | max 50 |
| `u_max` | 0.5 | max 0.8 |
| `grace_slots` / `expiry_slots` | 2 / 10 | expiry max 25 |
| `max_staleness` | 2 s | max 5 s |
| `max_conf_ratio` | 10 bps | max 30 |
| `max_anchor_step` | 50 bps per update | hard cap |
| `fee_bps` | 1.0 | max 10 |
| `warmup_slots` | 150 (about 1 min) | max 1,500 |

---

## 6. On-chain program specification

### 6.1 Accounts (PDAs; verify seed and size conventions in Anchor docs)
**Vault** (seeds: `["vault", base_mint, quote_mint]`)
```
authority: Pubkey            base_mint, quote_mint: Pubkey
base_reserve, quote_reserve: Pubkey   (token accounts owned by the vault PDA)
share_mint: Pubkey           total_shares: u64
insurance_base, insurance_quote: u64  keeper_pool_quote: u64    protocol_quote: u64
status: u8 (0 Active, 1 Paused, 2 WindDown)    bump: u8
```
**QuoteState** (`["quote", vault]`)
```
version: u64                 update_slot: u64        expiry_slot: u64
anchor_sqrt_price: u128      p_res_sqrt: u128
half_spread_bps: u32         ask_extra_bps: u32      bid_extra_bps: u32
depth_mult_bps: u32          flow_n: i128 (net base sold)
levels: [Level; N]           oracle_publish_time: i64   oracle_conf_bps: u32
```
**Level:** `offset_bps: u32, weight_bps: u32`
**Config** (`["config", vault]`): all bounds and defaults from 5.16; `admin`, `timelock_delay`, `pending_params`, `pending_eta`
**DepositTicket** (`["dep", vault, user, id]`): `shares, activate_slot`
**WithdrawTicket** (`["wd", vault, user, id]`): `shares, epoch`
**KeeperBond** (`["keeper", vault, keeper]`): `bond, valid_updates, rejected_updates, slashed`

### 6.2 Instructions
| Instruction | Signer | Purpose |
|---|---|---|
| `initialize_vault` | admin | create accounts, set config, mint authority |
| `deposit(dB, dQ, min_shares)` | LP | proportional deposit; shares inactive until warm-up |
| `request_withdraw(shares)` | LP | queue for next epoch |
| `claim_withdraw(id)` | LP | after the epoch, receive pro-rata tokens |
| `update_quote(params)` | keeper | validate and store a new quote |
| `swap(side, amount_in, min_out, min_version)` | trader | walk the ladder and settle |
| `crank_epoch` | anyone | advance epoch, settle queue accounting |
| `trip_breaker` | anyone | pause if stale oracle, wide confidence, or volatility flag provable on-chain |
| `reset_breaker` | admin | resume after cool-down |
| `bond_keeper` / `claim_reward` / `slash_keeper` | keeper / program | bonded participation |
| `set_params` | admin (timelocked) | change bounded parameters |

### 6.3 `update_quote` flow (pseudocode)
```
require status == Active
require keeper bonded (or allowlist in MVP)
read pyth price account: require feed_id, owner program, fresh, conf ratio ok
require new.update_slot == current_slot and > old.update_slot      # monotonic, same-slot
require |anchor_new - anchor_old| / anchor_old <= config.max_anchor_step
require s_min <= half_spread <= s_max ; extras <= caps ; depth_mult <= 10_000
require ladder offsets strictly increasing, weights sum to 10_000
require |anchor_new - oracle_price| <= config.max_anchor_oracle_dev
store state; version += 1; flow_n = 0; expiry_slot = slot + expiry_slots
emit QuoteUpdated{version, anchor, spread, depth, slot}
```
**Important:** the program also checks the keeper's quote against what `tq-math` would compute from the oracle and vault state within tolerance (verify feasibility given compute limits). If too expensive on-chain, enforce bounds and consistency checks only.

### 6.4 `swap` flow (pseudocode)
```
require status == Active
require state.version >= min_version
age = slot - state.update_slot ; require age < expiry_slots
fee = ceil(amount_in * fee_bps / 10_000) ; net_in = amount_in - fee
(out, new_n, levels_consumed) = tq_math::walk_ladder(state, side, net_in)
extra spread from age applied inside walk_ladder
require out >= min_out                       # the honesty guarantee
require out <= side_capacity_remaining and inventory caps hold
transfer net_in+fee in, out out ; split fee by fixed shares
state.flow_n = new_n
emit Swap{side, amount_in, out, version, slot, pre_state_hash, price_avg}
```
A swap that fails costs the trader only the transaction fee.

### 6.5 Events (for the indexer)
`QuoteUpdated`, `Swap`, `Deposit`, `WithdrawRequested`, `WithdrawClaimed`, `BreakerTripped`, `BreakerReset`, `KeeperSlashed`, `ParamsChanged`. Include slot and version in every event.

### 6.6 Errors
`StaleOracle, WideConfidence, AnchorStepTooLarge, SpreadOutOfBounds, LadderInvalid, QuoteExpired, VersionTooOld, SlippageExceeded, CapacityExceeded, InventoryCapExceeded, Paused, NotBonded, WarmupNotElapsed, EpochNotReached, MathOverflow`.

---

## 7. Keeper specification

### 7.1 Loop
```
loop every tick (target <= 400 ms; prefer streaming prices):
  price = pyth.latest()          ; if stale or wide confidence: skip and let quote expire
  update vol estimators (5.4)
  state = read QuoteState, Vault
  q = inventory(state)
  new_quote = tq_math::compute_quote(price, vol, q, age, params)
  if should_update(new_quote, state):    # |move| > threshold bps, or age > T, or regime change
       priority_fee = f(urgency)         # cheap when calm, higher after a jump
       send update_quote tx with compute-budget limit set tightly
  log metrics (latency, price delay, CU, success)
```
`should_update` default: price moved more than 0.5 bps since last quote, or 10 slots passed, or jump flag changed.

### 7.2 Failure handling
- RPC error: retry with backoff; if no successful update by `expiry`, the quote expires (safe).
- Oracle stale: skip updates (safe).
- Landed late: the program rejects non-monotonic slots.
- Multiple keepers: the first valid update per slot wins; duplicates are rejected cheaply.

### 7.3 Compute budget
Set an explicit compute-unit limit per transaction slightly above measured usage (lower-CU transactions are favored by the scheduler, per the HumidiFi analysis; verify the current scheduling behavior). Record CU per update as a metric.

---

## 8. Research simulator and evaluation specification

### 8.1 Simulator modules
1. **Price source:** replay 1-second reference prices (CEX), optionally synthetic scenarios (calm, trend, crash, jump).
2. **Oracle model:** `P_oracle(t) = P_ref(t - latency) + noise`, with a confidence value; latency scenarios from 50 ms to 1 s (Pyth update frequency options are documented in the Pyth Lazer announcement; verify).
3. **Slot clock:** 400 ms slots; keeper updates land with a delay distribution.
4. **Flow model:**
   - *Informed:* an arbitrageur trades whenever the mispricing exceeds fee plus gas, sized to equalize marginal price with fair value.
   - *Noise:* Poisson arrivals, lognormal sizes, random sides, with configurable intensity.
   - *Adversarial:* optional bots from `attackers/`.
5. **Venues:** passive constant-product pool (fee configurable), fixed-spread vault, TruQuote.
6. **Frictions:** gas and priority fees per update and swap; slippage.

### 8.2 Baselines
| ID | Baseline |
|---|---|
| B1 | Passive constant-product pool (run at several fee levels) |
| B2 | Same vault, fixed spread, no engine |
| B3 | TruQuote without depth throttle |
| B4 | TruQuote without honest-execution rules (to show the gap metric works) |

### 8.3 Metric definitions
- **Microprice:** `(bid * q_ask + ask * q_bid) / (q_bid + q_ask)` from top of book (as in Solmaz et al., Appendix A.3).
- **Markout (bps) at horizon tau:** `1e4 * d * (m(t+tau) - p_exec) / p_exec`, where `d = +1` if the vault bought base and `-1` if it sold; positive means the vault gained. Report notional-weighted means for tau from -5 to +15 seconds and at 2 seconds.
- **Quiet flow:** fill where `|m(t+1s) - m(t-5s)| / m < 1 bps`. Others are "moving".
- **Retail half-spread:** notional-weighted `1e4 * |p_exec - m(t)| / m(t)` on quiet fills.
- **Hedged PnL (net microstructural alpha):** `sum_t [ V_{t+1} - V_t - B_t * (P_{t+1} - P_t) ]`, i.e., value change minus the delta-hedge gain on the vault's actual base holdings. Compare TruQuote versus passive pool with equal capital. Source idea: the LVR decomposition, LP PnL = market exposure + fees - LVR (verify in the original paper).
- **LVR (passive benchmark):** realized arbitrage profit against the pool, or the discrete form of `(sigma^2/4) * L * sqrt(P) * dt`.
- **Quote-versus-fill gap (bps):** `1e4 * (out_quoted - out_executed) / out_quoted`, where `out_quoted` is the output the state at the end of the previous slot implies for the same input. Report mean, volume-weighted mean, share identical, and tail.
- **CU per update and per swap.**

### 8.4 Experiments
| ID | Question | Output |
|---|---|---|
| E1 | LVR reduction versus B1 | % by regime |
| E2 | Markouts positive? | full curve and 2s value |
| E3 | Hedged return | TruQuote vs B1, B2 |
| E4 | Retail quality | quiet-flow half-spread |
| E5 | Depth throttle value | B3 ablation |
| E6 | Cost of honesty | B4 comparison |
| E7 | Safety | stale feed, bad tick, sandwich, phantom liquidity, keeper down |
| E8 | Real-pool quote gap on Solana | measured gap for 2 to 3 existing venues (verify data access) |
| E9 | Sensitivity | fees, volatility, latency, parameters |
| E10 | Solana cost | CU and update cadence versus PnL |

### 8.5 Methodology rules
- **Walk-forward calibration:** tune on earlier months, test on later; freeze parameters before test.
- Regimes (calm, trending, crash) chosen in advance.
- Gas, fees, and slippage included. Report gross and net.
- Seeds and confidence intervals. Show losing regimes.
- Never headline raw LP PnL or impermanent loss.

### 8.6 Data sources (verify access)
Top-of-book 1-second data from a major CEX (the paper used Bybit's public order-book archive); Pyth historical prices; optional on-chain Solana swap data for E8.

---

## 9. Analytics and dashboard specification

### 9.1 Indexer
Subscribe to program logs, parse events (6.5), store in a database with slot and timestamp. Reconcile with account state periodically.

### 9.2 Views
- **LP view:** shares, share value, fees earned, attribution (fees, LVR avoided, inventory PnL, gas), risk status.
- **Trader view:** current ladder, depth, quote age, quote-versus-fill gauge.
- **Risk view:** inventory band, oracle age and confidence, breaker state, keeper health.
- **Comparison view:** TruQuote versus passive pool charts (LVR, markouts, hedged return).
- **Demo mode:** split-screen replay (passive pool left, TruQuote right) with scenario selector (calm, trend, crash) and attack buttons (freeze oracle, kill keeper, launch attacker bot). Replays are deterministic and cached so the demo never depends on live markets.

---

## 10. Testing and verification plan

| Layer | Tests |
|---|---|
| Math reference | Python (high precision) is the source of truth; generate golden vectors (inputs, outputs, rounding) |
| `tq-math` | Unit tests vs vectors; property tests (monotonic price, no value created, round-trip loses to fees only); fuzzing |
| Program | Local validator tests for every instruction, including failure paths |
| Invariants | `B*P + Q` accounting never increases without fees; shares and reserves consistent; capacity never exceeds holdings; rounding favors the vault |
| Differential | On-chain output equals reference within 1 unit of the smallest token atom |
| Keeper | Replay mode produces the same quotes as the simulator |
| Adversarial | `attackers/` bots (E7) |
| Load | Update spam, swap spam, CU limits |

**Core invariants to encode as tests**
1. For any swap, `out >= min_out` or the swap reverts.
2. Selling then buying the same size never yields more than the starting amount (no free money), up to rounding.
3. Total value of reserves plus liabilities is conserved except for fees and explicit transfers.
4. A quote with `age >= expiry_slots` always rejects swaps.
5. A keeper update outside bounds always rejects.
6. First-depositor and donation attacks cannot steal funds.

---

## 11. Security checklist (Solana-specific)

Every instruction must be reviewed against this list (verify details in Anchor and Solana security docs):
- Signer checks on every authority; no missing `Signer`.
- **Owner and address checks** on every account, including the Pyth account (correct program, correct feed id).
- PDA seeds and canonical bump verified; no attacker-supplied PDAs.
- Token accounts: correct mint, correct owner, correct token program; **reject Token-2022 extensions** that change transfer behavior (transfer fees, hooks) unless explicitly supported.
- No account reinitialization; closed accounts zeroed and rent returned safely.
- Duplicate mutable account attacks considered.
- CPI target program IDs hard-coded and checked.
- Arithmetic checked; casts reviewed.
- No unchecked `remaining_accounts` use.
- Events cannot be forged to mislead the indexer (index from validated logs and reconcile with state).
- Admin powers limited: timelock, pause-only kill switch, no fund seizure.
- Keeper bounds enforced on-chain (the program does not trust the keeper).

**Threat table:** see `docs/THREAT_MODEL.md` (stale oracle, manipulated print, faster CEX feed, sandwiching, keeper compromise, share inflation, deposit/withdraw timing games, account confusion, rounding leakage, griefing, governance abuse, adaptive toxic flow). Each threat must name a mitigation and a test.

---

## 12. Phased build plan with tasks and acceptance criteria

*Durations are suggestions; gates are mandatory.*

### P0: Foundations (week 0 to 1)
- T0.1 Read priority sources (Section 13); write one paragraph answering each study question.
- T0.2 Create the repo and workspace; CI that runs `cargo test` and Python tests.
- T0.3 Write `docs/ASSUMPTIONS.md` and resolve every *verify* item in this document.
- T0.4 Confirm data access (reference prices, Pyth historical).
**Gate:** assumptions resolved or escalated; CI green.

### P1: Math and simulator (weeks 1 to 3)
- T1.1 Python reference implementation of Section 5 (ladder, swap walk, spread, throttle, vault math).
- T1.2 Golden test vectors (at least 500 cases covering edge cases and rounding).
- T1.3 Rust `tq-math` matching the vectors.
- T1.4 Simulator with B1, B2, TruQuote; metrics from 8.3.
- T1.5 Calibration scripts (walk-forward).
- T1.6 First results for E1 to E4.
**Gate:** `tq-math` passes all vectors; TruQuote results reported honestly in at least calm, trend, and crash regimes (even if it loses in some).

### P2: On-chain program (weeks 3 to 6)
- T2.1 Anchor skeleton: accounts, config, errors, events.
- T2.2 `deposit`, `request_withdraw`, `claim_withdraw`, `crank_epoch` with warm-up and queue.
- T2.3 `update_quote` with all guards.
- T2.4 `swap` using `tq-math`; fee split.
- T2.5 Breakers, pause, timelocked `set_params`.
- T2.6 Local validator tests; invariant tests; devnet deploy.
**Gate:** full deposit, update, swap, withdraw loop on devnet; all invariants pass.

### P3: Keeper (weeks 5 to 7)
- T3.1 Pyth streaming client; vol estimators; quote calculator via `tq-math`.
- T3.2 Sender with adaptive priority fee, tight CU limit, retries.
- T3.3 Replay mode (feeds recorded prices; outputs identical to simulator).
- T3.4 Keeper bond and reward flow.
**Gate:** keeper-driven quotes on devnet match the simulator within tolerance; keeper-down test shows safe expiry.

### P4: Analytics, fees, dashboard (weeks 6 to 9)
- T4.1 Indexer and database.
- T4.2 Metrics engine (markouts, quiet flow, hedged PnL, gap, attribution).
- T4.3 Dashboard views and **demo mode** (Section 9.2).
- T4.4 Reproduce E1 to E4 charts from indexed data.
**Gate:** dashboard reproduces the simulator charts on replayed data.

### P5: Hardening and adversarial testing (weeks 8 to 11)
- T5.1 Attacker bots; run E7.
- T5.2 Fuzzing and property tests; fix findings.
- T5.3 Security checklist pass; threat model finalized.
- T5.4 Aggregator adapter (verify Jupiter's AMM interface requirements).
- T5.5 E8: measure real-pool quote gaps on Solana; E9 sensitivity; E10 cost.
**Gate:** every E7 attack fails or is contained and documented.

### P6: Story and submission (weeks 11 to 12)
- T6.1 README with one-command reproduction of the headline chart.
- T6.2 Methodology doc; results with limits.
- T6.3 Demo video (3 minutes) and live demo script; backup recording.
- T6.4 Pitch deck.
**Gate:** a stranger can reproduce the headline chart from the README.

---

## 13. Learning path (zero to advanced) and resources

### Level 0: Basics (1 to 2 days)
Learn: what a token swap, order book, spread, market maker, and LP are. Check: explain why an AMM loses when the outside price moves.

### Level 1: AMM math (2 to 3 days)
Learn constant product `x*y=k`, price impact, fees, concentrated liquidity.
- Uniswap v3 whitepaper: https://app.uniswap.org/whitepaper-v3.pdf
- Uniswap v2 whitepaper: https://app.uniswap.org/whitepaper.pdf (verify link)
- Orca Whirlpools source (for Solana fixed-point math): https://github.com/orca-so/whirlpools (verify license)
Check: derive `dx = L*(1/sqrt(Pa) - 1/sqrt(Pb))`.

### Level 2: LVR and market making (3 to 5 days)
- Milionis et al., Loss-Versus-Rebalancing: https://arxiv.org/abs/2208.06046
- Baggiani et al., Optimal Dynamic Fees: https://arxiv.org/abs/2506.02869
- Alexander and Fritz, Fees in AMMs: https://arxiv.org/abs/2406.12417
- ZeroSwap: https://arxiv.org/abs/2310.09413 ; Adaptive Curves: https://arxiv.org/abs/2406.13794
- Avellaneda and Stoikov (2008) and Glosten and Milgrom (1985): search by title (links not verified)
Check: why does LVR scale with volatility and with liquidity? Why does `LVR/V = sigma^2/8` for constant product?

### Level 3: propAMMs and execution quality (2 to 3 days)
- Solmaz, Heimbach, Milionis, propAMMs: https://arxiv.org/abs/2609.38056 (read §2, §6 to 8, App. C.3, App. G)
- 0x, PropAMM Shenanigans: https://0x.org/post/propamm-shenanigans
- Allium/Praxial summary: https://www.allium.so/blog/praxial-and-allium-why-prop-amms-stay-a-solana-story-2/
- HumidiFi overview: https://solanacompass.com/learn/Lightspeed/how-humidifi-became-solanas-largest-prop-amm
- Ethresear.ch discussion: https://ethresear.ch/t/proprietary-amms-and-ethereum/25543
Check: define markout, quiet flow, and quote-versus-fill gap in your own words.

### Level 4: Solana and Anchor (1 to 2 weeks)
- Solana docs: https://solana.com/docs (accounts, PDAs, CPI, compute units)
- Anchor docs: https://www.anchor-lang.com/ (verify)
- Pyth docs: https://docs.pyth.network/ (verify); Pyth Lazer announcement: https://www.pyth.network/blog/introducing-pyth-lazer-launching-defi-into-real-time
- Token program and Token-2022 documentation (verify extension risks)
- Jupiter AMM interface (for routing): https://github.com/jup-ag/jupiter-amm-interface (verify)
Check: build and test a toy Anchor program that holds tokens in a PDA vault.

### Level 5: Oracles, MEV, and research method (ongoing)
- Nadler et al., oracle accuracy: https://doi.org/10.1016/j.jcorpfin.2025.102908
- Sadeghi and Feinstein, liquidation dynamics (MEV background only): https://arxiv.org/abs/2602.12104
- Vault accounting: ERC-4626 standard https://eips.ethereum.org/EIPS/eip-4626 (verify)
Check: list three ways an oracle-based vault can be attacked and the mitigation for each.

**Reading priority if time is short:** Solmaz et al., LVR, Baggiani, 0x report, Uniswap v3 whitepaper.

---

## 14. Decisions log, open questions, risk register

### 14.1 Decisions
| ID | Decision | Rationale | Status |
|---|---|---|---|
| D-01 | Anchor-relative ladder of constant-product segments | Cheap repricing; established formulas; direct LVR link | Decided |
| D-02 | Q64.64 sqrt prices, u128 intermediates | Matches Uniswap v3 and Orca conventions | Decided (verify details) |
| D-03 | Quote computed off-chain, validated on-chain with bounds | Keeps compute low; keeper cannot exceed bounds | Decided |
| D-04 | Flow accumulator resets on each update | Simplicity; skew already moves P_res | Decided (testable) |
| D-05 | Pro-rata two-token deposits; no oracle in share math | Removes manipulation surface | Decided (changes earlier plan) |
| D-06 | MVP performance fee = share of trading fees | On-chain simple; hedged-profit fee in analytics first | Decided |
| D-07 | Keeper allowlist in MVP, bonded open network in P3/P5 | Reduce early risk | OPEN: confirm timing |
| D-08 | Whether to read priority fee on-chain for a flow penalty | Needs instruction introspection | OPEN: verify feasibility; fallback is no penalty |
| D-09 | Pyth product (Core or Lazer) | Depends on access and latency | OPEN |

### 14.2 Open questions (resolve in P0)
1. Which Pyth product and update rate can we access on devnet and mainnet-beta, and how do we get historical data?
2. Can the program cheaply recompute the quote to validate the keeper (compute budget), or only enforce bounds?
3. Does a comparable quote-versus-fill gap exist on Solana venues (E8)? The 39% figure is from Base.
4. Current Jupiter AMM-interface requirements and listing process.
5. Token-2022 and mint authority policy for the share mint.
6. Legal and regulatory considerations for vault products (human decision).

### 14.3 Risk register
| Risk | Impact | Mitigation |
|---|---|---|
| Pyth lags top CEX feeds | Picked off | Widen on staleness and confidence, throttle depth, expire quotes |
| Heuristic coefficients overfit | Fragile results | Walk-forward, sensitivity analysis |
| Backtest is not a live adversary | Overstated safety | Attacker bots, devnet tests, stated limits |
| Complexity too high | Missed deadline | Strict gates; math and program first, extras later |
| Prior art overlap | Novelty challenged | Clear comparison table; measured claims |
| Math bug in fixed-point code | Fund loss | Reference model, vectors, fuzzing, invariants |

---

## 15. Definition of done and demo requirements

### 15.1 Done means
- Devnet deployment with the full loop working and a keeper running.
- All invariants and golden-vector tests green; fuzzing run with no open findings.
- E1 to E10 results produced from the repo with one command; limits stated.
- Dashboard with demo mode (split-screen replay and attack buttons).
- Threat model and assumptions documented; open questions closed or listed.

### 15.2 Demo requirements
- 3-minute video and 5-minute live script (replay, markouts, quote-versus-fill gauge, one attack, professional-vault slide).
- A deterministic cached replay so the demo never depends on live markets.
- A backup recording and an offline fallback.

### 15.3 Roadmap (after the first version)
Single-sided deposits with a zap; multi-pair vaults; bonded keeper marketplace; hedged-profit performance fee on-chain; arbitrage-rights auction to recapture residual LVR; options overlay to hedge LVR; RFQ and batch integration; external security audit; formal verification of share accounting.

---

## 16. Glossary
- **AMM:** automated market maker; a smart contract that sets prices by a formula over pooled tokens.
- **propAMM:** proprietary AMM; an on-chain pool whose prices are set by one operator who updates quotes without trades.
- **LP:** liquidity provider; deposits tokens into a pool.
- **LVR:** loss-versus-rebalancing; the loss an AMM suffers because arbitrageurs trade against stale prices.
- **Markout:** profit or loss of a fill measured against the market price some seconds later.
- **bps:** basis point, 1/100 of 1 percent.
- **Spread:** gap between the buy and sell price; half-spread is one side of it.
- **Inventory:** how much base versus quote the vault holds.
- **Reservation price:** the vault's own fair price, shifted by inventory.
- **Ladder:** a set of price levels with sizes on each side of the market.
- **Slot:** about 400 ms unit of Solana time.
- **CU:** compute unit; Solana's measure of transaction computation.
- **PDA:** program-derived address; an account address controlled by a program.
- **Pyth:** oracle network that publishes prices and a confidence interval on Solana.
- **Keeper:** an off-chain bot that sends quote updates.
- **NAV:** net asset value; total value of the vault's holdings.
- **Warm-up:** delay before new deposits count.
- **Quote-versus-fill gap:** how much worse the executed price is than the quoted price.
- **Quiet flow:** trades that arrive when the reference price is not moving (a retail proxy).
- **Hedged PnL:** vault value change after removing market exposure.
