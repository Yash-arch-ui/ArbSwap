//! Deterministic property/fuzz tests for the aggregator adapter (T5.2).
//!
//! No external RNG crate: a fixed-seed LCG drives randomized ladders, amounts
//! and fees, so the run is reproducible. Properties encoded:
//! 1. `out_given_in` is monotone non-decreasing in the input amount.
//! 2. A trade out and back never creates value (no free money from rounding).
//! 3. `in_given_out` honours its contract: its honest output reaches the target.

use arb_aggregator::{in_given_out, out_given_in, AggregatorError, PaymentToken};
use arb_math::{sqrt_q64, Level};

/// Mulberry32-style deterministic RNG over u32, widened to full u128 ranges.
struct Lcg(u64);

impl Lcg {
    fn next(&mut self) -> u64 {
        self.0 = self
            .0
            .wrapping_mul(6364136223846793005)
            .wrapping_add(1442695040888963407);
        self.0
    }
    fn range(&mut self, hi: u64) -> u64 {
        self.next() % hi
    }
}

fn sqrt(price: u128) -> u128 {
    sqrt_q64(price).unwrap()
}

/// A wide, deep ask+bid ladder so randomized amounts never exceed capacity.
fn wide_ladder() -> Vec<Level> {
    let lo = sqrt(100u128 << 64);
    let hi = sqrt(400u128 << 64);
    let span = hi - lo;
    (0..6)
        .map(|k| {
            let from = lo + span * k / 6;
            let to = lo + span * (k + 1) / 6;
            Level {
                sqrt_lo: from,
                sqrt_hi: to,
                liquidity: 1 << 118,
            }
        })
        .collect()
}

/// A **bid** ladder strictly below the ask ladder, so a buy-then-sell round trip
/// faces a real spread and cannot round-trip for free through the same geometric
/// range. Mid = sqrt(200) so ask is [mid, hi], bid is [lo, mid].
fn ladder_pair() -> (Vec<Level>, Vec<Level>) {
    let lo = sqrt(100u128 << 64);
    let mid = sqrt(200u128 << 64);
    let hi = sqrt(400u128 << 64);
    let make = |from: u128, to: u128| {
        let span = to - from;
        (0..6)
            .map(|k| Level {
                sqrt_lo: from + span * k / 6,
                sqrt_hi: from + span * (k + 1) / 6,
                liquidity: 1 << 118,
            })
            .collect::<Vec<_>>()
    };
    (make(mid, hi), make(lo, mid)) // (ask, bid)
}

#[test]
fn out_given_in_is_monotone_in_the_input() {
    let ladder = wide_ladder();
    let mut rng = Lcg(12345);
    for _ in 0..1_000 {
        let fee = (rng.next() % 100) as u128; // 0..99 bps
        let a = (rng.range(1 << 24)) as u128 + 1;
        let b = (rng.range(1 << 24)) as u128 + 1;
        let (small, large) = if a <= b { (a, b) } else { (b, a) };
        let side = if rng.next().is_multiple_of(2) {
            PaymentToken::Quote
        } else {
            PaymentToken::Base
        };
        let s = out_given_in(&ladder, side, small, fee, 0).ok();
        let l = out_given_in(&ladder, side, large, fee, 0).ok();
        if let (Some(s), Some(l)) = (s, l) {
            assert!(
                l.amount_out >= s.amount_out,
                "monotonicity violated: in {large}->{} < {small}->{}",
                l.amount_out,
                s.amount_out
            );
        }
    }
}

#[test]
fn trade_out_and_back_never_creates_value() {
    let (ask, bid) = ladder_pair();
    let mut rng = Lcg(67890);
    for _ in 0..500 {
        let fee = (rng.next() % 50 + 1) as u128;
        let start_quote = (rng.range(1 << 20)) as u128 + 100;
        // Buy base with `start_quote` on the ASK ladder (vault sells base).
        let bought = out_given_in(&ask, PaymentToken::Quote, start_quote, fee, 0)
            .unwrap()
            .amount_out;
        // Sell the base back on the BID ladder (vault buys base) for quote.
        let refund = out_given_in(&bid, PaymentToken::Base, bought, fee, 0).unwrap();
        // Spread + fees + rounding mean the refund in quote is never above paid.
        assert!(
            refund.amount_out <= start_quote,
            "free money: paid {start_quote} quote, got back {}",
            refund.amount_out
        );
    }
}

#[test]
fn in_given_out_honours_its_target() {
    let ladder = wide_ladder();
    let mut rng = Lcg(112233);
    for _ in 0..500 {
        let fee = (rng.next() % 50) as u128;
        let target = (rng.range(1 << 20)) as u128 + 100;
        let side = if rng.next().is_multiple_of(2) {
            PaymentToken::Quote
        } else {
            PaymentToken::Base
        };
        if let Ok(quote) = in_given_out(&ladder, side, target, fee) {
            // A direct quote of that input must reach at least the target.
            let direct = out_given_in(&ladder, side, quote.amount_in, fee, target)
                .expect("inverse input must satisfy min_out = target");
            assert!(direct.amount_out >= target);
        } else {
            // If it errored, it was liquidity-limited (never Value overflow).
            assert_ne!(
                in_given_out(&ladder, side, target, fee).unwrap_err(),
                AggregatorError::Overflow
            );
        }
    }
}
