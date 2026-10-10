//! C3/B2 differential: the inverse-sqrt capacity (multiply+shift) must never
//! **under-estimate** the exact `floor(L*Δ/(lo*hi))`, so the on-chain
//! utilization cap stays at least as strict after the redesign.

use arb_math::quote::{
    base_capacity_from_inverse_sqrts, inv_sqrt_is_conservative, inv_sqrt_q64_ceil, Level,
};

fn lcg(state: &mut u128) -> u128 {
    *state = state
        .wrapping_mul(6364136223846793005)
        .wrapping_add(1442695040888963407);
    *state
}

#[test]
fn inverse_capacity_over_estimates_the_exact_one() {
    let mut state = 0x1234_5678_9abc_def0_u128;
    let mut checked = 0u64;
    for _ in 0..1_000_000 {
        let liquidity = (lcg(&mut state) % (1u128 << 60)) + 1;
        let sqrt_lo = (lcg(&mut state) % (1u128 << 90)) + 1;
        let delta = (lcg(&mut state) % (1u128 << 60)) + 1;
        let sqrt_hi = sqrt_lo.saturating_add(delta);
        if sqrt_hi <= sqrt_lo {
            continue;
        }
        let exact = Level {
            sqrt_lo,
            sqrt_hi,
            liquidity,
        }
        .base_capacity()
        .expect("exact capacity");
        let inv_lo = inv_sqrt_q64_ceil(sqrt_lo).expect("inv lo");
        let inv_hi = inv_sqrt_q64_ceil(sqrt_hi).expect("inv hi");
        assert!(inv_sqrt_is_conservative(sqrt_lo, inv_lo));
        assert!(inv_sqrt_is_conservative(sqrt_hi, inv_hi));
        let est = base_capacity_from_inverse_sqrts(liquidity, sqrt_lo, sqrt_hi, inv_lo, inv_hi)
            .expect("estimate");
        assert!(
            est >= exact,
            "under-estimate: est {est} < exact {exact} (lo {sqrt_lo} hi {sqrt_hi} L {liquidity})"
        );
        assert!(
            est <= exact + exact / 1_000 + 2,
            "too loose: est {est} vs exact {exact}"
        );
        checked += 1;
    }
    assert!(checked > 900_000, "only checked {checked}");
}

#[test]
fn a_halved_inverse_is_rejected_as_an_under_estimate() {
    let sqrt_lo = (1u128 << 70) + 12345;
    let inv = inv_sqrt_q64_ceil(sqrt_lo).expect("inv");
    assert!(inv_sqrt_is_conservative(sqrt_lo, inv));
    // Half the (already rounded-up) inverse is clearly below 1/sqrt.
    assert!(!inv_sqrt_is_conservative(sqrt_lo, inv / 2));
}
