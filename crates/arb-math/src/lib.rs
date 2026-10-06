//! ArbSwap math core (`arb-math`).
//!
//! Pure, checked, fixed-point math shared bit-exactly by the on-chain program,
//! the keeper, and the simulator (Build Plan §0 rule 2 and §4). No Solana
//! dependencies, so this crate is testable natively and fuzzable.
//!
//! Rounding rule (Build Plan §5.2): amounts the vault pays out round DOWN;
//! amounts the vault receives round UP. Never the reverse.

/// Basis-point denominator: 1 bps = 1/10,000.
pub const BPS_DENOMINATOR: u128 = 10_000;

/// Checked floor((a * b) / c). Returns None on overflow or c == 0.
pub fn mul_div_floor(a: u128, b: u128, c: u128) -> Option<u128> {
    if c == 0 {
        return None;
    }
    a.checked_mul(b)?.checked_div(c)
}

/// Checked ceil((a * b) / c). Returns None on overflow or c == 0.
pub fn mul_div_ceil(a: u128, b: u128, c: u128) -> Option<u128> {
    if c == 0 {
        return None;
    }
    let p = a.checked_mul(b)?;
    let q = p / c;
    if p % c == 0 {
        Some(q)
    } else {
        q.checked_add(1)
    }
}

/// Add `bps` of `amount`, rounding in the vault's favor:
/// `round_up == true` when the vault receives, `false` when it pays out.
pub fn add_bps(amount: u128, bps: u32, round_up: bool) -> Option<u128> {
    let scaled = amount.checked_mul(bps as u128)?;
    let part = if round_up {
        mul_div_ceil(scaled, 1, BPS_DENOMINATOR)?
    } else {
        mul_div_floor(scaled, 1, BPS_DENOMINATOR)?
    };
    amount.checked_add(part)
}

// TODO(P1 T1.1/T1.3): port the full Build Plan §5 math here against the Python
// reference in research/reference:
//   §5.5  half-spread            s = clamp(s_floor + a1*sigma + a2*|q| + a3*(c/P) + a4*age + a5*jump, s_min, s_max)
//   §5.6  directional add-on     ask_extra = e*max(0, move); bid_extra = e*max(0, -move)
//   §5.7  ladder                 offsets m_k, weights w_k, side capacities with u_max
//   §5.8  constant-product segments (formulas verified against the LVR paper, Example 4):
//         dx = L*(1/sqrt(Pa) - 1/sqrt(Pb)); dy = L*(sqrt(Pb) - sqrt(Pa))
//         buy:  sqrt(p') = sqrt(p) + dy_in/L;  dx_out = L*(1/sqrt(p) - 1/sqrt(p'))
//         sell: 1/sqrt(p') = 1/sqrt(p) + dx_in/L; dy_out = L*(sqrt(p) - sqrt(p'))
//   §5.9  flow accumulator       n resets to 0 on every update_quote (decision D-04)
//   §5.10 LVR budget cap         V_active <= 8*(R - gas)/sigma^2  (LVR/V = sigma^2/8 for constant product)
//   §5.14 vault share math       pro-rata two-token shares, MIN_LIQUIDITY burn (decision D-05)
//
// Fixed-point primitives (research/reference/fixed.py is the source of truth;
// port bit-exactly once golden vectors exist, T1.3):
//   sqrt_q64 / sqrt_from_price   EXACT floor: isqrt(price_q64 << 64) — 192-bit radicand.
//                                The shortcut isqrt(v) << 32 loses up to 2^32 units and
//                                must NOT be used (decision 2026-10-06).
//   mul_q64 / price_from_sqrt    (a * b) >> 64 needs a widening u128*u128 -> u192/u256
//                                multiply: checked_mul overflows for realistic prices
//                                (sqrt(150)-scale operands already exceed u128 when squared).
//   recip_q64 / recip_inv        floor(2^128 / s); roundtrip bound s^2/2^128.
//   sqrt_price_scaled            two-floor: mul_q64(sqrt_p, sqrt_q64(1+x)); trails the
//                                single-floor value by <= sqrt_p/2^64 + 3 units.
//   tdiv                         truncating division toward zero (Python must use tdiv,
//                                not //, wherever operands can be negative).

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn floor_and_ceil_agree_on_exact_division() {
        // mul_div_floor(a, b, c) = floor(a*b/c): 9*3/3 = 9 exactly.
        assert_eq!(mul_div_floor(9, 3, 3), Some(9));
        assert_eq!(mul_div_ceil(9, 3, 3), Some(9));
        // Non-trivial exact case: 12*5/4 = 15.
        assert_eq!(mul_div_floor(12, 5, 4), Some(15));
        assert_eq!(mul_div_ceil(12, 5, 4), Some(15));
    }

    #[test]
    fn ceil_rounds_up_only_when_needed() {
        assert_eq!(mul_div_ceil(10, 1, 3), Some(4));
        assert_eq!(mul_div_floor(10, 1, 3), Some(3));
    }

    #[test]
    fn division_by_zero_is_checked() {
        assert_eq!(mul_div_floor(1, 1, 0), None);
        assert_eq!(mul_div_ceil(1, 1, 0), None);
    }

    #[test]
    fn overflow_is_checked() {
        assert_eq!(mul_div_floor(u128::MAX, 2, 1), None);
    }

    #[test]
    fn bps_rounding_favors_the_vault() {
        // 10 units + 1 bps: vault receives 10.001 -> rounds up to 10.001 (ceil keeps the fraction? u128 so 1001/100? keep in atoms)
        assert_eq!(add_bps(1_000_000, 1, true), Some(1_000_100)); // ceil(1_000_000*1/10_000)=100
        assert_eq!(add_bps(1_000_001, 1, true), Some(1_000_102)); // ceil(1_000_001/10_000)=101 (rounds up: vault receives more)
        assert_eq!(add_bps(1_000_001, 1, false), Some(1_000_101)); // floor=100 (rounds down: vault pays out less)
    }
}
