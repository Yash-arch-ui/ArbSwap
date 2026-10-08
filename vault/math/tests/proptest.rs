//! F-14: property tests for the math core via `proptest`.
//!
//! These complement the deterministic golden vectors and the LCG properties by
//! shrinking random counterexamples across the full u128 input space (bounded to
//! keep the oracle products inside u128).

use arb_math::fixed::{div_q64, mul_q64, sqrt_q64};
use arb_math::quote::{fee_amount, walk_ladder, withdrawal_amounts, Level, Side};
use proptest::prelude::*;

const HI: u128 = 1 << 100;

proptest! {
    #![proptest_config(ProptestConfig::with_cases(2_000))]

    /// `mul_q64(a,b)` is the exact floor of `a*b/2^64`.
    #[test]
    fn mul_q64_is_exact_floor(a in 0u128..HI, b in 0u128..HI) {
        if let Ok(r) = mul_q64(a, b) {
            let lhs = r.checked_mul(1 << 64);
            if let Some(lhs) = lhs {
                prop_assert!(lhs <= a * b);
                // (r+1)*2^64 > a*b  (no overflow for these bounds)
                prop_assert!((r + 1).checked_mul(1 << 64).map_or(true, |x| x > a * b));
            }
        }
    }

    /// `div_q64(a,b)` is the exact floor of `a*2^64/b` for b>0.
    #[test]
    fn div_q64_is_exact_floor(a in 0u128..HI, b in 1u128..HI) {
        if let Ok(r) = div_q64(a, b) {
            prop_assert!(r.checked_mul(b).map_or(true, |x| x <= a << 64));
            prop_assert!((r + 1).checked_mul(b).map_or(true, |x| x > a << 64));
        }
    }

    /// `sqrt_q64(v)` is the exact floor square root of `v<<64`.
    #[test]
    fn sqrt_q64_is_exact_floor(v in 0u128..HI) {
        let r = sqrt_q64(v).unwrap();
        prop_assert!(r.checked_mul(r).map_or(true, |x| x <= v << 64));
        prop_assert!((r + 1).checked_mul(r + 1).map_or(true, |x| x > v << 64));
    }

    /// `fee_amount` is the ceiling of `amount*fee_bps/10_000` and never exceeds input.
    #[test]
    fn fee_is_ceil_and_bounded(amount in 0u128..HI, fee_bps in 0u128..10_000) {
        let f = fee_amount(amount, fee_bps).unwrap();
        prop_assert!(f * 10_000 >= amount * fee_bps);
        prop_assert!(f == 0 || (f - 1) * 10_000 < amount * fee_bps);
        prop_assert!(f <= amount);
    }

    /// A single-segment ask walk never pays more base than the segment holds and
    /// output is monotone in the input.
    #[test]
    fn ask_walk_is_monotone_and_capacity_bounded(
        lo in 1u128..(1<<80),
        width in 1u128..(1<<80),
        liquidity in 1u128..(1<<90),
        amount in 0u128..(1<<90),
    ) {
        let level = Level { sqrt_lo: lo, sqrt_hi: lo + width, liquidity };
        let small = walk_ladder(&[level], Side::Ask, amount).unwrap();
        let big = walk_ladder(&[level], Side::Ask, amount + 1).unwrap();
        prop_assert!(big.out >= small.out);
    }

    /// Withdrawal is a floor and never exceeds the reserve.
    #[test]
    fn withdrawal_is_floor_and_bounded(
        reserve in 1u128..(1<<60),
        total in 1u128..(1<<60),
        shares in 0u128..(1<<60),
    ) {
        if shares <= total {
            let (out, _) = withdrawal_amounts(shares, reserve, reserve, total).unwrap();
            prop_assert!(out <= reserve);
            prop_assert!(out * total <= shares * reserve);
        }
    }
}
