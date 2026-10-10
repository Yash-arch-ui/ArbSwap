#![no_main]
//! Fuzz the keeper's quote validation/computation: arbitrary `QuoteUpdate`
//! payloads run through `prevalidate_quote` and `compute_quote` must never
//! panic. `prevalidate_quote` is the offline mirror of the on-chain checks.

use arb_math::quote::Level;
use arbswap_keeper::{
    compute_quote, prevalidate_quote, KeeperParams, OracleTick, PrevalidateBounds, QuoteUpdate,
    VolatilityState, LEVELS,
};
use libfuzzer_sys::fuzz_target;

fn u128_of(b: &[u8]) -> u128 {
    let mut v = [0u8; 16];
    for (i, x) in b.iter().take(16).enumerate() {
        v[i] = *x;
    }
    u128::from_le_bytes(v)
}

fn u64_of(b: &[u8]) -> u64 {
    let mut v = [0u8; 8];
    for (i, x) in b.iter().take(8).enumerate() {
        v[i] = *x;
    }
    u64::from_le_bytes(v)
}

fuzz_target!(|data: &[u8]| {
    if data.len() < 96 {
        return;
    }
    let mut update = QuoteUpdate {
        slot: u64_of(&data[..8]),
        publish_time: u64_of(&data[8..16]) as i64,
        oracle_price_q64: u128_of(&data[16..32]),
        confidence_bps: u64_of(&data[32..40]) as u32,
        anchor_sqrt_price: u128_of(&data[40..56]),
        reservation_sqrt_price: u128_of(&data[56..72]),
        half_spread_bps: u64_of(&data[72..80]) as u32,
        ask_extra_bps: u64_of(&data[80..88]) as u32,
        bid_extra_bps: u64_of(&data[88..96]) as u32,
        depth_mult_bps: u64_of(&data[..8]) as u32,
        ask_levels: [Level { sqrt_lo: 0, sqrt_hi: 0, liquidity: 0 }; LEVELS],
        bid_levels: [Level { sqrt_lo: 0, sqrt_hi: 0, liquidity: 0 }; LEVELS],
        offsets_bps: [u64_of(&data[..8]) as u32; LEVELS],
        weights_bps: [u64_of(&data[8..16]) as u32; LEVELS],
    };
    // Also exercise a filled (non-default) level so the bounds/capacity paths
    // are reached, not only the early rejects.
    let lo = u128_of(&data[16..32]).max(1);
    update.ask_levels[0] = Level {
        sqrt_lo: lo,
        sqrt_hi: lo.saturating_add(u128_of(&data[40..56]).max(1)),
        liquidity: u128_of(&data[56..72]).max(1),
    };

    let _ = prevalidate_quote(&update, &PrevalidateBounds::default());

    let tick = OracleTick {
        slot: update.slot,
        publish_time: update.publish_time,
        price_q64: update.oracle_price_q64.max(1),
        confidence_bps: update.confidence_bps,
    };
    let _ = compute_quote(
        tick,
        VolatilityState::default(),
        1_000_000_000_000,
        150_000_000_000_000,
        0,
        0,
        KeeperParams::default(),
    );
});
