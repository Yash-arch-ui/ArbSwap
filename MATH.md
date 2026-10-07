# ArbSwap Math

Authoritative formula map for the current P1-P3 implementation. Prices are
quote tokens per base token, with SOL as base and USDC as quote unless stated
otherwise. `bps` means basis points, `1 bps = 1/10,000`.

## 1. Units And Fixed Point

### Q64.64

For a non-negative real number `x`:

```text
x_q64 = floor(x * 2^64)
x     ~= x_q64 / 2^64
```

Square-root prices use:

```text
sqrtP_q64 = floor(sqrt(P * 2^64) * 2^64)
           = floor(sqrt(P_q64 << 64))
```

The implementation uses checked integer arithmetic. The Python reference uses
high precision/integer arithmetic; Rust uses `u128` plus widened `U256`
intermediates.

```text
mul_q64(a,b) = floor(a*b / 2^64)
div_q64(a,b) = floor(a*2^64 / b)
recip_q64(s) = floor(2^128 / s)
price(sqrtP) = floor(sqrtP*sqrtP / 2^64)
```

Signed division in the Rust-compatible reference truncates toward zero:

```text
tdiv(a,b) = sign(a/b) * floor(abs(a)/abs(b))
```

## 2. Inventory And Reservation Price

Let `B` be base reserves, `Q` quote reserves, and `P` the oracle price:

```text
q = (B*P - Q) / (B*P + Q)
```

`q` is in `[-1,1]`; positive `q` means the vault is long base.

```text
P_res = P * (1 - g*q)
```

The structure is the finite bounded implementation of the
Avellaneda-Stoikov reservation-price skew:

```text
r(s,t) = s - q*gamma*sigma^2*(T-t)
```

The signed midpoint skew is supported by the model. Symmetric widening in
`abs(q)` is an explicit ArbSwap heuristic.

## 3. Volatility And Jumps

For one-second prices:

```text
r_t       = ln(P_t / P_(t-1))
var_t     = lambda*var_(t-1) + (1-lambda)*r_t^2
sigma_t   = sqrt(var_t)
jump_flag = 1 if abs(r_t) > k_j*sigma_t else 0
```

The Python simulator uses fast and medium EWMA estimates. The Rust keeper uses
Q64.64 fraction returns, squared returns, EWMA lambdas, and a configurable jump
multiple.

## 4. Half-Spread

```text
s_raw = s_floor
      + a1*sigma_s
      + a2*abs(q)
      + a3*(c/P)
      + a4*max(0, age-grace)
      + a5*jump_flag

s = clamp(s_raw, s_min, s_max)
```

`s` is the half-spread as a fraction. Coefficients are calibrated heuristics,
not theorem-proven optima.

## 5. Directional Add-On

```text
move      = (P_t - P_(t-W)) / P_(t-W)
ask_extra = e*max(0, move)
bid_extra = e*max(0, -move)
```

When the external market rises, the ask side is widened; when it falls, the
bid side is widened. This follows the directional-fee motivation in the
research, while `e` remains tunable.

## 6. LVR Depth Throttle

For a constant-product segment:

```text
x(P)       = L/sqrt(P)
|x'(P)|    = L/(2*P^(3/2))
LVR_rate   = (1/2)*sigma^2*P^2*|x'(P)
           = sigma^2*L*sqrt(P)/4
V          = 2*L*sqrt(P)
LVR_rate/V = sigma^2/8
```

For expected revenue `R` and gas cost `g_gas`:

```text
V_active <= 8*(R - g_gas)/sigma^2
```

The rule throttle used by the simulator/keeper is:

```text
sigma_factor      = min(1, sigma_target/sigma_s)
confidence_factor = max(0, 1 - confidence_ratio/confidence_max_ratio)
jump_factor       = jump_cooldown_factor if jump_flag else 0

depth_rule = sigma_factor * confidence_factor * (1 - jump_factor)
depth_mult = min(depth_rule, depth_budget)
```

At zero volatility, the mathematical LVR budget is unbounded, but the
utilization cap still limits displayed depth.

## 7. Ladder Construction

For cumulative offsets `m_(k-1)` and `m_k` in basis points:

```text
ask_lo_k = P_res*(1 + s + ask_extra + m_(k-1)/10,000)
ask_hi_k = P_res*(1 + s + ask_extra + m_k/10,000)

bid_hi_k = P_res*(1 - s - bid_extra - m_(k-1)/10,000)
bid_lo_k = P_res*(1 - s - bid_extra - m_k/10,000)
```

Current default outer boundaries and weights:

```text
offsets = [2, 5, 10, 20, 40, 80] bps
weights = [1000, 1500, 2000, 2000, 2000, 1500] bps
sum(weights) = 10,000 bps
```

Side capacities:

```text
base_capacity  = depth_mult * utilization_max * B
quote_capacity = depth_mult * utilization_max * Q
C_ask,k        = weight_k * base_capacity / 10,000
C_bid,k        = weight_k * quote_capacity / 10,000
```

The program rejects non-positive or non-monotonic ladder levels.

## 8. Constant-Product Segment Math

For a segment with `P_a < P_b` and liquidity `L`:

```text
base_capacity  = L*(1/sqrt(P_a) - 1/sqrt(P_b))
quote_capacity = L*(sqrt(P_b) - sqrt(P_a))
```

### Buy Base On Ask

The trader pays quote `dy_in`:

```text
sqrt(P') = sqrt(P) + dy_in/L
dx_out   = L*(1/sqrt(P) - 1/sqrt(P'))
```

### Sell Base On Bid

The trader pays base `dx_in`:

```text
1/sqrt(P') = 1/sqrt(P) + dx_in/L
dy_out     = L*(sqrt(P) - sqrt(P'))
```

If the input exhausts a segment, the ladder walks to the next segment. The
Rust walk returns output, consumed levels, and unabsorbed input.

## 9. Fees And Fee Buckets

For input amount `x` and fee `f_bps`:

```text
fee   = ceil(x*f_bps / 10,000)
net_x = x - fee
```

The fee is retained by the vault. The current P2 accounting assigns portions
to insurance, keeper, and protocol liabilities:

```text
insurance = floor(fee*insurance_bps / 10,000)
keeper    = floor(fee*keeper_bps    / 10,000)
protocol  = floor(fee*protocol_bps  / 10,000)
LP_share  = fee - insurance - keeper - protocol
```

LP share value excludes the tracked liability buckets from reserves.

## 10. Vault Shares

First deposit with minimum locked liquidity `M`:

```text
root   = floor(sqrt(dB*dQ))
shares = root - M
total_shares = root
```

Later proportional deposit:

```text
shares = min(floor(dB*S/B_available), floor(dQ*S/Q_available))
```

Withdrawal:

```text
out_B = floor(shares*B_available/S)
out_Q = floor(shares*Q_available/S)
```

All payouts round down. Amounts received by the vault, including fees, round
up where integer rounding is required. New deposits become withdraw-eligible
only after the warm-up slot.

## 11. Quote Age And Oracle Guards

```text
age = current_slot - update_slot

age <= grace_slots                  : no age penalty
grace_slots < age < expiry_slots    : spread penalty
age >= expiry_slots                 : swap rejected
```

P2 update guards include:

```text
oracle_price > 0
confidence_bps <= max_conf_bps
current_slot - publish_time <= max_staleness_slots
abs(anchor_new - anchor_old)/anchor_old <= max_anchor_step
half_spread_bps <= max_spread_bps
update_slot > previous_update_slot
```

P2 now verifies Pyth Receiver account ownership, Full verification, feed
identity, freshness, decoded price equality, and confidence equality. Live
transport/deployment remains separate from this mathematical validation.

## 12. Flow Accumulator

```text
vault sells base: n <- n + base_out
vault buys base:  n <- n - base_in
quote update:     n <- 0
```

Inventory skew already moves the reservation price, so the current design resets
`n` on every accepted quote update.

## 13. Research Metrics

### Markout

```text
markout_tau_bps = 10,000*d*(m(t+tau) - p_exec)/p_exec
```

`d=+1` when the vault bought base and `d=-1` when it sold base.

### Quiet Flow

```text
quiet = abs(m(t+1s) - m(t-5s))/m < 1 bps
```

### Retail Half-Spread

```text
half_spread_bps = 10,000*abs(p_exec - m(t))/m(t)
```

### Hedged PnL

```text
hedged_PnL = sum_t [V_(t+1) - V_t - B_t*(P_(t+1) - P_t)]
```

The simulator records end-of-step holdings so `B_t` is the base held during the
next reference-price interval.

### Quote-Versus-Fill Gap

```text
gap_bps = 10,000*(out_quoted - out_executed)/out_quoted
```

Positive gap means the trader received less than the previously displayed
output. Honest execution rejects such a fill; the no-honesty ablation records it.

### Passive LVR Benchmark

```text
LVR_discrete = (sigma^2/8)*liquidity_value*seconds
```

## 14. Keeper Math

The P3 keeper uses integer Q64.64 inputs:

```text
return_q64 = abs(P_t - P_(t-1))*2^64 / P_(t-1)
variance    = lambda*old_variance + (1-lambda)*return_q64^2
sigma_q64   = sqrt(variance)
```

Keeper inventory skew uses:

```text
q_bps = (B*P - Q)*10,000/(B*P + Q)
skew  = inventory_coeff_bps*q_bps/10,000
P_res = P*(10,000 - skew)/10,000
```

Keeper update gating:

```text
update if no previous quote
     or slot_age >= max_age_slots
     or abs(P_new - P_old)*10,000 >= P_old*threshold_bps
```

Priority fee urgency:

```text
urgency = sigma_q64*10,000/2^64
fee     = base_fee + base_fee*urgency/10,000
if jump: fee = 2*fee
```

The keeper serializes the Anchor discriminator
`sha256("global:update_quote")[0:8]` followed by the Borsh fields in the P2
`QuoteUpdate` order.

## 15. Invariants

The implementation and planned integration tests enforce:

```text
out >= min_out, otherwise swap fails
quote version >= min_version
expired quote never swaps
ladder input remainder == 0 for a successful swap
shares/reserves remain proportional after withdrawals
liability buckets are excluded from LP share value
checked arithmetic never wraps
```

The continuous-time `sigma^2/8` identity is a benchmark, not a guarantee for
oracle-anchored discrete execution. Coefficients, update cadence, confidence
normalization, and depth budgets remain empirical parameters and must be
reported with sensitivity results.

## 16. Derivation And Research Sources

| Formula or design | Source | Classification |
|---|---|---|
| Q64.64 square-root price and concentrated-liquidity segment math | Uniswap v3 Whitepaper, https://app.uniswap.org/whitepaper-v3.pdf | Established execution math; independently ported, not copied |
| Constant-product ladder interpretation | Milionis, Moallemi, Roughgarden, Zhang, *Automated Market Making and Loss-Versus-Rebalancing*, https://arxiv.org/abs/2208.06046 | Established CFMM/LVR framework |
| `LVR_rate = 1/2*sigma^2*P^2*abs(x'(P))` | Milionis et al., especially the LVR definition and constant-product examples, https://arxiv.org/abs/2208.06046 | Derived benchmark |
| `LVR/V = sigma^2/8` for constant product | Milionis et al., Example 3, https://arxiv.org/abs/2208.06046 | Derived continuous-time identity |
| Inventory reservation-price skew | Avellaneda and Stoikov, *High-frequency trading in a limit order book* (2008) | Established model structure; ArbSwap uses a bounded parameterization |
| Linear inventory/external-price fee response | Baggiani, Herdegen, Sanchez-Betancourt, *Optimal Dynamic Fees in Automated Market Makers*, https://arxiv.org/abs/2506.02869 | Established approximation; coefficients remain tuned |
| Directional side-specific fee add-on | Alexander and Fritz, *Fees in Automated Market Makers*, https://arxiv.org/abs/2406.12417 | Research-supported motivation; ArbSwap coefficient is heuristic |
| Conditional zero-profit spread and informed/noise flow | Glosten and Milgrom, *Bid, Ask and Transaction Prices in a Specialist Market* (1985) | Market-microstructure model |
| Zero-profit AMM formulation | ZeroSwap, https://arxiv.org/abs/2310.09413 | Research model; not the MVP's full belief update |
| Adaptive trader-behavior curves | *Adaptive Curves for Optimally Efficient Market Making*, https://arxiv.org/abs/2406.13794 | Roadmap/reference model, not currently on-chain |
| Markout, quiet flow, microprice, update-vs-swap cost | Solmaz, Heimbach, Milionis, *Active Liquidity On Chain*, https://arxiv.org/abs/2609.38056 | Measurement methodology and propAMM evidence |
| Quote-versus-fill gap and phantom liquidity | 0x, *PropAMM Shenanigans*, https://0x.org/post/propamm-shenanigans | Measurement design; Base evidence is not treated as Solana evidence |
| Oracle confidence/staleness as a first-class risk | Nadler, Schuler, Schar, *Blockchain price oracles: Accuracy and violation recovery*, https://doi.org/10.1016/j.jcorpfin.2025.102908 | Empirical oracle-risk motivation; exact unverified figures remain excluded |
| Pyth price/confidence/publish-time interface | Pyth Core documentation, https://docs.pyth.network/price-feeds/core/price-feeds | Protocol interface source; production account verification remains a gate |
| Pyth update-frequency trade-offs | Pyth Lazer announcement, https://www.pyth.network/blog/introducing-pyth-lazer-launching-defi-into-real-time | System-design context, not a pricing theorem |
| Minimum-liquidity first deposit | Uniswap v2 Whitepaper, https://app.uniswap.org/whitepaper.pdf | Established anti-first-depositor mechanism |
| Pro-rata vault shares and rounding conventions | ERC-4626, https://eips.ethereum.org/EIPS/eip-4626, plus Uniswap v2 share accounting | Established accounting conventions adapted to two-token shares |
| Oracle-parametrized CFMM lag/error decomposition | Amini and Feinstein, *Oracle-Parametrized Constant Function Market Makers*, https://arxiv.org/abs/2609.33799 | Prior-art/risk reference; not an ArbSwap theorem |

### ArbSwap-Specific Heuristics

The following are not claimed as results from any paper: `a1..a5`, `e`, `g`,
ladder offsets and weights, `sigma_target`, confidence normalization,
utilization limits, jump cooldown, age coefficients, keeper thresholds,
priority-fee scaling, and the discrete simulator's flow parameters. They are
calibrated or stress-tested parameters and must remain labelled as such in
reports and demos.
