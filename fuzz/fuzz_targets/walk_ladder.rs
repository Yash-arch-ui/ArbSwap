#![no_main]
//! Fuzz `walk_ladder`: arbitrary ladders and amounts must never panic, and the
//! input not absorbed must not exceed the input.

use arb_math::{walk_ladder, Level, Side};
use libfuzzer_sys::fuzz_target;

fn u128_of(b: &[u8]) -> u128 {
    let mut v = [0u8; 16];
    for (i, x) in b.iter().take(16).enumerate() {
        v[i] = *x;
    }
    u128::from_le_bytes(v)
}

fuzz_target!(|data: &[u8]| {
    if data.len() < 1 + 32 + 16 {
        return;
    }
    let n = (data[0] as usize % 8) + 1;
    let mut levels = Vec::new();
    let mut off = 1usize;
    for _ in 0..n {
        if off + 32 > data.len() {
            break;
        }
        let lo = u128_of(&data[off..off + 16]).max(1);
        let raw_hi = u128_of(&data[off + 16..off + 32]);
        let hi = raw_hi.max(lo.saturating_add(1));
        levels.push(Level {
            sqrt_lo: lo,
            sqrt_hi: hi,
            liquidity: u128_of(&data[off..off + 16]).max(1),
        });
        off += 32;
    }
    if levels.is_empty() {
        return;
    }
    let amount = u128_of(&data[off.min(data.len() - 1)..]);
    for side in [Side::Ask, Side::Bid] {
        if let Ok(result) = walk_ladder(&levels, side, amount) {
            assert!(
                result.remaining <= amount,
                "ladder absorbed more than the input"
            );
        }
    }
});
