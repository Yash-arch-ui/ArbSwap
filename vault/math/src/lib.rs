//! ArbSwap math core (`arb-math`).
//!
//! Pure, checked, fixed-point math shared bit-exactly by the on-chain program,
//! the keeper, and the simulator (Build Plan §0 rule 2 and §4). No Solana
//! dependencies, so this crate is testable natively and fuzzable.
//!
//! Module map:
//! - [`wide`]: the minimal 256-bit helpers needed for exact Q64.64 arithmetic.
//! - [`fixed`]: Q64.64 primitives (exact `sqrt_q64`, `mul_q64`, `recip_q64`, …).
//! - [`quote`]: the integer ladder walk, fees, and vault share math.
//!
//! Rounding rule (Build Plan §5.2): amounts the vault pays out round DOWN;
//! amounts the vault receives round UP. Never the reverse.

pub mod fixed;
pub mod quote;
pub mod wide;

pub use fixed::{
    ceil_bps, div_q64, mul_bps, mul_q64, one_plus_q64, price_from_sqrt, recip_q64, sqrt_from_price,
    sqrt_price_scaled, sqrt_q64, tdiv, MathError, MathResult, BPS_DENOMINATOR as FIXED_BPS, Q64,
};
pub use quote::{
    deposit_shares, fee_amount, first_deposit_shares, mean_price_q64, walk_ladder,
    withdrawal_amounts, Level, Side, SwapResult,
};

/// Basis-point denominator: 1 bps = 1/10,000.
pub const BPS_DENOMINATOR: u128 = 10_000;

/// Checked floor((a * b) / c). Returns None on overflow or c == 0.
pub fn mul_div_floor(a: u128, b: u128, c: u128) -> Option<u128> {
    if c == 0 {
        return None;
    }
    a.checked_mul(b)?.checked_div(c)
}

/// Checked ceil((a * b) / c). Returns None on overflow or c == 0.
pub fn mul_div_ceil(a: u128, b: u128, c: u128) -> Option<u128> {
    if c == 0 {
        return None;
    }
    let p = a.checked_mul(b)?;
    let q = p / c;
    if p % c == 0 {
        Some(q)
    } else {
        q.checked_add(1)
    }
}

/// Add `bps` of `amount`, rounding in the vault's favor:
/// `round_up == true` when the vault receives, `false` when it pays out.
pub fn add_bps(amount: u128, bps: u32, round_up: bool) -> Option<u128> {
    let scaled = amount.checked_mul(bps as u128)?;
    let part = if round_up {
        mul_div_ceil(scaled, 1, BPS_DENOMINATOR)?
    } else {
        mul_div_floor(scaled, 1, BPS_DENOMINATOR)?
    };
    amount.checked_add(part)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn floor_and_ceil_agree_on_exact_division() {
        assert_eq!(mul_div_floor(9, 3, 3), Some(9));
        assert_eq!(mul_div_ceil(9, 3, 3), Some(9));
        assert_eq!(mul_div_floor(12, 5, 4), Some(15));
        assert_eq!(mul_div_ceil(12, 5, 4), Some(15));
    }

    #[test]
    fn ceil_rounds_up_only_when_needed() {
        assert_eq!(mul_div_ceil(10, 1, 3), Some(4));
        assert_eq!(mul_div_floor(10, 1, 3), Some(3));
    }

    #[test]
    fn division_by_zero_is_checked() {
        assert_eq!(mul_div_floor(1, 1, 0), None);
        assert_eq!(mul_div_ceil(1, 1, 0), None);
    }

    #[test]
    fn overflow_is_checked() {
        assert_eq!(mul_div_floor(u128::MAX, 2, 1), None);
    }

    #[test]
    fn bps_rounding_favors_the_vault() {
        assert_eq!(add_bps(1_000_000, 1, true), Some(1_000_100));
        assert_eq!(add_bps(1_000_001, 1, true), Some(1_000_102));
        assert_eq!(add_bps(1_000_001, 1, false), Some(1_000_101));
    }
}
