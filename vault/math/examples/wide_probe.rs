//! Differential probe for the wide / Q64.64 primitives.
//!
//! Reads lines `op arg...` from stdin (hex for U256, decimal for u128) and
//! writes one result line per input, so a Python big-integer harness can
//! compare every operation against `int`.
//!
//! Ops:
//!   mul_u128 <a> <b>            -> U256 hex  (a,b decimal u128)
//!   div_rem  <a> <b>            -> "q r" hex (a,b U256 hex)
//!   shl      <a> <n>            -> U256 hex
//!   shr      <a> <n>            -> U256 hex
//!   isqrt    <a>                -> U256 hex
//!   mul_q64  <a> <b>            -> u128 hex
//!   div_q64  <a> <b>            -> u128 hex
//!   recip_q64 <a>               -> u128 hex
//!   sqrt_q64 <a>                -> u128 hex
//!   price_from_sqrt <a>         -> u128 hex

use arb_math::fixed::{div_q64, mul_q64, price_from_sqrt, recip_q64, sqrt_q64};
use arb_math::wide::U256;
use std::io::{self, BufRead, Write};

fn parse_u256(s: &str) -> U256 {
    let mut v = U256::ZERO;
    for ch in s.trim().chars() {
        let d = ch.to_digit(16).expect("hex digit");
        v = v
            .shl(4)
            .checked_add(&U256::from_u128(d as u128))
            .expect("u256");
    }
    v
}

fn u256_hex(v: U256) -> String {
    if v.is_zero() {
        return "0".to_string();
    }
    let mut s = String::new();
    for limb in v.0.iter().rev() {
        if s.is_empty() {
            s.push_str(&format!("{limb:x}"));
        } else {
            s.push_str(&format!("{limb:016x}"));
        }
    }
    s
}

fn main() {
    let stdin = io::stdin();
    let stdout = io::stdout();
    let mut out = stdout.lock();
    for line in stdin.lock().lines() {
        let line = line.expect("line");
        let mut parts = line.split_whitespace();
        let op = parts.next().unwrap_or("");
        let result = match op {
            "mul_u128" => {
                let a: u128 = parts.next().unwrap().parse().unwrap();
                let b: u128 = parts.next().unwrap().parse().unwrap();
                u256_hex(U256::mul_u128(a, b))
            }
            "div_rem" => {
                let a = parse_u256(parts.next().unwrap());
                let b = parse_u256(parts.next().unwrap());
                match a.div_rem(b) {
                    Some((q, r)) => format!("{} {}", u256_hex(q), u256_hex(r)),
                    None => "ERR".to_string(),
                }
            }
            "shl" => {
                let a = parse_u256(parts.next().unwrap());
                let n: u32 = parts.next().unwrap().parse().unwrap();
                u256_hex(a.shl(n))
            }
            "shr" => {
                let a = parse_u256(parts.next().unwrap());
                let n: u32 = parts.next().unwrap().parse().unwrap();
                u256_hex(a.shr(n))
            }
            "isqrt" => {
                let a = parse_u256(parts.next().unwrap());
                u256_hex(U256::isqrt(a))
            }
            "mul_q64" => {
                let a: u128 = parts.next().unwrap().parse().unwrap();
                let b: u128 = parts.next().unwrap().parse().unwrap();
                format!("{:x}", mul_q64(a, b).unwrap_or(0))
            }
            "div_q64" => {
                let a: u128 = parts.next().unwrap().parse().unwrap();
                let b: u128 = parts.next().unwrap().parse().unwrap();
                format!("{:x}", div_q64(a, b).unwrap_or(0))
            }
            "recip_q64" => {
                let a: u128 = parts.next().unwrap().parse().unwrap();
                format!("{:x}", recip_q64(a).unwrap_or(0))
            }
            "sqrt_q64" => {
                let a: u128 = parts.next().unwrap().parse().unwrap();
                format!("{:x}", sqrt_q64(a).unwrap_or(0))
            }
            "price_from_sqrt" => {
                let a: u128 = parts.next().unwrap().parse().unwrap();
                format!("{:x}", price_from_sqrt(a).unwrap_or(0))
            }
            _ => "ERR".to_string(),
        };
        writeln!(out, "{result}").unwrap();
    }
}
