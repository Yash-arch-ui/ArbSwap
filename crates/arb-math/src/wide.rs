//! Minimal 256-bit unsigned helpers (T1.3).
//!
//! `arb-math` is dependency-free by design (Build Plan §4) so it stays portable
//! to the SBF target. The Q64.64 layer needs exactly three capabilities wider
//! than `u128`:
//!
//! 1. an exact `u128 * u128 -> u256` product (for `mul_q64`),
//! 2. a 192-bit input `isqrt` (for the exact `sqrt_q64`, decision 2026-10-06),
//! 3. checked narrowing back to `u128`.
//!
//! Rather than pull in a big-integer crate (unverified for SBF), this module
//! implements only those operations. Nothing here is used directly by the
//! program; it exists so the shared crate can reproduce the Python reference
//! bit-for-bit.

use core::cmp::Ordering;

/// Little-endian 64-bit limbs: `value = l0 + l1*2^64 + l2*2^128 + l3*2^192`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct U256(pub [u64; 4]);

impl U256 {
    pub const ZERO: U256 = U256([0, 0, 0, 0]);
    pub const ONE: U256 = U256([1, 0, 0, 0]);

    /// Construct from a `u128` (fits in the low two limbs).
    pub const fn from_u128(v: u128) -> U256 {
        U256([v as u64, (v >> 64) as u64, 0, 0])
    }

    pub const fn is_zero(&self) -> bool {
        self.0[0] == 0 && self.0[1] == 0 && self.0[2] == 0 && self.0[3] == 0
    }

    /// Number of significant bits; `0` for zero.
    pub const fn bit_length(&self) -> u32 {
        let mut limb = 3;
        loop {
            if self.0[limb] != 0 {
                return limb as u32 * 64 + (64 - self.0[limb].leading_zeros());
            }
            if limb == 0 {
                return 0;
            }
            limb -= 1;
        }
    }

    pub const fn cmp(&self, other: &U256) -> Ordering {
        let mut limb = 3;
        loop {
            if self.0[limb] != other.0[limb] {
                return if self.0[limb] > other.0[limb] {
                    Ordering::Greater
                } else {
                    Ordering::Less
                };
            }
            if limb == 0 {
                return Ordering::Equal;
            }
            limb -= 1;
        }
    }

    /// Checked addition; `None` on 256-bit overflow.
    pub const fn checked_add(&self, other: &U256) -> Option<U256> {
        let mut out = [0u64; 4];
        let mut carry = 0u128;
        let mut i = 0;
        while i < 4 {
            let sum = self.0[i] as u128 + other.0[i] as u128 + carry;
            out[i] = sum as u64;
            carry = sum >> 64;
            i += 1;
        }
        if carry != 0 {
            None
        } else {
            Some(U256(out))
        }
    }

    /// Widening addition that cannot overflow 256 bits when both inputs are
    /// `< 2^192` (used only internally by `isqrt`).
    const fn wrapping_add(&self, other: &U256) -> U256 {
        let mut out = [0u64; 4];
        let mut carry = 0u128;
        let mut i = 0;
        while i < 4 {
            let sum = self.0[i] as u128 + other.0[i] as u128 + carry;
            out[i] = sum as u64;
            carry = sum >> 64;
            i += 1;
        }
        U256(out)
    }

    /// Precondition: `self >= other`. Returns the exact difference.
    pub const fn wrapping_sub(&self, other: &U256) -> U256 {
        let mut out = [0u64; 4];
        let mut borrow = 0i128;
        let mut i = 0;
        while i < 4 {
            let diff = self.0[i] as i128 - other.0[i] as i128 - borrow;
            if diff < 0 {
                out[i] = (diff + (1i128 << 64)) as u64;
                borrow = 1;
            } else {
                out[i] = diff as u64;
                borrow = 0;
            }
            i += 1;
        }
        U256(out)
    }

    /// Shift left by `n < 256`; bits shifted past 256 are dropped.
    pub const fn shl(&self, n: u32) -> U256 {
        if n >= 256 {
            return U256::ZERO;
        }
        let limb_shift = (n / 64) as usize;
        let bit_shift = n % 64;
        let mut out = [0u64; 4];
        let mut i = 3;
        loop {
            if i >= limb_shift {
                let src = i - limb_shift;
                let mut value = (self.0[src] as u128) << bit_shift;
                if bit_shift > 0 && src > 0 {
                    value |= (self.0[src - 1] as u128) >> (64 - bit_shift);
                }
                out[i] = value as u64;
            }
            if i == 0 {
                break;
            }
            i -= 1;
        }
        U256(out)
    }

    /// Logical shift right by `n < 256`.
    pub const fn shr(&self, n: u32) -> U256 {
        if n >= 256 {
            return U256::ZERO;
        }
        let limb_shift = (n / 64) as usize;
        let bit_shift = n % 64;
        let mut out = [0u64; 4];
        let mut i = 0;
        while i < 4 {
            let src = i + limb_shift;
            if src < 4 {
                let mut value = (self.0[src] as u128) >> bit_shift;
                if bit_shift > 0 && src + 1 < 4 {
                    value |= (self.0[src + 1] as u128) << (64 - bit_shift);
                }
                out[i] = value as u64;
            }
            i += 1;
        }
        U256(out)
    }

    /// Exact `a * b` for `a, b < 2^128`; the product is `< 2^256`.
    pub fn mul_u128(a: u128, b: u128) -> U256 {
        let p00 = U256::from_u128((a as u64 as u128) * (b as u64 as u128));
        let p01 = U256::from_u128((a as u64 as u128) * (b >> 64)).shl(64);
        let p10 = U256::from_u128((a >> 64) * (b as u64 as u128)).shl(64);
        let p11 = U256::from_u128((a >> 64) * (b >> 64)).shl(128);
        p00.wrapping_add(&p01).wrapping_add(&p10).wrapping_add(&p11)
    }

    /// Narrow to `u128`; `None` if any high limb is set.
    pub const fn to_u128(&self) -> Option<u128> {
        if self.0[2] != 0 || self.0[3] != 0 {
            None
        } else {
            Some((self.0[0] as u128) | ((self.0[1] as u128) << 64))
        }
    }

    /// Floor integer square root, using the restoring binary method. Requires
    /// only shifts, comparisons, addition, and subtraction, so it needs no
    /// 512-bit division.
    pub fn isqrt(value: U256) -> U256 {
        if value.is_zero() {
            return U256::ZERO;
        }
        // Largest even exponent not exceeding bit_length - 1: 4^floor((bl-1)/2).
        let bl = value.bit_length();
        let mut bit = U256::ONE.shl((bl - 1) / 2 * 2);
        let mut remainder = value;
        let mut result = U256::ZERO;
        while !bit.is_zero() {
            let candidate = result.wrapping_add(&bit);
            if remainder.cmp(&candidate) != Ordering::Less {
                remainder = remainder.wrapping_sub(&candidate);
                result = result.shr(1).wrapping_add(&bit);
            } else {
                result = result.shr(1);
            }
            bit = bit.shr(2);
        }
        result
    }

    /// Checked floor division: `(quotient, remainder)`; `None` when `divisor`
    /// is zero. Binary long division over the 256-bit width, so it never needs
    /// a wider temporary.
    pub fn div_rem(self, divisor: U256) -> Option<(U256, U256)> {
        if divisor.is_zero() {
            return None;
        }
        let dividend = self;
        let mut quotient = U256::ZERO;
        let mut remainder = U256::ZERO;
        let mut i = 256;
        while i > 0 {
            i -= 1;
            remainder = remainder.shl(1);
            if dividend.shr(i).0[0] & 1 == 1 {
                remainder = remainder.wrapping_add(&U256::ONE);
            }
            quotient = quotient.shl(1);
            if remainder.cmp(&divisor) != Ordering::Less {
                remainder = remainder.wrapping_sub(&divisor);
                quotient = quotient.wrapping_add(&U256::ONE);
            }
        }
        Some((quotient, remainder))
    }
}
