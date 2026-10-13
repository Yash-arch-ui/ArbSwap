//! S2-18 frozen-math regression for the quote-liveness work.
//!
//! These pin deterministic reference values derived from the **deployed v18
//! QuoteState** (`anchor_sqrt_price = 6036613448307627517`) and a devnet
//! SOL/USDC Pyth observation. The quote-liveness changes (anchor clamping and
//! expired-quote re-anchoring) are guard/logic changes only and must not alter
//! any of these values. If one of these fails, a frozen invariant was changed.

use arb_math::{mul_div_ceil, mul_div_floor, price_from_sqrt, sqrt_q64};

/// Deployed QuoteState v18 `anchor_sqrt_price`.
const V18_ANCHOR_SQRT: u128 = 6_036_613_448_307_627_517;
/// `price_from_sqrt(V18_ANCHOR_SQRT)` (stored `oracle_price` of v18).
const V18_ANCHOR_PRICE: u128 = 1_975_454_409_660_514_979;
/// 150.0 USDC/SOL normalized to token units for a 9/6 pair.
const NORMALIZED_9_6_Q64: u128 = 2_767_011_611_056_432_742;

#[test]
fn v18_anchor_price_is_frozen() {
    assert_eq!(price_from_sqrt(V18_ANCHOR_SQRT).unwrap(), V18_ANCHOR_PRICE);
    // The floor round-trip is lossy by construction and must never round up.
    let round_trip = sqrt_q64(V18_ANCHOR_PRICE).unwrap();
    assert_eq!(round_trip, 6_036_613_448_307_627_515);
    assert!(round_trip <= V18_ANCHOR_SQRT);
}

#[test]
fn nine_six_normalization_reference_is_frozen() {
    // 150.0 USDC/SOL, base 9 / quote 6 => floor(150e-3 * 2^64).
    assert_eq!(
        mul_div_floor(150u128 << 64, 1, 1_000).unwrap(),
        NORMALIZED_9_6_Q64
    );
    // sqrt -> price round-trips to within one atom (never above the target).
    let s = sqrt_q64(NORMALIZED_9_6_Q64).unwrap();
    let p = price_from_sqrt(s).unwrap();
    assert!(p <= NORMALIZED_9_6_Q64);
    assert!(p + 1 >= NORMALIZED_9_6_Q64);
}

#[test]
fn anchor_price_from_150_sqrt_is_frozen() {
    // `anchor_ladder`'s reference anchor for a 150 USDC vault.
    assert_eq!(
        price_from_sqrt(225_887_000_000_000_000_000).unwrap(),
        2_766_067_364_794_264_765_714
    );
}

#[test]
fn rounding_rules_are_unchanged() {
    assert_eq!(mul_div_floor(10, 1, 3).unwrap(), 3);
    assert_eq!(mul_div_ceil(10, 1, 3).unwrap(), 4);
}
