//! Q64.64 fixed-point primitives (T1.3), mirroring `simulation/reference/fixed.py`.
//!
//! Conventions (Build Plan §5.2):
//! - `price_q64 = P * 2^64`; `sqrt_price = sqrt(P) * 2^64`.
//! - `sqrt_q64` is the **exact** floor `isqrt(v << 64)` (192-bit radicand,
//!   decision 2026-10-06). The shortcut `isqrt(v) << 32` is forbidden.
//! - Amounts the vault pays out round down; amounts it receives round up.
//! - Anything that can be negative uses [`tdiv`] (truncation toward zero) to
//!   match Rust's `/`, never a floor-division emulation.

use crate::wide::U256;

/// Error type shared by the fixed-point layer. Mirrors the `FixedPointError`
/// raised by the Python reference.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MathError {
    DivideByZero,
    Overflow,
    Domain,
}

pub type MathResult<T> = Result<T, MathError>;

pub const Q64: u128 = 1u128 << 64;
pub const BPS_DENOMINATOR: u128 = 10_000;
pub const U64_MAX: u128 = (1u128 << 64) - 1;

/// Truncating signed division toward zero (Rust `/`). Python must use `tdiv`.
pub fn tdiv(a: i128, b: i128) -> MathResult<i128> {
    if b == 0 {
        return Err(MathError::DivideByZero);
    }
    Ok(a / b)
}

/// Exact floor square root of a non-negative integer (small helper).
pub fn isqrt_u128(v: u128) -> u128 {
    if v < 2 {
        return v;
    }
    // Newton iterations on u128 (only used as a seed / small path).
    let mut x = 1u128 << (128 - v.leading_zeros() as u128).div_ceil(2);
    let mut y = (x + v / x) / 2;
    while y < x {
        x = y;
        y = (x + v / x) / 2;
    }
    x
}

/// `sqrt(value)` for a Q64.64 value, result Q64.64, exact floor.
pub fn sqrt_q64(value: u128) -> MathResult<u128> {
    let radicand = U256::from_u128(value).shl(64);
    U256::isqrt(radicand).to_u128().ok_or(MathError::Overflow)
}

/// Q64.64 * Q64.64 -> Q64.64, floor. Non-negative operands only.
pub fn mul_q64(a: u128, b: u128) -> MathResult<u128> {
    U256::mul_u128(a, b)
        .shr(64)
        .to_u128()
        .ok_or(MathError::Overflow)
}

/// Q64.64 / Q64.64 -> Q64.64, floor. `b` must be non-zero.
pub fn div_q64(a: u128, b: u128) -> MathResult<u128> {
    if b == 0 {
        return Err(MathError::DivideByZero);
    }
    let numerator = U256::from_u128(a).shl(64);
    let quotient = u256_div_u128(numerator, b)?;
    quotient.to_u128().ok_or(MathError::Overflow)
}

/// Divide a `U256` by a `u128`, returning a `U256` quotient.
fn u256_div_u128(numerator: U256, divisor: u128) -> MathResult<U256> {
    if divisor == 0 {
        return Err(MathError::DivideByZero);
    }
    U256::div_rem(numerator, U256::from_u128(divisor))
        .map(|(quotient, _)| quotient)
        .ok_or(MathError::DivideByZero)
}

/// `floor(2^128 / s)` for a Q64.64 sqrt price `s >= 2`.
pub fn recip_q64(s: u128) -> MathResult<u128> {
    if s < 2 {
        return Err(MathError::Domain);
    }
    let numerator = U256::ONE.shl(128);
    u256_div_u128(numerator, s).and_then(|q| q.to_u128().ok_or(MathError::Overflow))
}

/// Q64.64 price -> Q64.64 sqrt price (identity on `sqrt_q64`).
pub fn sqrt_from_price(price_q64: u128) -> MathResult<u128> {
    sqrt_q64(price_q64)
}

/// Q64.64 sqrt price -> Q64.64 price, floor.
pub fn price_from_sqrt(sqrt_p: u128) -> MathResult<u128> {
    mul_q64(sqrt_p, sqrt_p)
}

/// Q64.64 of `(1 + x_bps/10_000)`; `x_bps` must satisfy `x_bps > -10_000`.
pub fn one_plus_q64(x_bps: i128) -> MathResult<u128> {
    let num = BPS_DENOMINATOR as i128 + x_bps;
    if num <= 0 {
        return Err(MathError::Domain);
    }
    let scaled = (num as u128).checked_mul(Q64).ok_or(MathError::Overflow)?;
    Ok(scaled / BPS_DENOMINATOR)
}

/// `floor(sqrt_p * sqrt_q64(1 + x_bps))` — the two-floor scaling path.
pub fn sqrt_price_scaled(sqrt_p: u128, x_bps: i128) -> MathResult<u128> {
    mul_q64(sqrt_p, sqrt_q64(one_plus_q64(x_bps)?)?)
}

/// `floor(x * bps / 10_000)` for non-negative `x`. Uses the 256-bit product so
/// it matches the arbitrary-precision Python reference for every `x`, not just
/// the on-chain token range.
pub fn mul_bps(x: u128, bps: u128) -> MathResult<u128> {
    let product = U256::mul_u128(x, bps);
    product
        .div_rem(U256::from_u128(BPS_DENOMINATOR))
        .ok_or(MathError::DivideByZero)?
        .0
        .to_u128()
        .ok_or(MathError::Overflow)
}

/// `ceil(x * bps / 10_000)` for non-negative `x`. 256-bit product, exact match
/// to the Python reference.
pub fn ceil_bps(x: u128, bps: u128) -> MathResult<u128> {
    let product = U256::mul_u128(x, bps);
    let (quotient, remainder) = product
        .div_rem(U256::from_u128(BPS_DENOMINATOR))
        .ok_or(MathError::DivideByZero)?;
    if remainder.is_zero() {
        quotient.to_u128().ok_or(MathError::Overflow)
    } else {
        quotient
            .checked_add(&U256::ONE)
            .ok_or(MathError::Overflow)?
            .to_u128()
            .ok_or(MathError::Overflow)
    }
}
