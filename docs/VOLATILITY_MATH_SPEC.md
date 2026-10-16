# Canonical Volatility & Jump Specification (on-chain)

**Status:** implementation spec (Phase 1 of the on-chain EWMA/jump feature).
**Source of truth:** the existing integer keeper model in
`vault/keeper/src/lib.rs::VolatilityState::update_with_dt` plus
`docs/ONCHAIN_VOLATILITY_JUMP_DETECTOR_PLAN.md`.
**Float reference (research only, not ported):** `simulation/reference/quote_math.py`.

## Decision

The canonical model is the **integer EWMA-variance model already used by the
keeper**. It is chosen over the float reference because it is already
fixed-point, `no_std`-portable, and directly reusable by the program.

Divergences from `quote_math.py` (kept deliberately, documented, not "fixed"):

| Aspect | Float reference | Canonical (keeper, adopted) |
|---|---|---|
| Return | `ln(P_t / P_{t-1})` | `|P_t - P_{t-1}| / P_{t-1}` (absolute simple return) |
| State | variance of log return | variance of squared simple return |
| Time norm | `decay = λ^{dt}`, innovation `/dt` | `n = round(dt/1s)`, `decay = λ^n`, innovation `/n` |
| Jump test | `|ret| > k·σ·√dt` | `ret > k·σ` |

The float reference uses log returns and `√dt`; the integer keeper uses simple
returns and a whole-second decay. Porting the **integer** model keeps keeper and
program bit-identical and avoids introducing `ln`/`√` on-chain.

## Units

- Prices: **Q64.64** (`x_q64 = floor(x·2^64)`), the same value the program
  already normalizes from Pyth via `normalize_pyth_price_q64`.
- `variance_*_q64`: Q64.64 of the per-second return variance.
- `sigma_q64 = sqrt_q64(variance_short_q64)` (Q64.64).
- Decays `λ` are **bps** (`λ=0.94 → 9_400`); `jump_multiple` is an integer
  multiple of `sigma`.

## Formulas

```text
# 1. Return (absolute simple, Q64.64)
r = floor( |P_t - P_{t-1}| · 2^64 / P_{t-1} )        # 0 when P_t == P_{t-1}

# 2. Time normalisation
n = max(1, round(dt_millis / 1000))                    # bounded: n <= MAX_EWMA_STEPS

# 3. Innovation (per-second)
innovation = floor( r^2 / n )                          # r^2 = mul_q64(r, r)

# 4. EWMA update (per series), decay = λ^n computed in bps
decay_bps  = λ_bps applied n times: d := floor(d·λ_bps / 10_000)
decay      = floor(decay_bps · 2^64 / 10_000)
one_minus  = floor((10_000 - decay_bps)·2^64 / 10_000)
v_new      = mul_q64(decay, v_old) + mul_q64(one_minus, innovation)

# 5. Jump
sigma = sqrt_q64(v_short)
jump  = sigma > 0 && r > sigma · jump_multiple
```

## Edge-case behaviour

- **First observation** (`last_price_q64 == 0`): store `last_price_q64 := P_t`,
  leave variances and `jump` unchanged, return (no return can be computed).
- **Same price**: `r = 0`, innovation `= 0`, variances decay toward 0 (do not
  reset), `jump := false`.
- **Older / repeated publish time**: rejected by the observation instruction
  before this math runs (monotonic `publish_time`). This module assumes the
  caller has already enforced ordering.
- **Large gap**: `n` is capped at `MAX_EWMA_STEPS` so decay cannot be driven to
  zero and compute stays bounded. The cap is documented and tested.
- **Zero / invalid price**: `P_{t-1} == 0` is treated as first observation;
  a zero `P_t` must be rejected by the caller (Pyth validation enforces `> 0`).
- **Overflow**: every multiply/add is checked; overflow returns
  `MathError::Overflow` and the caller must reject the observation without
  mutating state.

## Constants

```text
MAX_EWMA_STEPS = 300          # bounds λ^n loop and large-gap decay
default λ_short = 9_400 bps   # 0.94
default λ_medium = 9_900 bps  # 0.99
default jump_multiple = 4
```

## Golden vectors

`vault/math/tests/volatility.rs` derives vectors directly from these formulas
(first observation, flat, rising/falling, rising/falling variance, jump
activation/clearing, interval normalisation, large gap cap, overflow). The
keeper is refactored to call this module so the vectors are shared by
construction.
