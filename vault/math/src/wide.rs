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

    /// Floor integer square root.
    ///
    /// Newton's method seeded from the bit length, stopped at the first
    /// non-decreasing step — the integer algorithm documented in the Python
    /// `math.isqrt` notes. Seeded at or above the true root, it is monotone
    /// decreasing and lands exactly on `floor(sqrt(value))`; the differential
    /// property test asserts the same bracket as the reference.
    pub fn isqrt(value: U256) -> U256 {
        if value.is_zero() {
            return U256::ZERO;
        }
        let mut x = U256::ONE.shl(value.bit_length().div_ceil(2));
        loop {
            // value / x, floored. `x` is non-zero by construction.
            let quotient = value.div_rem(x).expect("x is non-zero").0;
            let y = x.wrapping_add(&quotient).shr(1);
            if y.cmp(&x) != Ordering::Less {
                return x;
            }
            x = y;
        }
    }

    /// Checked floor division: `(quotient, remainder)`; `None` when `divisor`
    /// is zero.
    ///
    /// Knuth Algorithm D over 64-bit limbs (base `2^64`), so a 256-bit division
    /// costs a few dozen limb operations instead of the 256 single-bit
    /// shift-subtract rounds the first implementation used. The result is
    /// bit-identical to that restoring method; `tests/properties.rs` fuzzes the
    /// two against each other.
    pub fn div_rem(self, divisor: U256) -> Option<(U256, U256)> {
        if divisor.is_zero() {
            return None;
        }
        if self.cmp(&divisor) == Ordering::Less {
            return Some((U256::ZERO, self));
        }

        // Significant limbs in the divisor (1..=4); the dividend is non-zero
        // and at least the divisor here, so the quotient is non-zero.
        let mut n = 4usize;
        while divisor.0[n - 1] == 0 {
            n -= 1;
        }

        // D1: normalise so the divisor's top limb has its high bit set.
        let shift = divisor.0[n - 1].leading_zeros();

        // u carries one extra limb; v is padded to four limbs.
        let mut u = [0u64; 5];
        u[..4].copy_from_slice(&self.0);
        let mut v = [0u64; 4];
        v[..n].copy_from_slice(&divisor.0[..n]);
        if shift > 0 {
            let mut carry = 0u64;
            for limb in u.iter_mut() {
                let value = *limb;
                *limb = (value << shift) | carry;
                carry = value >> (64 - shift);
            }
            let mut carry = 0u64;
            for limb in v[..n].iter_mut() {
                let value = *limb;
                *limb = (value << shift) | carry;
                carry = value >> (64 - shift);
            }
        }

        const BASE: u128 = 1 << 64;
        const LOW_MASK: u128 = (1 << 64) - 1;
        let mut quotient = [0u64; 4];

        // D2-D7: one quotient limb per step, most significant first.
        let mut j = 4 - n;
        loop {
            // D3: estimate the quotient limb from the top two limbs.
            let top = ((u[j + n] as u128) << 64) | (u[j + n - 1] as u128);
            let mut q_hat = top / (v[n - 1] as u128);
            let mut r_hat = top % (v[n - 1] as u128);
            loop {
                let too_big = q_hat >= BASE
                    || (n >= 2
                        && q_hat * (v[n - 2] as u128) > ((r_hat << 64) | (u[j + n - 2] as u128)));
                if !too_big {
                    break;
                }
                q_hat -= 1;
                r_hat += v[n - 1] as u128;
                if r_hat >= BASE {
                    break;
                }
            }
            debug_assert!(q_hat < BASE, "quotient limb estimate escaped u64");

            // D4: multiply the divisor by q_hat and subtract from u.
            let mut borrow: u128 = 0;
            let mut carry: u128 = 0;
            for i in 0..n {
                let product = q_hat * (v[i] as u128) + carry;
                carry = product >> 64;
                let low = product & LOW_MASK;
                let value = u[j + i] as u128;
                if value < low + borrow {
                    u[j + i] = (value + BASE - low - borrow) as u64;
                    borrow = 1;
                } else {
                    u[j + i] = (value - low - borrow) as u64;
                    borrow = 0;
                }
            }
            let value = u[j + n] as u128;
            let negative = value < carry + borrow;
            u[j + n] = value.wrapping_sub(carry).wrapping_sub(borrow) as u64;

            if negative {
                // D6: the estimate was one too large; add the divisor back.
                q_hat -= 1;
                let mut carry: u128 = 0;
                for i in 0..n {
                    let sum = (u[j + i] as u128) + (v[i] as u128) + carry;
                    u[j + i] = sum as u64;
                    carry = sum >> 64;
                }
                u[j + n] = u[j + n].wrapping_add(carry as u64);
            }

            quotient[j] = q_hat as u64;
            if j == 0 {
                break;
            }
            j -= 1;
        }

        // D8: the remainder is the low `n` limbs, un-normalised.
        let mut remainder = [0u64; 4];
        remainder[..n].copy_from_slice(&u[..n]);
        if shift > 0 {
            let mut carry = 0u64;
            for i in (0..n).rev() {
                let value = remainder[i];
                remainder[i] = (value >> shift) | carry;
                carry = value << (64 - shift);
            }
        }
        Some((U256(quotient), U256(remainder)))
    }
}
