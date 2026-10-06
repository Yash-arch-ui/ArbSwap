# ArbSwap Formula Map

This document is the mathematical source map for P1. It explains what each
quantity means, where the formula comes from, whether it is a theorem or a
project heuristic, and whether it is implemented. The Python reference in
`research/reference/` is the executable source of truth for research math. The
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

Implemented in `research/reference/fixed.py`; Rust widening arithmetic is
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

**Status:** SPEC + HEURISTIC parameters. Implemented in
`research/reference/quote_math.py`; not yet ported to Rust.

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

### 6.1 Important specification ambiguity

The Build Plan table lists six weights and offsets `0, 2, 5, 10, 20, 40`,
while the segment equations require six positive-width intervals and define
`m_0 = 0`. Treating those six listed numbers literally creates a zero-width
first interval. Until the human resolves this, the Python reference uses six
positive outer boundaries `(2, 5, 10, 20, 40, 80)` and records the touch `0`


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

**Status:** DERIVED formulas; Python float reference implemented; Rust port
OPEN pending widening arithmetic and golden vectors.

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

**Status:** SPEC; Python reset implemented; swap integration pending.

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

**Status:** DERIVED LVR identity and budget; SPEC rule throttle; heuristic
normalization and coefficients. Validate with E1 and E5.

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

**Status:** SPEC; on-chain enforcement is P2/P3 work.

## 11. Fees

```text
fee     = ceil(amount_in*fee_bps/10,000)
net_in  = amount_in - fee
```

Fees are retained and split into LP, insurance, keeper, and protocol portions by
fixed shares. `fee_bps` changes only through timelocked parameters.

**Status:** SPEC; integer rounding implemented in `fixed.py`, program pending.

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

**Status:** SPEC; Python integer reference implemented; on-chain accounting
pending. Warm-up and epoch queue are P2 requirements.

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
```

Report mean, notional-weighted mean, identical-fill share, and tail. The 0x
39%/1.08 bps observation is Base/Flashblocks and must not be presented as a
Solana result.

## 14. Formula To Code Status

| Concept | Python reference | Rust `arb-math` | Simulator | On-chain |
|---|---|---|---|---|
| Q64.64 primitives | implemented | implemented (T1.3) | n/a | P2 |
| Inventory/reservation | implemented | not ported | B3/B4 quote | P2 |
| Volatility estimator | implemented | keeper later | implemented | off-chain |
| Spread/directional fee | implemented | not ported | implemented | validated bounds |
| Ladder/segment walk | implemented (Q64) | implemented (T1.3) | implemented | P2 |
| LVR budget/throttle | implemented | not ported | implemented | validated bounds |
| Flow reset | implemented | not ported | implemented | P2 |
| Vault share math | implemented | implemented (T1.3) | n/a | P2 |
| Golden vectors >=500 | generator written | consumer written | n/a | T1.2 |

The Rust port and the Python Q64 reference are written but **not yet proven
equal**: the golden-vector test skips until the vectors are generated. Run
`python -m research.reference.golden` and `cargo test -p arb-math` during the
testing phase.

## 15. Open Mathematical Decisions

1. Resolve the six-level offset convention before freezing T1.2 vectors.
2. Decide whether `update_quote` recomputes the full quote on-chain or enforces
   bounded consistency only; compute feasibility is a P2 measurement.
3. Port the exact 192-bit square-root and widened multiplication operations to
   Rust without relaxing the floor/ceil rules. **Done:** `crates/arb-math`
   matches 970 golden vectors bit-for-bit.
4. Calibrate all heuristic coefficients walk-forward and report losing regimes.
   **Open:** the simulator (T1.4) runs and is deterministic, but its E1-E4
   magnitudes are not yet calibrated and must not be headlined.
5. Complete the full read of Amini and Feinstein before demo claims involving
   oracle-contraction or sandwich resistance.
6. **First-depositor / share-inflation:** the MVP burns `MIN_LIQUIDITY`
   (Uniswap v2 style) but has no virtual-share offset; add one or prove the
   donation attack unprofitable before mainnet (THREAT_MODEL.md).
