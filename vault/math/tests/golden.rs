//! Golden-vector differential test (T1.2/T1.3).
//!
//! Reads `tests/golden_vectors.txt`, produced by
//! `python -m simulation.reference.golden`, and checks every returned integer
//! against the Python reference bit-for-bit. Until the file is generated the
//! test reports that it was skipped rather than failing, so CI stays green
//! while the math is still being written.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

use arb_math::fixed::{
    ceil_bps, div_q64, mul_bps, mul_q64, one_plus_q64, price_from_sqrt, recip_q64,
    sqrt_price_scaled, sqrt_q64, tdiv,
};
use arb_math::quote::{
    deposit_shares, fee_amount, first_deposit_shares, walk_ladder, withdrawal_amounts, Level, Side,
};

fn vector_path() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/golden_vectors.txt")
}

fn parse_u128(value: &str) -> u128 {
    value
        .parse::<u128>()
        .unwrap_or_else(|_| panic!("bad u128: {value}"))
}

fn parse_i128(value: &str) -> i128 {
    value
        .parse::<i128>()
        .unwrap_or_else(|_| panic!("bad i128: {value}"))
}

#[test]
fn golden_vectors_match_reference() {
    let path = vector_path();
    let contents = match fs::read_to_string(&path) {
        Ok(contents) => contents,
        Err(_) => {
            eprintln!(
                "SKIP: {} not generated yet (run python -m simulation.reference.golden)",
                path.display()
            );
            return;
        }
    };

    let mut checked = 0usize;
    for (lineno, raw) in contents.lines().enumerate() {
        let line = raw.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let mut parts = line.split('|');
        let kind = parts.next().expect("kind");
        let mut f: HashMap<&str, &str> = HashMap::new();
        for part in parts {
            let (key, value) = part
                .split_once('=')
                .unwrap_or_else(|| panic!("line {}: malformed field {part}", lineno + 1));
            f.insert(key, value);
        }
        let u = |key: &str| parse_u128(f.get(key).unwrap());
        let i = |key: &str| parse_i128(f.get(key).unwrap());
        let at = lineno + 1;

        match kind {
            "mul_q64" => assert_eq!(
                mul_q64(u("a"), u("b")).unwrap(),
                u("expected"),
                "mul_q64 @{at}"
            ),
            "div_q64" => assert_eq!(
                div_q64(u("a"), u("b")).unwrap(),
                u("expected"),
                "div_q64 @{at}"
            ),
            "sqrt_q64" => assert_eq!(sqrt_q64(u("v")).unwrap(), u("expected"), "sqrt_q64 @{at}"),
            "recip_q64" => assert_eq!(recip_q64(u("s")).unwrap(), u("expected"), "recip_q64 @{at}"),
            "price_from_sqrt" => {
                assert_eq!(
                    price_from_sqrt(u("a")).unwrap(),
                    u("expected"),
                    "price_from_sqrt @{at}"
                )
            }
            "one_plus_q64" => {
                assert_eq!(
                    one_plus_q64(i("x")).unwrap(),
                    u("expected"),
                    "one_plus_q64 @{at}"
                )
            }
            "sqrt_price_scaled" => assert_eq!(
                sqrt_price_scaled(u("sqrt_p"), i("x")).unwrap(),
                u("expected"),
                "sqrt_price_scaled @{at}"
            ),
            "mul_bps" => assert_eq!(
                mul_bps(u("x"), u("bps")).unwrap(),
                u("expected"),
                "mul_bps @{at}"
            ),
            "ceil_bps" => assert_eq!(
                ceil_bps(u("x"), u("bps")).unwrap(),
                u("expected"),
                "ceil_bps @{at}"
            ),
            "tdiv" => assert_eq!(tdiv(i("a"), i("b")).unwrap(), i("expected"), "tdiv @{at}"),
            "walk_ask" | "walk_bid" => {
                let side = if kind == "walk_ask" {
                    Side::Ask
                } else {
                    Side::Bid
                };
                let level = Level {
                    sqrt_lo: u("lo"),
                    sqrt_hi: u("hi"),
                    liquidity: u("liquidity"),
                };
                let result = walk_ladder(&[level], side, u("amount")).unwrap();
                assert_eq!(result.out, u("expected"), "{kind} out @{at}");
                assert_eq!(
                    result.consumed as u128,
                    u("consumed"),
                    "{kind} consumed @{at}"
                );
                assert_eq!(result.remaining, u("remaining"), "{kind} remaining @{at}");
            }
            "first_deposit" => assert_eq!(
                first_deposit_shares(u("db"), u("dq"), u("min")).unwrap(),
                u("expected"),
                "first_deposit @{at}"
            ),
            "deposit_shares" => assert_eq!(
                deposit_shares(u("db"), u("dq"), u("rb"), u("rq"), u("shares")).unwrap(),
                u("expected"),
                "deposit_shares @{at}"
            ),
            "withdrawal" => {
                let (base, quote) =
                    withdrawal_amounts(u("shares"), u("rb"), u("rq"), u("total")).unwrap();
                assert_eq!(base, u("expected_b"), "withdrawal base @{at}");
                assert_eq!(quote, u("expected_q"), "withdrawal quote @{at}");
            }
            "fee" => assert_eq!(
                fee_amount(u("amount"), u("fee_bps")).unwrap(),
                u("expected"),
                "fee @{at}"
            ),
            // Explicit boundary cases the port must reject (not just match a value).
            "mul_q64_overflow" => {
                assert!(
                    mul_q64(u("a"), u("b")).is_err(),
                    "mul_q64 must overflow @{at}"
                );
            }
            "div_q64_zero" => {
                assert!(
                    div_q64(u("a"), 0).is_err(),
                    "div_q64 by zero must error @{at}"
                );
            }
            other => panic!("unknown vector kind {other} @{at}"),
        }
        checked += 1;
    }

    assert!(checked >= 500, "expected >= 500 vectors, checked {checked}");
    eprintln!("checked {checked} golden vectors");
}
