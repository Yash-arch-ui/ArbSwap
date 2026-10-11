#![no_main]
//! Fuzz the pure fixed-point primitives: sqrt_q64, mul_div, mul_q64.
//!
//! Invariants: no panic (overflow-checks are on in the release profile), and
//! the floored square root never overestimates (`mul_q64(sqrt(x), sqrt(x)) <= x`).

use libfuzzer_sys::fuzz_target;

fn u128_of(b: &[u8]) -> u128 {
    let mut v = [0u8; 16];
    for (i, x) in b.iter().take(16).enumerate() {
        v[i] = *x;
    }
    u128::from_le_bytes(v)
}

fuzz_target!(|data: &[u8]| {
    if data.len() < 32 {
        return;
    }
    let a = u128_of(&data[..16]);
    let b = u128_of(&data[16..32]);

    if let Ok(root) = arb_math::sqrt_q64(a) {
        if let Ok(squared) = arb_math::mul_q64(root, root) {
            assert!(squared <= a, "sqrt_q64 overestimates: {squared} > {a}");
        }
    }
    let _ = arb_math::mul_div_floor(a, b, b);
    let _ = arb_math::mul_div_ceil(a, b, b.max(1));
    let _ = arb_math::mul_div_floor(a, b, b.saturating_add(1));
    let _ = arb_math::mul_q64(a, b);
    let _ = arb_math::wide::U256::mul_u128(a, b).to_u128();
});
