//! S1 regression: `U256::div_rem` for a 3-limb divisor, plus the exact
//! deep-ladder capacity values that were once suspected of exposing a bug.
//! Python big-integer arithmetic gives the expected values.

use arb_math::wide::U256;

#[test]
fn div_rem_three_limb_divisor_is_exact() {
    // b = 2^128 + 1 = limbs [1,0,1,0]; a = 2^64 + 3; product = a*b = [3,1,3,1].
    let b = U256([1, 0, 1, 0]);
    let a = U256([3, 1, 0, 0]);
    let product = U256([3, 1, 3, 1]);
    let (q, r) = product.div_rem(b).expect("div");
    assert_eq!(q, a);
    assert_eq!(r, U256::ZERO);
}

#[test]
fn div_rem_four_limb_divisor_is_exact() {
    // b = 2^192 + 2^64 + 1 = [1,1,0,1]; 5*b = [5,5,0,5].
    let b = U256([1, 1, 0, 1]);
    let product = U256([5, 5, 0, 5]);
    let (q, r) = product.div_rem(b).expect("div");
    assert_eq!(q, U256([5, 0, 0, 0]));
    assert_eq!(r, U256::ZERO);
}

#[test]
fn deep_ladder_capacity_single_and_two_division_agree() {
    // Exact values from a deep ask level (capacity 2e8). Python: both forms
    // give 44_999_999 and reconstruct to the numerator.
    let lo = 225_959_406_648_169_442_990u128;
    let hi = 225_981_985_654_635_812_551u128;
    let liquidity = 101_768_162_210_718_044_289_271_229_777_164u128;
    let delta = hi - lo;

    let numerator = U256::mul_u128(liquidity, delta);
    let denominator = U256::mul_u128(lo, hi);
    let (q_single, r_single) = numerator.div_rem(denominator).expect("div");
    let two = numerator
        .div_rem(U256::from_u128(lo))
        .unwrap()
        .0
        .div_rem(U256::from_u128(hi))
        .unwrap()
        .0;
    assert_eq!(q_single.to_u128(), Some(44_999_999));
    assert_eq!(two.to_u128(), Some(44_999_999));
    // The remainder is what Python reports: numerator - 44_999_999*denominator.
    assert_eq!(
        r_single.0,
        [1_290_940_021_874_540_782, 1_105_905_382_237_743_882, 150, 0,]
    );
}
