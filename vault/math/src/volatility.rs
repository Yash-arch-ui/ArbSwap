//! Canonical integer EWMA volatility and jump detection (Phase 1/2 of the
//! on-chain volatility feature). Shared bit-exactly by the keeper and the
//! program. See `docs/VOLATILITY_MATH_SPEC.md`.
//!
//! All arithmetic is checked Q64.64; no floating point. The model matches
//! `vault/keeper/src/lib.rs`'s existing `VolatilityState::update_with_dt`
//! (absolute simple returns, whole-second `lambda^n` decay, variance EWMA).

use crate::fixed::{mul_q64, sqrt_q64, MathError, MathResult};
use crate::wide::U256;

/// Basis-point denominator.
pub const BPS: u128 = 10_000;

/// Upper bound on the EWMA time-normalisation step count. Bounds the `lambda^n`
/// loop and prevents a large observation gap from driving the decay to zero.
pub const MAX_EWMA_STEPS: u32 = 300;

/// Default decays and jump multiple (bps / integer multiple).
pub const DEFAULT_LAMBDA_SHORT_BPS: u32 = 9_400; // 0.94
pub const DEFAULT_LAMBDA_MEDIUM_BPS: u32 = 9_900; // 0.99
pub const DEFAULT_JUMP_MULTIPLE: u128 = 4;

/// On-chain/keeper volatility state.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct VolatilityState {
    /// Q64.64 per-second variance of the short EWMA.
    pub variance_short_q64: u128,
    /// Q64.64 per-second variance of the medium EWMA.
    pub variance_medium_q64: u128,
    /// Previous normalized price, Q64.64 (0 = no previous observation).
    pub last_price_q64: u128,
    /// Jump flag from the most recent observation.
    pub jump: bool,
}

/// Whole-second step count, rounded, clamped to `[1, max_steps]`.
pub fn steps_from_millis(dt_millis: u64, max_steps: u32) -> u32 {
    let rounded = (dt_millis as u128 + 500) / 1_000;
    let n = if rounded == 0 { 1 } else { rounded };
    n.min(max_steps as u128) as u32
}

/// Absolute simple return `floor(|P_t - P_{t-1}|·2^64 / P_{t-1})` in Q64.64.
pub fn return_q64(previous_price_q64: u128, price_q64: u128) -> MathResult<u128> {
    if previous_price_q64 == 0 {
        return Err(MathError::Domain);
    }
    let diff = price_q64.abs_diff(previous_price_q64);
    let numerator = U256::from_u128(diff).shl(64);
    numerator
        .div_rem(U256::from_u128(previous_price_q64))
        .ok_or(MathError::DivideByZero)?
        .0
        .to_u128()
        .ok_or(MathError::Overflow)
}

/// `lambda^n` computed iteratively in bps: `d := floor(d·lambda_bps / 10_000)`.
pub fn pow_bps(lambda_bps: u32, n: u32) -> MathResult<u32> {
    let mut decay: u128 = BPS;
    for _ in 0..n {
        decay = decay
            .checked_mul(lambda_bps as u128)
            .ok_or(MathError::Overflow)?
            / BPS;
    }
    u32::try_from(decay).map_err(|_| MathError::Overflow)
}

/// One EWMA step with an `n`-second decay: `decay·old + (1-decay)·sample`.
pub fn ewma_step(old: u128, sample: u128, lambda_bps: u32, n: u32) -> MathResult<u128> {
    let decay_bps = pow_bps(lambda_bps, n)? as u128;
    let decay = (decay_bps << 64) / BPS;
    let one_minus = ((BPS - decay_bps) << 64) / BPS;
    let a = mul_q64(decay, old)?;
    let b = mul_q64(one_minus, sample)?;
    a.checked_add(b).ok_or(MathError::Overflow)
}

/// Advance the state by one observation at `price_q64`, `dt_millis` after the
/// previous one. `max_steps` bounds the time-normalisation (use
/// [`MAX_EWMA_STEPS`]).
pub fn update_with_dt(
    state: VolatilityState,
    price_q64: u128,
    dt_millis: u64,
    short_lambda_bps: u32,
    medium_lambda_bps: u32,
    jump_multiple: u128,
    max_steps: u32,
) -> MathResult<VolatilityState> {
    if price_q64 == 0 {
        return Err(MathError::Domain);
    }
    // First observation: seed the previous price, keep the variance series.
    if state.last_price_q64 == 0 {
        return Ok(VolatilityState {
            last_price_q64: price_q64,
            ..state
        });
    }
    let ret = return_q64(state.last_price_q64, price_q64)?;
    let ret2 = mul_q64(ret, ret)?;
    let n = steps_from_millis(dt_millis, max_steps);
    let innovation = ret2 / n as u128;
    let short = ewma_step(state.variance_short_q64, innovation, short_lambda_bps, n)?;
    let medium = ewma_step(state.variance_medium_q64, innovation, medium_lambda_bps, n)?;
    let sigma = sqrt_q64(short)?;
    let threshold = sigma
        .checked_mul(jump_multiple)
        .ok_or(MathError::Overflow)?;
    let jump = sigma > 0 && ret > threshold;
    Ok(VolatilityState {
        variance_short_q64: short,
        variance_medium_q64: medium,
        last_price_q64: price_q64,
        jump,
    })
}

/// One-second convenience wrapper using the default time bound.
pub fn update(
    state: VolatilityState,
    price_q64: u128,
    short_lambda_bps: u32,
    medium_lambda_bps: u32,
    jump_multiple: u128,
) -> MathResult<VolatilityState> {
    update_with_dt(
        state,
        price_q64,
        1_000,
        short_lambda_bps,
        medium_lambda_bps,
        jump_multiple,
        MAX_EWMA_STEPS,
    )
}

/// `sqrt_q64(variance_short_q64)`, the short-horizon sigma.
pub fn sigma_short_q64(state: VolatilityState) -> MathResult<u128> {
    sqrt_q64(state.variance_short_q64)
}
