# ArbSwap Formula Map

This document is the mathematical source map for P1. It explains what each
quantity means, where the formula comes from, whether it is a theorem or a
project heuristic, and whether it is implemented. The Python reference in
`simulation/reference/` is the executable source of truth for research math. The
Rust crate must not silently introduce a different formula.

## Status Labels

- **DERIVED**: follows from a cited paper or the stated market model.
- **SPEC**: an explicit ArbSwap design rule from `docs/BUILD_PLAN.md`.
- **HEURISTIC**: a tunable choice that must be calibrated and reported as such.
- **METRIC**: an evaluation definition, not a pricing rule.
- **OPEN**: requires a decision, proof, or implementation before the phase gate.

## Notation And Units

| Symbol | Meaning | Units |
|---|---|---|
| `P` | external/oracle price, quote per base | USDC/SOL |
| `B`, `Q` | base and quote reserves | token atoms |
| `q` | normalized inventory imbalance | [-1, 1] |
| `P_res` | inventory-adjusted reservation price | USDC/SOL |
| `s` | half-spread | fraction; 1 bps = 0.0001 |
| `c` | oracle confidence interval | price units |
| `age` | quote age | slots or seconds, never mixed |
| `sigma` | volatility per square-root second | 1/sqrt(second) |
| `L` | constant-product segment liquidity | model units |
| `V` | active liquidity value | quote units |
| `n` | net base sold by the vault since quote update | base units |

Prices are quote tokens per base token. Research data may use real numbers;

## 1. Fixed-Point And Rounding

### 1.1 Q64.64

For a non-negative real value `x`, its Q64.64 representation is:

```text
x_q64 = floor(x * 2^64)
x      ~= x_q64 / 2^64
```

The square-root price is represented as `sqrt(P) * 2^64`. The exact conversion
from a Q64.64 price integer `v` is:

```text
sqrt_q64(v) = floor(sqrt(v / 2^64) * 2^64)
             = floor(sqrt(v << 64))
```

The radicand is up to 192 bits. The shortcut `isqrt(v) << 32` is forbidden:

Implemented in `simulation/reference/fixed.py`; Rust widening arithmetic is
still required before this primitive can be ported on-chain.

### 1.2 Basic fixed-point operations

```text
mul_q64(a, b) = floor(a*b / 2^64)
div_q64(a, b) = floor(a*2^64 / b)
recip_q64(s)  = floor(2^128 / s)
price(sqrtP)  = floor(sqrtP*sqrtP / 2^64)
```

All intermediate products are checked. A vault payout rounds down; an amount
the vault receives rounds up. Python `//` cannot replace Rust signed `/`:
`tdiv(a,b) = trunc(a/b)` is required for signed inventory and return values.

## 2. Inventory And Reservation Price

### 2.1 Inventory imbalance

```text
q = (B*P - Q) / (B*P + Q)
```

`q = 0` means balanced quote and base value. `q > 0` means the vault is long
base. The denominator must be positive; the result is bounded by [-1, 1].

**Status:** SPEC. This is the normalized form used by ArbSwap.

**Status (F-03 FIXED, p2 pass):** the keeper is now decimals-aware
(`KeeperParams::base_atom_scale`); a balanced SOL(9)/USDC(6) vault quotes at the
anchor. Mixed-decimal parity is covered by `test_keeper_parity.py`.

### 2.2 Reservation price

```text
P_res = P * (1 - g*q)
```

When the vault is long base, `q > 0` lowers both quotes and encourages base
sales. This is the finite, bounded implementation of the inventory-skew idea
in Avellaneda-Stoikov:

```text
r(s,t) = s - q * gamma * sigma^2 * (T-t)
```

The A-S model moves the reservation midpoint with inventory; its total spread
is inventory-independent. Therefore ArbSwap's signed `P_res` skew is supported
by A-S, while symmetric inventory widening below remains a heuristic.

**Status:** DERIVED structure plus SPEC bounded parameterization.

## 3. Volatility And Regimes

For one-second reference prices:

```text
r_t       = ln(P_t / P_(t-1))
var_t     = lambda*var_(t-1) + (1-lambda)*r_t^2
sigma_t   = sqrt(var_t)
jump_flag = 1 if |r_t| > k_j*sigma_t else 0
```

ArbSwap maintains a fast estimate (`lambda ~= 0.94`) and a slow estimate
(`lambda ~= 0.99`). These values are starting heuristics, not measured truths.
The simulator must calibrate them walk-forward and freeze them before testing.

**Status:** SPEC + HEURISTIC parameters. Implemented in the independent float
reference `simulation/reference/quote_math.py` (log returns, per-second decay
`lambda^dt`, innovation `r^2/dt`, so the estimate is clock-invariant). The Rust
keeper has a `VolatilityState` but it uses simple `|dP|/P` returns with
per-sample lambdas and **no time normalisation**, so it does not yet match the
reference (audit F-09).

## 4. Half-Spread

```text
s_raw = s_floor
      + a1*sigma_s
      + a2*abs(q)
      + a3*(c/P)
      + a4*max(0, age-grace)
      + a5*jump_flag
s     = clamp(s_raw, s_min, s_max)
```

Interpretation:

- `s_floor`: minimum edge for fees, gas, and operating risk.
- `a1*sigma_s`: compensation for fast price movement.
- `a2*abs(q)`: symmetric risk widening; **HEURISTIC**, not A-S.
- `a3*c/P`: confidence interval as a relative uncertainty.
- `a4*max(0, age-grace)`: stale quote penalty.
- `a5*jump_flag`: temporary jump protection.

Baggiani et al. support dynamic, approximately linear fee responses and a
signed inventory term. Their result does not prove this exact symmetric
absolute-inventory term. Report the distinction in calibration results.

**Status:** SPEC/HEURISTIC. No coefficient is a theorem or a promise.

**On-chain bound (p2-T2).** `update_quote` requires
`config.min_spread_bps <= half_spread_bps <= config.max_spread_bps`. The
recommended protocol default is `min_spread_bps = 2` bps, matching the frozen
simulator `spread_floor` (`simulation/data/results/frozen_params.json`:
`spread_floor = 0.0002`). The keeper's `KeeperParams` defaults are aligned
(`spread_floor_bps = spread_min_bps = 2`) so a calm-state keeper quote is never
below the on-chain minimum; `test_keeper_parity.py` mirrors these values.

The keeper (`keeper/src/lib.rs`) implements this formula with the same unit
convention as the reference: each coefficient is `reference_coeff × 10_000`, so
a bps term is `coefficient_bps × signal(as a fraction)`. The volatility,
inventory, confidence and age terms and the `[spread_min, spread_max]` clamp are
all present; `simulation/sim/test_keeper_parity.py` checks the spread against
`quote_math.compute_quote` within the bps quantum (audit **F-09 fixed**).

## 5. Directional Add-On

```text
move      = (P_t - P_(t-W)) / P_(t-W)
ask_extra = e*max(0, move)
bid_extra = e*max(0, -move)
```

If the external market rises, the ask is the stale side and is widened. If it
falls, the bid is widened. Alexander and Fritz motivate directional fees under
drift and toxic flow; the coefficient `e` is still a calibrated heuristic.

**Status:** DERIVED motivation, SPEC formula, HEURISTIC coefficient.

**Status (F-09 FIXED, p2 pass):** the keeper computes the directional add-on and
encodes `ask_extra_bps`/`bid_extra_bps` into the `update_quote` payload; the
program stores and applies them to the anchor band.

## 6. Ladder Construction

For level `k`, with cumulative offsets `m_(k-1)` and `m_k` in bps:

```text
ask_lo_k = P_res*(1 + s + ask_extra + m_(k-1)/10,000)
ask_hi_k = P_res*(1 + s + ask_extra + m_k/10,000)

bid_hi_k = P_res*(1 - s - bid_extra - m_(k-1)/10,000)
bid_lo_k = P_res*(1 - s - bid_extra - m_k/10,000)
```

Capacity is bounded by holdings:

```text
base_cap  = depth_mult*u_max*B
quote_cap = depth_mult*u_max*Q
C_ask,k   = w_k*base_cap
C_bid,k   = w_k*quote_cap
sum(w_k)  = 1
```

**On-chain capacity bound (p2-T3, closes audit F-12 on-chain).** `update_quote`
now reads the vault's reserve token accounts and requires, for the quoted
ladder,
`Σ base_capacity_k * 10^4 <= utilization_max_bps * available_base` and
`Σ quote_capacity_k * 10^4 <= utilization_max_bps * available_quote`, where
`available = reserve − (insurance + keeper + protocol)` and capacities use the
`arb-math` floor rounding (`Level::base_capacity` / `quote_capacity`).
`utilization_max_bps` is a timelocked `Config` bound capped at 8,000 (0.8). The
keeper sizes its ladder from the same available reserves
(`available_reserves`) and the same `utilization_bps`, so an honest keeper
ladder passes; the differential test
`keeper_ladder_respects_the_utilization_budget` checks the base and quote sums.

*Remaining (keeper replay only):* the offline replay hard-codes placeholder
reserves (`1_000` / `150_000`); a live/replay keeper must supply the real
available reserves (it now reads them over RPC).

### 6.1 Important specification ambiguity

The Build Plan table lists six weights and offsets `0, 2, 5, 10, 20, 40`,
while the segment equations require six positive-width intervals and define
`m_0 = 0`. Treating those six listed numbers literally creates a zero-width
first interval. The reference therefore uses six positive outer boundaries
`(2, 5, 10, 20, 40, 80)` and records the touch `0` (see §15.1 — this is the
frozen choice across Python, keeper and program, pending human ratification).


```text
dx = L*(1/sqrt(P_a) - 1/sqrt(P_b))
dy = L*(sqrt(P_b) - sqrt(P_a))
```

For a trader buying base with quote input `dy_in` on an ask segment:

```text
sqrt(P') = sqrt(P) + dy_in/L
dx_out   = L*(1/sqrt(P) - 1/sqrt(P'))
```

For a trader selling base with base input `dx_in` on a bid segment:

```text
1/sqrt(P') = 1/sqrt(P) + dx_in/L
dy_out     = L*(sqrt(P) - sqrt(P'))
```

If the requested input crosses a boundary, fill the current segment fully and
carry the remainder to the next segment. These are the concentrated-liquidity

**Status:** DERIVED formulas; Python float reference and the Rust
`arb-math::quote::walk_ladder` port are both implemented and agree bit-for-bit
on the golden vectors (see §14). The on-chain `swap` executes the stored levels
through the same walk.

**Two-sided ladder (h1).** The keeper now emits **both** sides around the
reservation price: ask levels above `P_res` (`lo = P_res(1+s+ask_extra+m_{k-1})`,
`hi = P_res(1+s+ask_extra+m_k)`) and bid levels below it
(`hi = P_res(1-s-bid_extra-m_{k-1})`, `lo = P_res(1-s-bid_extra-m_k)`). Ask
levels are sized from a **base** capacity budget (the vault pays base) and bid
levels from a **quote** budget (the vault pays quote), each
`capacity_side · utilization · depth` distributed by the weights. The program
stores `ask_levels` and `bid_levels`; `swap(BuyBase)` walks the ask side and
`swap(SellBase)` the bid side. The F-04 band is bound to **`P_res`** (which is
itself bounded to the anchor by `max_inventory_bps`), because a bid level may sit
below the anchor when the reservation is skewed down. `arb-math` gains
`Level::liquidity_for_quote_capacity` (the inverse of `quote_capacity`).

## 8. Flow Accumulator

`n` is net base sold by the vault since the last quote update:

```text
vault sells base: n <- n + base_out
vault buys base:  n <- n - base_in
update_quote:     n <- 0
```

The reset is decision D-04. It is intentionally different from persistent
netting approaches described for some proprietary AMMs because inventory skew
already moves `P_res`.

**Status:** SPEC in the Python reference only. The on-chain `flow_n` was dead
state (stored, never read for pricing, with mixed units), so it was **removed**
in p2-T8; the per-window cumulative one-sided flow cap (`window_base_sold`/
`window_base_bought`) is the live on-chain flow control. The simulator still
returns a `flow_n` from `walk_ladder` for reference parity but ignores it.

## 9. LVR And Depth Throttle

For a constant-product segment whose base holdings are `x(P)=L/sqrt(P)`:

```text
|x'(P)|       = L/(2*P^(3/2))
LVR_rate     = (1/2)*sigma^2*P^2*|x'(P)
             = sigma^2*L*sqrt(P)/4
V            = 2*L*sqrt(P)
LVR_rate/V   = sigma^2/8
```

The `sigma^2/8` result is the constant-product specialization in Milionis,
Moallemi, Roughgarden, and Zhang. It is a benchmark identity under the paper's
continuous-price assumptions, not a guarantee for an oracle-anchored vault.
Oracle lag/error adds another component; Amini and Feinstein's skim separates
market-lag and oracle-error terms and identifies update-sandwich risk.

If `R` is expected edge revenue per second and `g_gas` is update cost per
second:

```text
sigma^2*L*sqrt(P)/4 <= R-g_gas
V_active <= 8*(R-g_gas)/sigma^2
```

The rule throttle is:

```text
depth_rule = min(1, sigma_target/sigma_s)
              * max(0, 1-c/c_max)
              * (1-jump_cooldown_factor)
depth_mult  = min(depth_rule, depth_budget)
```

When `sigma = 0`, the LVR budget is unbounded mathematically; the holdings
utilization cap still limits displayed depth.

**Status:** the σ²/8 identity is DERIVED; the throttle that actually runs is the
σ-target × confidence rule (plus the inventory cap). **The LVR *budget* is not
applied (F-08).** `lvr_budget_value(R, g_gas, sigma)` exists only in the
research reference; `R` (expected edge revenue per second) and `g_gas` (gas per
second) are undefined business inputs, so no caller supplies them and every
simulator run uses `depth_budget = 1.0`. The budget language is therefore
**dropped from product claims** until those inputs are defined and measured;
the depth rule above is what the simulator and keeper implement.

## 10. Oracle, Age, And Expiry Guards

Reject an update when:

```text
now - publish_time > max_staleness
c/P > max_conf_ratio
abs(P - anchor_prev)/anchor_prev > max_anchor_step
```

For an existing quote:

```text
age <= grace_slots:                  no penalty
grace_slots < age < expiry_slots:    age_penalty = kappa*(age-grace_slots)
age >= expiry_slots:                 reject swap
```

Pyth Core supplies price, confidence, exponent, and publish time. Its update
verification is in-band and caller-paid, so measurements must separate Pyth
verification CU from ArbSwap instruction CU.

**Status:** SPEC; **on-chain enforcement is implemented (P2) and tested.** The
program requires a Pyth Receiver `PriceUpdateV2` account, uses
`get_price_no_older_than` (which enforces `VerificationLevel::Full`, feed-id
match and `publish_time + max_age >= now` in Unix seconds), pins
`oracle_price` to the decoded Q64 price, and bounds the confidence. Note the
guard is in **seconds**, not slots (audit D1). The live transport (Hermes fetch,
Pyth CPI and a funded keeper) remains Open.

## 11. Fees

```text
fee     = ceil(amount_in*fee_bps/10,000)
net_in  = amount_in - fee
```

Fees are retained and split into LP, insurance, keeper, and protocol portions by
fixed shares. `fee_bps` changes only through timelocked parameters.

**Status:** SPEC; integer rounding implemented in `fixed.py` and
`arb-math::quote::fee_amount`, and used by the on-chain `swap`. Note the program
tracks only the three liability buckets (insurance/keeper/protocol) and excludes
them from share value; there is no separate LP bucket (audit D5). `set_params`
is timelocked and admin-only (F-17 fixed).

## 12. Vault Shares

First deposit:

```text
shares = floor(sqrt(dB*dQ)) - MIN_LIQUIDITY
```

Later proportional deposit:

```text
shares = min(floor(dB*S/B), floor(dQ*S/Q))
```

Withdrawal:

```text
out_B = floor(shares*B/S)
out_Q = floor(shares*Q/S)
```

The first liquidity amount is permanently burned. This follows the Uniswap v2
minimum-liquidity mechanism; no oracle price is used in share math, per D-05.

**Status:** SPEC; implemented in `vault/program/src/lib.rs`. F-10 fixed: a
deposit pulls only what the minted shares are worth and tickets are reusable
(`init_if_needed`). F-11 mitigated and tested: the `MIN_LIQUIDITY` burn plus a
zero-share mint guard; `first_depositor_inflation_loses_at_most_rounding` shows a
donation-inflation attacker cannot steal from a later depositor beyond rounding.
No ERC-4626 virtual-share offset (recorded as a mitigation, not a proof).

## 13. Research Metrics

These formulas measure outcomes; they do not justify tuning parameters.

### Microprice

```text
m = (bid*q_ask + ask*q_bid) / (q_bid + q_ask)
```

This is the top-of-book size-weighted price used by Solmaz et al. and the
ArbSwap markout baseline.

### Markout

```text
markout_tau = 10,000*d*(m(t+tau)-p_exec)/p_exec
```

`d=+1` when the venue bought base and `d=-1` when it sold. Positive means the
venue gained. Report horizons -5 through +15 seconds and the 2-second value.

### Quiet flow

```text
abs(m(t+1s)-m(t-5s))/m < 1 bps
```

### Hedged PnL

```text
hedged_pnl = sum_t [V_(t+1)-V_t - B_t*(P_(t+1)-P_t)]
```

This removes the vault's directional base exposure. Do not headline raw LP PnL
or impermanent loss as microstructural alpha.

### Quote-versus-fill gap

```text
gap_bps = 10,000*(quoted_out - executed_out)/quoted_out
```

Positive means the trader received less than the quote they could have read
(worse for the trader); negative means they did better. Report mean,
notional-weighted mean, identical-fill share, and tail. The 0x 39%/1.08 bps
observation is Base/Flashblocks and must not be presented as a Solana result.

## 14. Formula To Code Status

| Concept | Python reference | Rust `arb-math` | Keeper | Simulator | On-chain |
|---|---|---|---|---|---|
| Q64.64 primitives | `fixed.py` | `fixed.rs` | yes | n/a | via `arb-math` |
| Exact 192-bit sqrt | `fixed.py` | `wide::isqrt` | via crate | n/a | via `arb-math` |
| Segment walk (ask/bid) | `ladder.py` | `quote::walk_ladder` | builds ladder | implemented | executes levels |
| Inventory/reservation | `quote_math.py` | not ported (keeper-side) | yes (decimals bug) | B3/B4 quote | levels supplied |
| Volatility estimator | `quote_math.py` | not ported (keeper-side) | yes (not normalised) | implemented | off-chain |
| Spread/directional fee | `quote_math.py` | not ported (keeper-side) | partial, no clamp | implemented | bounded only |
| LVR budget/throttle | `quote_math.py` (`lvr_budget_value`) | not ported | σ-target only | σ-target/confidence only | keeper-side policy, bounded by on-chain caps |
| Flow accumulator | reset only | n/a | n/a | reset only | removed on-chain (p2-T8) |
| Vault share math | `quote_math.py` | `quote.rs` | n/a | n/a | implemented inline |
| Fees | `fixed.py` | `quote::fee_amount` | n/a | n/a | implemented |
| Golden vectors | generator `golden.py` | consumer `golden.rs` | n/a | n/a | — |

**Golden vectors now exist and run:** `vault/math/tests/golden.rs` checks
970 vectors (`golden_vectors.txt`) bit-for-bit; it no longer skips.

**Independence caveat (audit F-07):** the golden generator imports
`simulation/reference/{fixed,ladder}.py`, and `ladder.py` states it *"mirrors
`vault/math/src/quote.rs` bit-for-bit"*. The golden test is therefore a
strong cross-language differential regression check, **not** an independent
proof that the algorithm is correct. The independent float implementation
(`simulation/reference/quote_math.py`) is exercised separately by
`simulation/reference/test_quote_math.py`. Do not describe the vectors as an
independent oracle.

## 15. Open Mathematical Decisions

1. **Offset convention.** The Build Plan table lists `0, 2, 5, 10, 20, 40`
   (which creates a zero-width first interval); every implementation (Python,
   keeper, program tests) uses positive outer boundaries `(2, 5, 10, 20, 40, 80)`
   with the first interval width `[0, 2]`. The vectors are frozen on the latter.
   **Still needs human ratification**, but the code is internally consistent, so
   this is a documentation decision, not a blocker.
2. Decide whether `update_quote` recomputes the full quote on-chain or enforces
   bounded consistency only. **Resolved in part:** the program today enforces
   *shape and Pyth consistency* but does **not** bind the executed `levels` to
   the anchor/oracle (audit F-04), so a compromised keeper can quote arbitrary
   prices. This is the top devnet blocker.
3. Port the exact 192-bit square-root and widened multiplication to Rust without
   relaxing floor/ceil. **Done:** `vault/math` matches 970 golden vectors.
4. Calibrate heuristic coefficients walk-forward and report losing regimes.
   **Done for P1:** the pre-registered W1–W6 study (`python -m simulation.sim.study`,
   `docs/P1_RESULTS.md`) freezes W1 params and reports all five held-out windows.
   The synthetic/exploratory generator is `simulation/sim/report.py`
   (`docs/P1_SYNTHETIC.md`). Coefficients remain heuristics, not optima.
5. Complete the full read of Amini and Feinstein before demo claims involving
   oracle-contraction or sandwich resistance.
6. **First-depositor / share-inflation:** the MVP burns `MIN_LIQUIDITY`
   (Uniswap v2 style) but has no virtual-share offset; add one or prove the
   donation attack unprofitable before mainnet (THREAT_MODEL.md).
7. **LVR budget dropped from claims** (p2-T8): `R` and `g_gas` are undefined business inputs, so the depth rule is a *keeper-side policy bounded by on-chain caps* (spread/anchor/capacity), not an enforced on-chain budget.
8. **Fix the keeper decimals bug** (F-03) and bind the on-chain ladder to the
   anchor (F-04) before any devnet run.
