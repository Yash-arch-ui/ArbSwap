//! Golden and property tests for the canonical EWMA volatility / jump module.
//! See `docs/VOLATILITY_MATH_SPEC.md`.

use arb_math::volatility::{
    return_q64, sigma_short_q64, steps_from_millis, update, update_with_dt, VolatilityState, BPS,
    DEFAULT_JUMP_MULTIPLE, DEFAULT_LAMBDA_MEDIUM_BPS, DEFAULT_LAMBDA_SHORT_BPS, MAX_EWMA_STEPS,
};
use arb_math::Q64;

/// One-percent price step from a 1.0 baseline.
fn one_percent_up() -> (u128, u128) {
    let prev = Q64;
    let pct = Q64 / 100;
    (prev, prev + pct)
}

#[test]
fn first_observation_seeds_price_without_variance() {
    let next = update(
        VolatilityState::default(),
        Q64,
        DEFAULT_LAMBDA_SHORT_BPS,
        DEFAULT_LAMBDA_MEDIUM_BPS,
        DEFAULT_JUMP_MULTIPLE,
    )
    .unwrap();
    assert_eq!(next.last_price_q64, Q64);
    assert_eq!(next.variance_short_q64, 0);
    assert_eq!(next.variance_medium_q64, 0);
    assert!(!next.jump);
}

#[test]
fn return_is_absolute_simple_q64() {
    let (prev, up) = one_percent_up();
    let expected = Q64 / 100; // floor(Q64/100), the return relative to `prev`
    assert_eq!(return_q64(prev, up).unwrap(), expected);
    // The reverse return is relative to `up`, so it is strictly smaller.
    let down = return_q64(up, prev).unwrap();
    assert!(down > 0 && down < expected);
    assert_eq!(return_q64(prev, prev).unwrap(), 0);
    assert!(return_q64(0, up).is_err());
}

#[test]
fn flat_price_keeps_zero_variance_and_no_jump() {
    let s = update(
        VolatilityState::default(),
        Q64,
        DEFAULT_LAMBDA_SHORT_BPS,
        DEFAULT_LAMBDA_MEDIUM_BPS,
        DEFAULT_JUMP_MULTIPLE,
    )
    .unwrap();
    let s = update(
        s,
        Q64,
        DEFAULT_LAMBDA_SHORT_BPS,
        DEFAULT_LAMBDA_MEDIUM_BPS,
        DEFAULT_JUMP_MULTIPLE,
    )
    .unwrap();
    assert_eq!(s.variance_short_q64, 0);
    assert_eq!(s.variance_medium_q64, 0);
    assert!(!s.jump);
}

#[test]
fn single_percent_move_from_flat_flags_then_clears() {
    let s = update(
        VolatilityState::default(),
        Q64,
        DEFAULT_LAMBDA_SHORT_BPS,
        DEFAULT_LAMBDA_MEDIUM_BPS,
        DEFAULT_JUMP_MULTIPLE,
    )
    .unwrap();
    let (_, up) = one_percent_up();
    let s = update(
        s,
        up,
        DEFAULT_LAMBDA_SHORT_BPS,
        DEFAULT_LAMBDA_MEDIUM_BPS,
        DEFAULT_JUMP_MULTIPLE,
    )
    .unwrap();
    assert!(s.variance_short_q64 > 0);
    assert!(s.jump, "a 1% jump off a zero-variance base must flag");

    // A second, unchanged price has zero return and clears the flag while the
    // variance decays (is not reset).
    let s2 = update(
        s,
        up,
        DEFAULT_LAMBDA_SHORT_BPS,
        DEFAULT_LAMBDA_MEDIUM_BPS,
        DEFAULT_JUMP_MULTIPLE,
    )
    .unwrap();
    assert!(s2.variance_short_q64 > 0);
    assert!(s2.variance_short_q64 < s.variance_short_q64);
    assert!(!s2.jump);
}

#[test]
fn medium_lambda_decays_slower_than_short() {
    let (_, up) = one_percent_up();
    let s = update(
        VolatilityState::default(),
        Q64,
        DEFAULT_LAMBDA_SHORT_BPS,
        DEFAULT_LAMBDA_MEDIUM_BPS,
        DEFAULT_JUMP_MULTIPLE,
    )
    .unwrap();
    let s = update(
        s,
        up,
        DEFAULT_LAMBDA_SHORT_BPS,
        DEFAULT_LAMBDA_MEDIUM_BPS,
        DEFAULT_JUMP_MULTIPLE,
    )
    .unwrap();
    // From a zero base the medium series reacts less (1-lambda is smaller).
    assert!(s.variance_medium_q64 < s.variance_short_q64);

    // On a flat step (innovation 0) the medium series decays slower: it keeps
    // a larger fraction of its previous variance.
    let flat = update(
        s,
        up,
        DEFAULT_LAMBDA_SHORT_BPS,
        DEFAULT_LAMBDA_MEDIUM_BPS,
        DEFAULT_JUMP_MULTIPLE,
    )
    .unwrap();
    // retained fraction (scaled by 10_000) for each series
    let keep_short = flat.variance_short_q64 * 10_000 / s.variance_short_q64;
    let keep_medium = flat.variance_medium_q64 * 10_000 / s.variance_medium_q64;
    assert!(keep_medium > keep_short);
}

#[test]
fn sigma_is_sqrt_of_short_variance() {
    let (_, up) = one_percent_up();
    let s = update(
        VolatilityState::default(),
        Q64,
        DEFAULT_LAMBDA_SHORT_BPS,
        DEFAULT_LAMBDA_MEDIUM_BPS,
        DEFAULT_JUMP_MULTIPLE,
    )
    .unwrap();
    let s = update(
        s,
        up,
        DEFAULT_LAMBDA_SHORT_BPS,
        DEFAULT_LAMBDA_MEDIUM_BPS,
        DEFAULT_JUMP_MULTIPLE,
    )
    .unwrap();
    let sigma = sigma_short_q64(s).unwrap();
    // sigma ~= 0.002449; assert within 1% of the analytic value.
    let analytic = (Q64 as f64) * (s.variance_short_q64 as f64 / Q64 as f64).sqrt();
    let diff = (sigma as f64 - analytic).abs();
    assert!(diff / analytic < 0.01, "sigma {sigma} vs {analytic}");
}

#[test]
fn step_count_rounds_and_caps() {
    assert_eq!(steps_from_millis(0, MAX_EWMA_STEPS), 1);
    assert_eq!(steps_from_millis(400, MAX_EWMA_STEPS), 1);
    assert_eq!(steps_from_millis(1_000, MAX_EWMA_STEPS), 1);
    assert_eq!(steps_from_millis(1_500, MAX_EWMA_STEPS), 2);
    assert_eq!(steps_from_millis(2_400, MAX_EWMA_STEPS), 2);
    assert_eq!(steps_from_millis(u64::MAX, MAX_EWMA_STEPS), MAX_EWMA_STEPS);
}

#[test]
fn large_gap_is_bounded_and_does_not_divide_by_zero() {
    let (_, up) = one_percent_up();
    let s = update(
        VolatilityState::default(),
        Q64,
        DEFAULT_LAMBDA_SHORT_BPS,
        DEFAULT_LAMBDA_MEDIUM_BPS,
        DEFAULT_JUMP_MULTIPLE,
    )
    .unwrap();
    // dt far beyond the cap: decay is bounded, still finite and non-negative.
    let s = update_with_dt(
        s,
        up,
        u64::MAX,
        DEFAULT_LAMBDA_SHORT_BPS,
        DEFAULT_LAMBDA_MEDIUM_BPS,
        DEFAULT_JUMP_MULTIPLE,
        MAX_EWMA_STEPS,
    )
    .unwrap();
    assert!(s.variance_short_q64 > 0);
}

#[test]
fn zero_price_is_rejected() {
    assert!(update(
        VolatilityState::default(),
        0,
        DEFAULT_LAMBDA_SHORT_BPS,
        DEFAULT_LAMBDA_MEDIUM_BPS,
        DEFAULT_JUMP_MULTIPLE
    )
    .is_err());
}

#[test]
fn overflow_is_rejected_not_wrapped() {
    let s = VolatilityState {
        last_price_q64: 1,
        ..Default::default()
    };
    // diff << 64 / 1 overflows u128 -> checked error.
    assert!(update(
        s,
        u128::MAX,
        DEFAULT_LAMBDA_SHORT_BPS,
        DEFAULT_LAMBDA_MEDIUM_BPS,
        DEFAULT_JUMP_MULTIPLE
    )
    .is_err());
}

#[test]
fn jump_multiple_scales_the_threshold() {
    let (_, up) = one_percent_up();
    let seed = update(
        VolatilityState::default(),
        Q64,
        DEFAULT_LAMBDA_SHORT_BPS,
        DEFAULT_LAMBDA_MEDIUM_BPS,
        DEFAULT_JUMP_MULTIPLE,
    )
    .unwrap();
    // A very large multiple suppresses the jump; a tiny one forces it.
    let big = update(
        seed,
        up,
        DEFAULT_LAMBDA_SHORT_BPS,
        DEFAULT_LAMBDA_MEDIUM_BPS,
        1_000,
    )
    .unwrap();
    let small = update(
        seed,
        up,
        DEFAULT_LAMBDA_SHORT_BPS,
        DEFAULT_LAMBDA_MEDIUM_BPS,
        1,
    )
    .unwrap();
    assert!(!big.jump);
    assert!(small.jump);
}

#[test]
fn determinism_identical_inputs_identical_state() {
    let (_, up) = one_percent_up();
    let run = || {
        let s = update(
            VolatilityState::default(),
            Q64,
            DEFAULT_LAMBDA_SHORT_BPS,
            DEFAULT_LAMBDA_MEDIUM_BPS,
            DEFAULT_JUMP_MULTIPLE,
        )
        .unwrap();
        update(
            s,
            up,
            DEFAULT_LAMBDA_SHORT_BPS,
            DEFAULT_LAMBDA_MEDIUM_BPS,
            DEFAULT_JUMP_MULTIPLE,
        )
        .unwrap()
    };
    assert_eq!(run(), run());
}

#[test]
fn pow_bps_matches_repeated_decay() {
    // lambda^n in bps, truncating at each step.
    let mut expect: u128 = BPS;
    for n in 0..=10u32 {
        assert_eq!(
            arb_math::volatility::pow_bps(9_400, n).unwrap() as u128,
            expect
        );
        expect = expect * 9_400 / BPS;
    }
}
