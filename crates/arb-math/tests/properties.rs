//! Property and adversarial tests for `arb-math` (P1).
//!
//! Uses a tiny deterministic LCG so there are no external dependencies and the
//! same samples run everywhere. These assert the invariants that make the core
//! safe: no value creation on a round trip, capacity is respected, rounding
//! favours the vault, and the square root is exact.

use core::cmp::Ordering;

use arb_math::fixed::{ceil_bps, mul_bps, mul_q64, recip_q64, sqrt_q64, Q64};
use arb_math::quote::{walk_ladder, Level, Side};
use arb_math::wide::U256;

struct Lcg(u64);

impl Lcg {
    fn next(&mut self) -> u64 {
        self.0 = self
            .0
            .wrapping_mul(6364136223846793005)
            .wrapping_add(1442695040888963407);
        self.0 >> 11
    }

    fn range(&mut self, lower: u128, upper: u128) -> u128 {
        assert!(upper > lower);
        lower + (self.next() as u128) % (upper - lower)
    }
}

fn levels(rng: &mut Lcg) -> Level {
    let price = rng.range(20 * Q64, 400 * Q64);
    let lo = sqrt_q64(price).unwrap();
    let hi = lo + rng.range(Q64 / 100, Q64);
    Level {
        sqrt_lo: lo,
        sqrt_hi: hi,
        liquidity: rng.range(1_000_000_000_000_000_000, 1_000_000_000_000_000_000_000_000),
    }
}

fn le(a: U256, b: U256) -> bool {
    a.cmp(&b) != Ordering::Greater
}

#[test]
fn sqrt_is_the_exact_floor() {
    let mut rng = Lcg(1);
    for _ in 0..2_000 {
        let value = rng.range(0, 1u128 << 120);
        let root = sqrt_q64(value).unwrap();
        let radicand = U256::from_u128(value).shl(64);
        let square = U256::mul_u128(root, root);
        assert!(le(square, radicand), "root too large for {value}");
        let next = root.checked_add(1).unwrap();
        let next_square = U256::mul_u128(next, next);
        assert!(!le(next_square, radicand), "root too small for {value}");
    }
}

#[test]
fn mul_q64_is_bounded_by_each_operand_below_one() {
    let mut rng = Lcg(2);
    for _ in 0..2_000 {
        let a = rng.range(0, 1u128 << 100);
        let b = rng.range(0, Q64);
        let product = mul_q64(a, b).unwrap();
        assert!(
            product <= a || a == 0,
            "mul_q64 by <=1 must not grow {a} by {b}"
        );
    }
}

#[test]
fn recip_is_the_floor_inverse() {
    let mut rng = Lcg(3);
    for _ in 0..1_000 {
        let s = rng.range(2, 1u128 << 100);
        let r = recip_q64(s).unwrap();
        // s * r <= 2^128 < s * (r + 1)
        let lhs = U256::mul_u128(s, r);
        let two_128 = U256::ONE.shl(128);
        assert!(le(lhs, two_128));
        let rhs = U256::mul_u128(s, r + 1);
        assert!(!le(rhs, two_128), "recip not maximal for {s}");
    }
}

#[test]
fn ask_walk_is_monotonic_and_capacity_bounded() {
    let mut rng = Lcg(4);
    for _ in 0..500 {
        let level = levels(&mut rng);
        let capacity = level.base_capacity().unwrap();
        let mut previous = 0u128;
        for step in 1..=10u128 {
            let amount = U256::mul_u128(level.quote_capacity().unwrap(), step)
                .div_rem(U256::from_u128(10))
                .unwrap()
                .0
                .to_u128()
                .unwrap();
            let out = walk_ladder(&[level], Side::Ask, amount).unwrap().out;
            assert!(out >= previous, "ask output must not decrease");
            assert!(out <= capacity + 1, "ask output exceeded capacity");
            previous = out;
        }
    }
}

#[test]
fn bid_walk_is_monotonic_and_capacity_bounded() {
    let mut rng = Lcg(5);
    for _ in 0..500 {
        let level = levels(&mut rng);
        let capacity = level.quote_capacity().unwrap();
        let mut previous = 0u128;
        for step in 1..=10u128 {
            let amount = U256::mul_u128(level.base_capacity().unwrap(), step)
                .div_rem(U256::from_u128(10))
                .unwrap()
                .0
                .to_u128()
                .unwrap();
            let out = walk_ladder(&[level], Side::Bid, amount).unwrap().out;
            assert!(out >= previous, "bid output must not decrease");
            assert!(out <= capacity + 1, "bid output exceeded capacity");
            previous = out;
        }
    }
}

#[test]
fn round_trip_never_creates_quote() {
    let mut rng = Lcg(6);
    for _ in 0..500 {
        let mid = sqrt_q64(rng.range(20 * Q64, 400 * Q64)).unwrap();
        let width = rng.range(Q64 / 100, Q64 / 10);
        let liquidity = rng.range(1_000_000_000_000_000_000, 10_000_000_000_000_000_000_000);
        let ask = Level {
            sqrt_lo: mid,
            sqrt_hi: mid + width,
            liquidity,
        };
        let bid = Level {
            sqrt_lo: mid - width,
            sqrt_hi: mid,
            liquidity,
        };
        let quote_in = rng.range(0, ask.quote_capacity().unwrap() + 1);
        let bought = walk_ladder(&[ask], Side::Ask, quote_in).unwrap().out;
        if bought == 0 {
            continue;
        }
        let back = walk_ladder(&[bid], Side::Bid, bought).unwrap().out;
        assert!(back <= quote_in, "round trip created quote");
    }
}

#[test]
fn exhausted_capacity_reports_remaining_input() {
    let mut rng = Lcg(7);
    for _ in 0..300 {
        let level = levels(&mut rng);
        let max_in = level.max_input(Side::Ask).unwrap();
        if max_in == 0 {
            continue;
        }
        let over = max_in.saturating_mul(3).saturating_add(1);
        let result = walk_ladder(&[level], Side::Ask, over).unwrap();
        assert!(result.remaining > 0);
        assert_eq!(result.out, level.base_capacity().unwrap());
    }
}

#[test]
fn bps_rounding_directions_are_exact() {
    let mut rng = Lcg(8);
    for _ in 0..5_000 {
        let x = rng.range(0, 1u128 << 110);
        let bps = rng.range(0, 10_001);
        let floor = mul_bps(x, bps).unwrap();
        let ceil = ceil_bps(x, bps).unwrap();
        assert!(floor <= ceil);
        assert!(ceil - floor <= 1);
        assert!(floor * 10_000 <= x * bps || x == 0);
    }
}

#[test]
fn repeated_round_trips_cannot_grow_quote() {
    // An attacker hammering buy/sell round trips across a two-sided ladder must
    // never end with more quote than they started with (rounding leakage is
    // bounded to zero in the attacker's favour).
    let mut rng = Lcg(9);
    for _ in 0..200 {
        let mid = sqrt_q64(rng.range(20 * Q64, 400 * Q64)).unwrap();
        let width = rng.range(Q64 / 100, Q64 / 10);
        let liquidity = rng.range(1_000_000_000_000_000_000, 10_000_000_000_000_000_000_000);
        let ask = Level {
            sqrt_lo: mid,
            sqrt_hi: mid + width,
            liquidity,
        };
        let bid = Level {
            sqrt_lo: mid - width,
            sqrt_hi: mid,
            liquidity,
        };
        let mut quote: u128 = rng.range(1_000, 1_000_000);
        let start = quote;
        for _ in 0..200 {
            let spend = (quote / 50).max(1);
            let bought = walk_ladder(&[ask], Side::Ask, spend).unwrap().out;
            if bought == 0 {
                break;
            }
            let back = walk_ladder(&[bid], Side::Bid, bought).unwrap().out;
            quote = quote - spend + back;
        }
        assert!(
            quote <= start,
            "round trips grew quote from {start} to {quote}"
        );
    }
}
