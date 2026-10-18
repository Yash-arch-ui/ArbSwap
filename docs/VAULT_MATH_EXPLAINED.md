# ArbSwap Vault Mathematics — From Basics to Advanced

A single, self-contained explanation of how the ArbSwap vault works
mathematically: how LP shares are issued, how both tokens are held and
accounted for, how the pricing engine is built, how LVR is attacked, how
circuit breakers and guardrails work, and how this differs from a traditional
constant-product AMM and from a proprietary (prop) AMM.

> **Provenance / honesty note.** This document is a synthesis of the repository's
> own sources of truth: `MATH.md`, `docs/FORMULA.md`, `docs/ARCHITECTURE.md`,
> `docs/THREAT_MODEL.md`, `docs/METHODOLOGY.md`, `docs/CLAIMS.md`,
> `vault/math/src/` and `vault/program/src/lib.rs`. Where a number or rule is a
> **calibrated heuristic** rather than a theorem, it is labelled as such. Claims
> about live performance are deliberately conservative: the repo's own claims
> ledger (`docs/CLAIMS.md`) marks the LVR-reduction headline as
> **SIMULATION ONLY — UNPROVEN**, and ArbSwap is explicitly *not* claimed to beat
> sub-basis-point propAMMs on raw price.

---

## Part 0 — Notation, units, and fixed-point arithmetic

Prices are **quote tokens per base token** (USDC per SOL). All on-chain math is
integer fixed-point; there is no floating point anywhere in the money path.

| Symbol | Meaning | Units |
|---|---|---|
| `P` | external / oracle price, quote per base | USDC/SOL |
| `B`, `Q` | base and quote reserves | token atoms |
| `q` | normalized inventory imbalance | `[-1, 1]` |
| `P_res` | inventory-adjusted reservation price | USDC/SOL |
| `s` | half-spread | fraction (`1 bps = 1e-4`) |
| `c` | oracle confidence interval | price units |
| `σ` | volatility | per √second |
| `L` | constant-product *segment* liquidity | model units |
| `V` | active liquidity value | quote units |
| `n` | net base sold by the vault since last re-quote | base units |

**Fixed point (Q64.64).** `x_q64 = floor(x · 2^64)`, recovered as
`x ≈ x_q64 / 2^64`. Core operations (`MATH.md` §1):

```text
mul_q64(a,b)  = floor(a·b / 2^64)
div_q64(a,b)  = floor(a·2^64 / b)
recip_q64(s)  = floor(2^128 / s)
price(sqrtP)  = floor(sqrtP² / 2^64)
sqrt_q64(v)   = floor(sqrt(v · 2^64))          # 192-bit radicand
```

Rounding conventions are asymmetric **on purpose** and are a security property:
- amounts the **vault pays out round down** (the LP can never be short-changed upward),
- amounts the **vault receives round up**,
- signed division truncates toward zero (`tdiv`).

The exact 192-bit square root and widened (`u256`) multiplication live in
`vault/math/src/{fixed,wide}.rs`; the Python reference is
`simulation/reference/fixed.py`. They are checked against **970 golden vectors**
(`vault/math/tests/golden.rs`), bit-for-bit.

---

## Part 1 — The economic problem: what LVR is and why passive AMMs bleed

A passive constant-product AMM (Uniswap v2 style) holds the invariant `x·y = k`.
Its price is a deterministic function of its own reserves, so **arbitrageurs, not
the pool, decide the price**: whenever the external market moves, they trade
against the stale curve and extract value from LPs before the curve catches up.
This leakage is **Loss-Versus-Rebalancing (LVR)** — the amount an LP loses by
holding a mechanically-rebalanced portfolio instead of the arbitrageur's optimal
hedge.

The continuous-time result (Milionis, Moallemi, Roughgarden, Zhang,
*Automated Market Making and Loss-Versus-Rebalancing*, arXiv:2208.06046) is:

```text
LVR_rate / V = σ² / 8        (constant-product specialisation)
```

i.e. **LVR grows quadratically with volatility** and is proportional to active
liquidity value `V`. A passive pool exposed at full `V` during a σ spike bleeds
`σ²/8` per unit of value per unit time, no matter what.

The three ways to fight this are the three families of AMM math:

1. **Traditional (passive) AMM** — reduce fees/liquidity, but you cannot price
   risk; you only shrink `V`.
2. **Prop AMM (RFQ / oracle)** — quote a very tight spread and *reprice fast*,
   accepting that flow is winner-taken if you are slow.
3. **ArbSwap** — *oracle-anchored, inventory-aware, volatility-responsive
   vault*: keep a deterministic invariant for execution (so fills are exact and
   verifiable on-chain) but move the **anchor and depth** with the oracle,
   volatility, inventory, confidence, and staleness.

---

## Part 2 — The three math paradigms, side by side

| Dimension | Traditional AMM (v2 CPMM) | Concentrated liquidity (v3 style) | Prop AMM (RFQ/oracle) | **ArbSwap vault** |
|---|---|---|---|---|
| Price source | own reserves (`x·y=k`) | own reserves + chosen range | off-chain oracle / market | **Pyth oracle anchor** + bounded skew |
| Who sets price | arbitrageurs | arbitrageurs (within range) | the maker | deterministic function of oracle+state |
| Inventory risk | full, unpriced | range-dependent | actively managed | **priced into `P_res`** (inventory skew) |
| Volatility response | none | none | maker's discretion | **σ-scaled spread + depth throttle** |
| Spread | fixed fee | fixed fee + range | very tight (0.3–2 bps) | dynamic floor + σ/conf/age/jump terms, **min 2 bps** |
| Depth | all reserves | chosen liquidity | maker discretion | capacity ≤ `utilization_max` (≤ 0.8) × **available** reserves |
| LP accounting | 2-token pro-rata | NFT positions | often no LPs | **2-token pro-rata shares** (ERC-4626-ish) |
| On-chain verifiable | yes | yes | usually not fully | **yes**, program reconciles keeper quote |
| Failure mode | bleeds at full depth | bleeds in range | you lose to faster flow | **quote expires → fail-closed stop**, never a bad fill |

The key architectural difference: **ArbSwap is a vault (pooled LPs) that quotes
like a maker, but its quotes are validated and executed on-chain**, so it gets
prop-AMM *responsiveness* without prop-AMM *opaqueness*.

---

## Part 3 — LP share mathematics: how both tokens are held and split

The vault holds **two token accounts** (base = WSOL, quote = USDC). Shares are
fungible and pro-rata over the *available* reserves — i.e. reserves **minus the
tracked liability buckets** (insurance, keeper, protocol). This is critical: LP
claims never extend to fee liabilities reserved for other parties.

### 3.1 First deposit (initialize liquidity)

```text
root   = floor(sqrt(dB · dQ))
shares = root − MIN_LIQUIDITY
total  = root
```

- `MIN_LIQUIDITY` is **permanently burned** to the vault — the Uniswap v2
  anti-first-depositor mechanism (there is **no oracle** in share math; decision
  D-05).
- The geometric-mean root makes the initial price implicit and manipulation
  resistant: a donation attacker can steal at most rounding
  (`first_depositor_inflation_loses_at_most_rounding`).

### 3.2 Proportional deposit (later LPs)

Deposits must be **balanced to the current composition**; the vault mints the
more conservative of the two sides:

```text
shares = min( floor(dB · S / B_available), floor(dQ · S / Q_available) )
```

Only what the minted shares are worth is pulled (`F-10` fix). Excess is not
silently taken.

### 3.3 Withdrawal (epoch-queued, pro-rata)

```text
request_withdraw(shares)         → ticket, epoch
crank_epoch()                    → closes epoch after warmup
claim_withdraw(ticket)           → out_B = floor(shares · B_available / S)
                                    out_Q = floor(shares · Q_available / S)
```

- **All payouts round down** (vault-favouring).
- Withdrawals are queued by epoch after a **warm-up** window so fresh deposits
  cannot front-run the fee/insurance accounting.
- An epoch-closure (`crank_epoch`) and the ticket make the process
  deterministic and MEV-resistant.

### 3.4 Single-sided entry/exit (zap)

A user may enter/exit with **one token**. The vault converts the unwanted leg
**against its own committed ladder** and prices shares at the post-swap
composition:

```text
SellBase (base in):  out = walk_ladder(ask, s_net)
                     B' = B_net + s_net ;  Q' = Q_net − out
                     dB = amount_in − s ;  dq = out
                     shares = min(floor(dB·S/B'), floor(dq·S/Q'))
```

`s` is the integer root of `floor(dB·S/B') = floor(dq·S/Q')`, found by bounded
bisection (≤64 steps), with neighbours compared to pick the larger `min`. Only
`amount_in` is pulled; the fee stays in the reserve. Single-sided claims pay
`payout = base_out + walk_ladder(ask, quote_out − fee)` (or the mirror), and
revert with `CapacityExceeded` if the ladder cannot absorb the leg — leaving the
ticket intact so the user can fall back to two-sided `claim_withdraw`.

### 3.5 Fee buckets (how fees are held and distributed)

```text
fee       = ceil(amount_in · fee_bps / 10,000)
insurance = floor(fee · insurance_bps / 10,000)
keeper    = floor(fee · keeper_bps    / 10,000)
protocol  = floor(fee · protocol_bps  / 10,000)
LP_share  = fee − insurance − keeper − protocol
```

The fee is retained **in the reserves**; the three buckets are tracked as
liabilities and **excluded from share value**, so LPs only ever own the residual
(`B_available`, `Q_available`). Fee rates and bucket shares change only through a
**timelocked** `set_params` → `apply_params` path (admin cannot flip fees inside
a slot).

### 3.6 Invariants (share accounting)

- `shares / reserves` stay proportional across withdrawals.
- `sell_then_buy_same_size_never_creates_value`.
- Liability buckets are excluded from LP share value.
- Checked arithmetic never wraps.

---

## Part 4 — The pricing engine mathematics

The keeper (off-chain, Rust `vault/keeper/src/lib.rs`) computes a quote from
oracle + vault state; the program (on-chain) **validates and stores** it, then
executes fills deterministically. The math chain:

### 4.1 Inventory imbalance `q`

```text
q = (B·P − Q) / (B·P + Q)          ∈ [−1, 1]
```

`q > 0` ⇒ the vault is long base. The base reserve is valued in **quote atoms**
via the raw-unit price `P_raw = P · 10^(d_q − d_b)` (decimal-scale applied
**once**, `S2.3` fix).

### 4.2 Reservation price `P_res` (inventory skew)

```text
P_res = P · (1 − g·q)
```

This is the finite, bounded realisation of the Avellaneda–Stoikov
reservation-price skew `r(s,t) = s − q·γ·σ²·(T−t)`. When the vault is long base
(`q>0`), `P_res` drops so both quotes encourage base sales and discourage more
buying — **inventory risk is priced, not ignored**. (`g` is a calibrated
coefficient, a heuristic.)

### 4.3 Volatility and jumps

```text
r_t       = |P_t − P_(t−1)| / P_(t−1)          (absolute simple return, Q64.64)
n         = max(1, round(dt_millis / 1000))     (time normalisation, capped)
variance  = λⁿ·v_old + (1 − λⁿ)·(r_t² / n)
σ         = sqrt(variance)
jump_flag = (σ > 0) && (r_t > k_j · σ)
```

Two EMAs are maintained (fast `λ≈0.94`, medium `λ≈0.99`). This is
**time-normalised**, so the estimate is clock-invariant — the same math runs
off-chain in the keeper and on-chain in `observe_volatility` (spec:
`docs/VOLATILITY_MATH_SPEC.md`, code: `vault/math/src/volatility.rs`, program
`vault/program/src/lib.rs::observe_volatility`). The **volatility kill-switch**
stops quoting when `σ > max_sigma`.

### 4.4 Half-spread `s` (the price of risk)

```text
s_raw = s_floor
      + a1·σ                     # fast price movement
      + a2·|q|                   # symmetric inventory widening
      + a3·(c/P)                 # oracle confidence (uncertainty)
      + a4·max(0, age − grace)   # staleness penalty
      + a5·jump_flag             # jump protection
s = clamp(s_raw, s_min, s_max)
```

- `s_floor` covers fees, gas, and operating risk.
- On-chain floor: `min_spread_bps` (protocol default **2 bps**, matching the
  frozen simulator `spread_floor = 0.0002`), ceiling `max_spread_bps`, plus an
  optional per-update `max_spread_step_bps` (§7.3) limiting how fast a keeper may
  move the book.

### 4.5 Directional add-on (toxic-flow asymmetry)

```text
move      = (P_t − P_(t−W)) / P_(t−W)
ask_extra = e · max(0, move)      # market rising → ask is the stale side
bid_extra = e · max(0, −move)     # market falling → bid is the stale side
```

Motivated by directional-fee research (Alexander & Fritz, arXiv:2406.12417). `e`
is a calibrated heuristic.

### 4.6 Ladder construction (two-sided, six levels)

Cumulative offsets `m_k` in bps, weights `w_k`:

```text
ask_lo_k = P_res·(1 + s + ask_extra + m_(k−1)/10⁴)
ask_hi_k = P_res·(1 + s + ask_extra + m_k    /10⁴)
bid_hi_k = P_res·(1 − s − bid_extra − m_(k−1)/10⁴)
bid_lo_k = P_res·(1 − s − bid_extra − m_k    /10⁴)

offsets = [2, 5, 10, 20, 40, 80] bps
weights = [1000, 1500, 2000, 2000, 2000, 1500] bps   (Σ = 10,000)
```

Capacity per side is bounded by *available* reserves:

```text
base_cap  = depth_mult · utilization_max · B_available
quote_cap = depth_mult · utilization_max · Q_available
C_ask,k   = w_k · base_cap  / 10⁴
C_bid,k   = w_k · quote_cap / 10⁴
```

`utilization_max_bps` is a timelocked `Config` bound **capped at 8,000 (0.8)** —
the ladder can never claim more than 80% of what the vault holds, so a swap can
always pay out and cannot be phantom depth.

### 4.7 Execution: constant-product *segment* math (Uniswap v3-style)

Each ladder level is a concentrated-liquidity segment with sqrt-price bounds
`[lo, hi]` and liquidity `L`:

```text
base_capacity  = L·(1/√lo − 1/√hi)
quote_capacity = L·(√hi − √lo)

Buy base (trader pays dy_in):
  √P' = √P + dy_in/L
  dx_out = L·(1/√P − 1/√P')

Sell base (trader pays dx_in):
  1/√P' = 1/√P + dx_in/L
  dy_out = L·(√P − √P')
```

If the input crosses a level boundary, the basket is walked level by level and
the remainder carried forward (`arb_math::quote::walk_ladder` returns output,
consumed levels, and unabsorbed input). The program's `swap` executes the stored
levels through the same walk, so **quoted output and executed output are the
same integer arithmetic** — that is the "zero quote-versus-fill gap by
construction" property.

---

## Part 5 — How the mathematics fights LVR

There are five independent layers. No single one is sufficient; together they
bound LP loss.

### 5.1 Spread floor — charge for latency

A passive pool lets arbitrageurs trade at the pre-move price for free. ArbSwap
requires `half_spread ≥ min_spread_bps` (2 bps by default), so every latency
arbitrage must first overcome the edge. **Every fill earns at least the
spread.** (By design ArbSwap is *not* competitive with sub-bp propAMMs — it
trades raw tightness for LP protection.)

### 5.2 Inventory skew — stop becoming one-directionally exposed

`P_res = P(1 − g·q)` moves quotes *against* the direction of accumulated
inventory. If traders keep selling SOL to the vault, `q` rises, `P_res` falls,
and the vault stops being an unlimited buyer at a stale price — it shades the
bid. This is the A-S reservation-price structure, applied to a vault.

### 5.3 Volatility depth throttle — shrink `V` when σ rises

The `σ²/8` LVR identity says loss scales with σ²·V. ArbSwap therefore **reduces
V** as σ rises:

```text
σ-factor          = min(1, σ_target / σ)
confidence-factor = max(0, 1 − c / c_max)
jump-factor       = 1 − jump_cooldown   (if jump else 0)
depth_rule        = σ-factor · confidence-factor · (1 − jump-factor)
depth_mult        = min(depth_rule, depth_budget)
```

The theoretical LVR budget `V_active ≤ 8(R − g_gas)/σ²` is the derivation, but
**the enforced rule on-chain is the σ/confidence/jump throttle plus the
utilization cap**; the raw LVR *budget* (which needs business inputs `R` and
`g_gas`) is **not enforced on-chain** (`F-08`) and has been removed from product
claims. In other words: the guardrails are real and on-chain; the "optimal depth"
budget is a keeper-side policy bounded by those guardrails.

### 5.4 Oracle freshness + expiry — no filling a stale price

At quote **commit** the program verifies the Pyth `PriceUpdateV2` account
(owner, feed id, `VerificationLevel::Full`, freshness in **seconds**, price and
confidence equality) and bounds the anchor step. A committed quote **expires**
after `expiry_slots` (Devnet demo: 120 slots ≈ 30 s; hard cap 600 slots). A
quote that is expired simply **cannot swap** — the vault fails to a stop, never
to a bad price.

### 5.5 Confined keeper — the math never trusts the quoter

Even a fully compromised keeper can only move prices within:

```text
min_spread_bps ≤ half_spread ≤ max_spread_bps
|anchor − oracle| ≤ max_anchor_step (± band)
|level − anchor| ≤ level band (MAX_LEVEL_OFFSET_BPS = 500)
Σ capacity ≤ utilization_max · available reserves
same-cluster / same-vault / Pyth-full-verification checks
monotonic update_slot > stored
```

So the keeper adds **timeliness, not discretion**.

---

## Part 6 — Circuit breakers and fail-safe mathematics

### 6.1 Status machine

`Vault.status ∈ {ACTIVE, PAUSED}`. Every state-changing instruction requires
`ACTIVE` (`ErrorCode::Paused`). `PAUSED` stops deposits, swaps, and single-sided
paths; withdrawal paths remain so LPs can exit.

### 6.2 Expiry / staleness breaker (permissionless, state-only)

`trip_breaker` requires only that the stored quote is **expired** (`now ≥
expiry_slot`) or **stored-stale**, and that `version > 0`. It is deliberately
**state-only** — it does not trust a live oracle read at trip time — and any
caller may trip it. This is the "keeper down ⇒ market stops filling" property.
Reset is admin-only.

### 6.3 Realized-edge-loss breaker (automatic, against the stored oracle)

Each swap is valued against the reserved oracle. If the vault's realized edge
over a window drops below `−max_edge_loss_bps` of available value, the breaker
trips:

```text
edge = reserved_value(flow) − actual_transferred_value
if cumulative_window_edge ≤ −max_edge_loss_bps · available_value  → PAUSE
```

This catches **keeper mis-anchoring** (a keeper quoting away from the stored
oracle). It is tested on-chain (`malicious_keeper_edge_loss_trips_within_the_window`,
`honest_flow_does_not_trip_the_edge_breaker`) and in simulation across jump sizes
and latencies (`python -m simulation.sim.edge_breaker`). **Honest limitation:** it
does **not** detect losses from oracle *lag* (a genuine market move the oracle has
not yet reflected), and the zero-honest-trip count is partly by construction
(honest quotes round the same stored oracle, so edge ≥ 0).

### 6.4 Per-window one-sided flow cap

`QuoteState.window_base_sold` / `window_base_bought` roll on the slot clock and
cap cumulative one-sided flow since the last re-quote — a final bound on how much
inventory a single direction can push through before the keeper must reprice.
(`flow_n` netting was removed as dead state; the rolling window cap is the live
control.)

### 6.5 Volatility kill-switch

When on-chain `σ > max_sigma` (or the observation is stale, or confidence is too
wide), the volatility guard rejects quotes and the depth policy can drive
`depth → 0`: the vault stops quoting (fail-closed) on a spike rather than fill
into it.

---

## Part 7 — Trust model (why the math holds under adversaries)

| Role | Trust | Why the math holds |
|---|---|---|
| Solana runtime | trusted | — |
| Pyth program/feed | trusted, but **checked** | owner/feed/Full-verification/freshness/price+conf equality |
| Keeper(s) | **semi-trusted** | bounded by spread/anchor/level/capacity/flow/slot + bond |
| Traders | untrusted | `min_out`, `min_version`, expiry, capacity, flow cap |
| LPs | untrusted | share math rounds vault-favourably; `MIN_LIQUIDITY` burn |
| Admin | timelocked | `set_params`→`apply_params` delay; can pause/wind-down; **cannot seize** reserves; fee claims are timelocked and pay a fixed treasury |

---

## Part 8 — Fees and value distribution

```text
fee = ceil(amount_in · fee_bps / 10,000)      # retained in reserves
```

- Split into **insurance / keeper / protocol** buckets by fixed bps shares;
  the residual accrues to LPs implicitly via available reserves.
- Rate and split change only through the timelocked admin path.
- Keeper economics: adaptive priority fee `fee = base·(1 + urgency/10⁴)`, doubled
  on a jump, where `urgency = σ_bps`. Keeper rewards are paid from the keeper
  bucket against the **exact** version of the quote a swap consumed
  (`claim_keeper_reward`), preventing reward mismatches after re-quotes.

---

## Part 9 — How "good" is measured (and what is not claimed)

| Metric | Definition | Notes |
|---|---|---|
| Markout | `10⁴·d·(m(t+τ) − p_exec)/p_exec` | `d=+1` if vault bought base. The honest-execution score. |
| Quiet half-spread | `10⁴·|p_exec − m(t)|/m(t)` on quiet fills | Retail cost. |
| Hedged PnL | `Σ[V_(t+1) − V_t − B_t·(P_(t+1) − P_t)]` | Removes directional base exposure. |
| Quote-vs-fill gap | `10⁴·(out_quoted − out_executed)/out_quoted` | ≥0 would mean the trader did worse than the read quote; ArbSwap rejects such fills. |
| Passive LVR benchmark | `(σ²/8)·V·T` | Benchmark counterfactual, not a product result. |

**Honest status (from `docs/CLAIMS.md`):**
- Honest execution, bounded keeper, safe failure, fair pro-rata accounting,
  single-sided zap, bonded keepers, two-sided quoting, the realized-edge breaker,
  and devnet deployment are **SUPPORTED**.
- **"Beats passive pools" and "competitiveness vs tight propAMMs" are NOT
  CLAIMED.**
- The **LVR-reduction headline is SIMULATION ONLY — UNPROVEN** (the public LVR
  artifact is *modeled*: real price path, synthetic flow; ArbSwap's own realized
  LVR is `Unavailable`).
- `update_quote` ≈ 47.8k CU and `swap` ≈ 63.6k CU on the demo host — the ≤40k
  target is **not met**, and updates are **not** claimed cheap vs the paper.

---

## Part 10 — Why this is a credible path to production at scale

**What the design genuinely gets right**

1. **Deterministic, on-chain-verifiable execution.** Fills are exact integer
   ladder walks shared by keeper, program, and Python reference (970 golden
   vectors). Quoted output equals executed output by construction — no "quote
   shenanigans", no hidden last-look.
2. **Risk is priced, not ignored.** Inventory skew (`P_res`), volatility-scaled
   spread, confidence and staleness penalties, and jump protection make the
   vault behave like a maker, while the invariant keeps execution exact.
3. **Multiple independent loss bounds.** Spread floor + depth throttle +
   utilization cap + expiry + flow cap + edge breaker. Each bounds a different
   failure mode; none relies on trusting the keeper.
4. **Fail-safe, not fail-bad.** Stale/down keeper ⇒ quote expires ⇒ trading
   stops. Spike ⇒ kill-switch. Mis-anchoring ⇒ edge breaker. The default is
   always "stop", never "fill at a stale price".
5. **LP-friendly accounting.** Two-token pro-rata shares with vault-favourable
   rounding, burned minimum liquidity, warm-up, epoch queuing, and fee
   liabilities excluded from share value.
6. **Open, bonded keeper market.** Permissionless once `min_bond > 0`, with
   bond/slash/cooldown — accountability without a trusted operator.
7. **Transparent evidence culture.** Pre-registered studies, a claims ledger that
   marks unproven items, and an explicit "modeled vs measured" label everywhere.

**What must be true before large-scale production (honest gaps)**

- **Independent audit** (currently same-agent self-review).
- **Live, measured LVR / markout** from real fills (today: modeled proxy only).
- **CU reduction** for `update_quote`/`swap`, and a real latency/cadence study on
  mainnet hardware.
- **Economic validation at scale:** bootstrapped depth, keeper-incentive design,
  and multi-pair expansion (roadmap), plus oracle-lag loss measurement (the edge
  breaker does not cover it).
- **Calibration of every heuristic** (`a1..a5`, `e`, `g`, offsets/weights,
  `σ_target`, utilization) walk-forward, with losing regimes reported.

**Verdict.** The mathematics is sound and conservative: it is an
oracle-anchored, inventory-aware, volatility-responsive vault whose execution is
exactly verifiable on-chain and whose failure modes are fail-closed. That makes
it a defensible architecture for production **provided** the honest gaps above
are closed — most importantly an independent audit and live measurement of the
LVR claim, which the project itself currently labels unproven.

---

## Appendix A — Formula → code map

| Concept | Reference | Rust math | Keeper | On-chain |
|---|---|---|---|---|
| Q64.64 primitives | `simulation/reference/fixed.py` | `vault/math/src/fixed.rs` | via crate | via `arb-math` |
| Exact 192-bit sqrt | `fixed.py` | `wide::isqrt` | via crate | via `arb-math` |
| Segment walk (ask/bid) | `ladder.py` | `quote::walk_ladder` | builds ladder | executes levels |
| Inventory / reservation | `quote_math.py` | not ported (keeper-side) | yes | levels supplied |
| Volatility estimator | `quote_math.py` | `volatility.rs` | yes | `observe_volatility` |
| Spread / directional fee | `quote_math.py` | not ported | yes | bounded only |
| Depth throttle | `quote_math.py` | not ported | σ-target/conf | bounded by on-chain caps |
| Vault share math | `quote_math.py` | `quote.rs` | n/a | `deposit`/`claim_withdraw` |
| Fees | `fixed.py` | `quote::fee_amount` | n/a | `swap` |
| Golden vectors | `golden.py` | `golden.rs` | n/a | — |

## Appendix B — On-chain invariants

```text
out >= min_out else revert (SlippageExceeded)
quote_version >= min_version else revert (VersionTooOld)
expired quote never swaps
ladder input remainder == 0 on success
Σ base capacity  ≤ utilization_max · available_base
Σ quote capacity ≤ utilization_max · available_quote
min_spread_bps ≤ half_spread ≤ max_spread_bps
|anchor − oracle| within band; |level − anchor| within band
update_slot strictly increasing and ≤ clock.slot
checked arithmetic never wraps
```

## Appendix C — Key references

- Milionis, Moallemi, Roughgarden, Zhang, *Automated Market Making and
  Loss-Versus-Rebalancing* — arXiv:2208.06046 (LVR, `σ²/8`).
- Avellaneda & Stoikov, *High-frequency trading in a limit order book* (2008)
  (reservation price).
- Baggiani, Herdegen, Sanchez-Betancourt, *Optimal Dynamic Fees in AMMs* —
  arXiv:2506.02869 (linear inventory fee response).
- Alexander & Fritz, *Fees in Automated Market Makers* — arXiv:2406.12417
  (directional fees).
- Glosten & Milgrom (1985); Uniswap v2/v3 whitepapers; ERC-4626.
- In-repo: `MATH.md`, `docs/FORMULA.md`, `docs/ARCHITECTURE.md`,
  `docs/VOLATILITY_MATH_SPEC.md`, `docs/THREAT_MODEL.md`, `docs/CLAIMS.md`,
  `vault/math/src/`, `vault/program/src/lib.rs`.
