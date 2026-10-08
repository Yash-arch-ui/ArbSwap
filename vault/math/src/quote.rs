//! Integer quote engine: constant-product segment walk and vault shares
//! (T1.3), mirroring the Section 5 formulas in `docs/FORMULA.md`.
//!
//! Scaling conventions used here (and reproduced bit-for-bit in Python):
//! - `sqrt_lo`, `sqrt_hi` are Q64.64 square-root prices with `sqrt_lo < sqrt_hi`.
//! - `liquidity` is the integer `L_int = L_real * 2^64`.
//! - A full ask level consumes
//!   `dy_full = floor(L*(hi-lo)/2^128)` quote and releases
//!   `dx_full = floor(floor(L*(hi-lo)/hi)/lo)` base.
//! - A full bid level consumes `dx_full` base and releases `dy_full` quote.
//!
//! All divisions floor, so amounts the vault pays out can only round down;
//! capacity checks use the same integers the walk returns.

use crate::fixed::{isqrt_u128, MathError, MathResult};
use crate::wide::U256;

pub const BPS_DENOMINATOR: u128 = 10_000;
pub const Q64: u128 = 1u128 << 64;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Side {
    /// The vault sells base for quote.
    Ask,
    /// The vault buys base with quote.
    Bid,
}

/// One constant-product ladder segment.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Level {
    pub sqrt_lo: u128,
    pub sqrt_hi: u128,
    pub liquidity: u128,
}

impl Level {
    pub fn delta_sqrt(&self) -> MathResult<u128> {
        if self.sqrt_lo == 0 || self.sqrt_lo >= self.sqrt_hi || self.liquidity == 0 {
            return Err(MathError::Domain);
        }
        self.sqrt_hi
            .checked_sub(self.sqrt_lo)
            .ok_or(MathError::Overflow)
    }

    /// Base released by fully consuming the segment (ask output / bid input).
    pub fn base_capacity(&self) -> MathResult<u128> {
        let delta = self.delta_sqrt()?;
        let scaled = U256::mul_u128(self.liquidity, delta)
            .div_rem(U256::from_u128(self.sqrt_lo))
            .ok_or(MathError::DivideByZero)?
            .0
            .div_rem(U256::from_u128(self.sqrt_hi))
            .ok_or(MathError::DivideByZero)?
            .0;
        scaled.to_u128().ok_or(MathError::Overflow)
    }

    /// Quote released/consumed by fully consuming the segment.
    pub fn quote_capacity(&self) -> MathResult<u128> {
        let delta = self.delta_sqrt()?;
        U256::mul_u128(self.liquidity, delta)
            .shr(128)
            .to_u128()
            .ok_or(MathError::Overflow)
    }

    /// Maximum input of the appropriate side that stays within the segment.
    ///
    /// Rounds **up**, so a full fill is only granted once the trader has
    /// supplied at least the exact amount (vault-favouring direction).
    pub fn max_input(&self, side: Side) -> MathResult<u128> {
        let delta = self.delta_sqrt()?;
        let product = U256::mul_u128(self.liquidity, delta);
        let denominator = match side {
            Side::Ask => U256::ONE.shl(128),
            Side::Bid => U256::mul_u128(self.sqrt_lo, self.sqrt_hi),
        };
        ceil_div(product, denominator).and_then(|q| q.to_u128().ok_or(MathError::Overflow))
    }

    /// Liquidity implied by a base-side capacity on the ask side:
    /// `L = floor(capacity * lo * hi / (hi - lo))`.
    pub fn liquidity_for_base_capacity(
        sqrt_lo: u128,
        sqrt_hi: u128,
        capacity: u128,
    ) -> MathResult<u128> {
        let level = Level {
            sqrt_lo,
            sqrt_hi,
            liquidity: 1,
        };
        let delta = level.delta_sqrt()?;
        let cap_lo = U256::mul_u128(capacity, sqrt_lo);
        let cap_lo_hi = mul_u256_u128(cap_lo, sqrt_hi)?;
        let (quotient, _) = cap_lo_hi
            .div_rem(U256::from_u128(delta))
            .ok_or(MathError::DivideByZero)?;
        quotient.to_u128().ok_or(MathError::Overflow)
    }
}

/// Ceiling division on `U256`; returns `(numerator + denominator - 1) / denom`.
fn ceil_div(numerator: U256, denominator: U256) -> MathResult<U256> {
    if denominator.is_zero() {
        return Err(MathError::DivideByZero);
    }
    let adjusted = numerator
        .checked_add(&denominator.wrapping_sub(&U256::ONE))
        .ok_or(MathError::Overflow)?;
    adjusted
        .div_rem(denominator)
        .map(|(quotient, _)| quotient)
        .ok_or(MathError::DivideByZero)
}

/// Multiply a 256-bit value by a `u128`, checked at the 256-bit bound.
fn mul_u256_u128(a: U256, b: u128) -> MathResult<U256> {
    let p0 = mul_u256_u64(a, b as u64);
    let p1 = mul_u256_u64(a, (b >> 64) as u64).shl(64);
    p0.checked_add(&p1).ok_or(MathError::Overflow)
}

fn mul_u256_u64(a: U256, b: u64) -> U256 {
    let mut out = [0u64; 4];
    let mut carry = 0u128;
    let mut i = 0;
    while i < 4 {
        let product = a.0[i] as u128 * b as u128 + carry;
        out[i] = product as u64;
        carry = product >> 64;
        i += 1;
    }
    U256(out)
}

/// Result of walking a ladder side.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SwapResult {
    pub out: u128,
    pub consumed: usize,
    /// Input not absorbed because the ladder ran out of capacity.
    pub remaining: u128,
}

/// Walk a ladder for `amount_in` (quote for `Ask`, base for `Bid`).
pub fn walk_ladder(levels: &[Level], side: Side, amount_in: u128) -> MathResult<SwapResult> {
    if levels.is_empty() {
        return Err(MathError::Domain);
    }
    let mut remaining = amount_in;
    let mut out: u128 = 0;
    let mut consumed = 0usize;
    for level in levels {
        if remaining == 0 {
            break;
        }
        let max_in = level.max_input(side)?;
        let delta = level.delta_sqrt()?;
        if remaining >= max_in {
            // Full consumption, exact closed form.
            out = out
                .checked_add(match side {
                    Side::Ask => level.base_capacity()?,
                    Side::Bid => level.quote_capacity()?,
                })
                .ok_or(MathError::Overflow)?;
            remaining -= max_in;
            consumed += 1;
        } else {
            let partial = match side {
                Side::Ask => ask_partial(level, delta, remaining)?,
                Side::Bid => bid_partial(level, remaining)?,
            };
            out = out.checked_add(partial).ok_or(MathError::Overflow)?;
            remaining = 0;
        }
    }
    Ok(SwapResult {
        out,
        consumed,
        remaining,
    })
}

/// Ask partial: quote input `q` inside one segment starting at `sqrt_lo`.
fn ask_partial(level: &Level, delta_sqrt: u128, quote_in: u128) -> MathResult<u128> {
    // delta = floor(q * 2^128 / L)
    let number = U256::from_u128(quote_in).shl(128);
    let (delta, _) = number
        .div_rem(U256::from_u128(level.liquidity))
        .ok_or(MathError::DivideByZero)?;
    let delta = delta.to_u128().ok_or(MathError::Overflow)?;
    if delta > delta_sqrt {
        return Err(MathError::Domain);
    }
    let sqrt_p = level
        .sqrt_lo
        .checked_add(delta)
        .ok_or(MathError::Overflow)?;
    // out = floor(floor(L*delta / lo) / p)
    let (base, _) = U256::mul_u128(level.liquidity, delta)
        .div_rem(U256::from_u128(level.sqrt_lo))
        .ok_or(MathError::DivideByZero)?;
    let (base, _) = base
        .div_rem(U256::from_u128(sqrt_p))
        .ok_or(MathError::DivideByZero)?;
    base.to_u128().ok_or(MathError::Overflow)
}

/// Bid partial: base input `x` inside one segment starting at `sqrt_hi`.
fn bid_partial(level: &Level, base_in: u128) -> MathResult<u128> {
    // p' = ceil(hi*L / (L + x*hi)); ceiling keeps the vault from paying out
    // more quote than exact, since it pays quote on this side.
    let numerator = U256::mul_u128(level.sqrt_hi, level.liquidity);
    let x_hi = mul_u256_u128(U256::from_u128(base_in), level.sqrt_hi)?;
    let denominator = x_hi
        .checked_add(&U256::from_u128(level.liquidity))
        .ok_or(MathError::Overflow)?;
    let p = ceil_div(numerator, denominator)?
        .to_u128()
        .ok_or(MathError::Overflow)?;
    if p > level.sqrt_hi {
        return Err(MathError::Domain);
    }
    if p == level.sqrt_hi {
        return Ok(0);
    }
    // quote_out = floor(L*(hi - p) / 2^128)
    let diff = level.sqrt_hi.checked_sub(p).ok_or(MathError::Overflow)?;
    U256::mul_u128(level.liquidity, diff)
        .shr(128)
        .to_u128()
        .ok_or(MathError::Overflow)
}

/// Mean execution price (quote per base, Q64.64) = floor(out_quote * 2^64 / in_base).
pub fn mean_price_q64(quote_amount: u128, base_amount: u128) -> MathResult<u128> {
    if base_amount == 0 {
        return Err(MathError::DivideByZero);
    }
    let number = U256::from_u128(quote_amount).shl(64);
    let (price, _) = number
        .div_rem(U256::from_u128(base_amount))
        .ok_or(MathError::DivideByZero)?;
    price.to_u128().ok_or(MathError::Overflow)
}

/// First-deposit shares: `floor(sqrt(dB*dQ)) - min_liquidity`.
pub fn first_deposit_shares(
    deposit_base: u128,
    deposit_quote: u128,
    min_liquidity: u128,
) -> MathResult<u128> {
    if deposit_base == 0 || deposit_quote == 0 {
        return Err(MathError::Domain);
    }
    let product = U256::mul_u128(deposit_base, deposit_quote);
    let root = U256::isqrt(product).to_u128().ok_or(MathError::Overflow)?;
    root.checked_sub(min_liquidity).ok_or(MathError::Domain)
}

/// Later proportional deposit: `min(dB*S/B, dQ*S/Q)` with floor rounding.
pub fn deposit_shares(
    deposit_base: u128,
    deposit_quote: u128,
    reserve_base: u128,
    reserve_quote: u128,
    total_shares: u128,
) -> MathResult<u128> {
    if reserve_base == 0 || reserve_quote == 0 || total_shares == 0 {
        return Err(MathError::Domain);
    }
    let by_base = U256::mul_u128(deposit_base, total_shares)
        .div_rem(U256::from_u128(reserve_base))
        .ok_or(MathError::DivideByZero)?
        .0
        .to_u128()
        .ok_or(MathError::Overflow)?;
    let by_quote = U256::mul_u128(deposit_quote, total_shares)
        .div_rem(U256::from_u128(reserve_quote))
        .ok_or(MathError::DivideByZero)?
        .0
        .to_u128()
        .ok_or(MathError::Overflow)?;
    Ok(by_base.min(by_quote))
}

/// Proportional withdrawal: floor shares against each reserve.
pub fn withdrawal_amounts(
    shares: u128,
    reserve_base: u128,
    reserve_quote: u128,
    total_shares: u128,
) -> MathResult<(u128, u128)> {
    if total_shares == 0 || shares > total_shares {
        return Err(MathError::Domain);
    }
    let base = U256::mul_u128(shares, reserve_base)
        .div_rem(U256::from_u128(total_shares))
        .ok_or(MathError::DivideByZero)?
        .0
        .to_u128()
        .ok_or(MathError::Overflow)?;
    let quote = U256::mul_u128(shares, reserve_quote)
        .div_rem(U256::from_u128(total_shares))
        .ok_or(MathError::DivideByZero)?
        .0
        .to_u128()
        .ok_or(MathError::Overflow)?;
    Ok((base, quote))
}

/// Trading fee: `ceil(amount_in * fee_bps / 10_000)`.
pub fn fee_amount(amount_in: u128, fee_bps: u128) -> MathResult<u128> {
    let product = amount_in.checked_mul(fee_bps).ok_or(MathError::Overflow)?;
    let fee = product / BPS_DENOMINATOR;
    if product % BPS_DENOMINATOR == 0 {
        Ok(fee)
    } else {
        fee.checked_add(1).ok_or(MathError::Overflow)
    }
}

/// Helper retained for callers that only need the plain integer floor root.
pub fn isqrt(value: u128) -> u128 {
    isqrt_u128(value)
}
