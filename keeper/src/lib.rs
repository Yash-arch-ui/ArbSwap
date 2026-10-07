//! Deterministic P3 keeper core.
//!
//! The transport is intentionally behind `QuoteSender`: replay and dry-run are
//! fully usable without an RPC dependency, while a Solana sender can be added
//! without changing quote calculation. All quote inputs and outputs are integer
//! fixed-point values, matching the on-chain `arb-math` conventions.
//!
//! Parity with `research/reference/quote_math.py` (Task 5):
//! - the inventory skew values the base reserve in quote atoms, applying the
//!   Q64 shift and `KeeperParams::base_atom_scale` so mixed SOL(9)/USDC(6)
//!   reserves are compared in one unit (audit F-03);
//! - the volatility term keeps sub-basis-point resolution, so a realistic
//!   sigma is no longer floored to zero (audit F-09);
//! - spread is clamped to `[spread_min_bps, spread_max_bps]`, the directional
//!   add-on is computed and encoded, and the depth throttle includes the
//!   confidence factor, the jump cool-down and the depth budget (audit F-08).
//!
//! Known remaining divergence, tracked, not hidden: the EWMA still uses simple
//! `|dP|/P` returns with per-sample lambdas rather than the reference's
//! per-second-normalised decay, and the keeper emits ask-side levels only
//! (binding the executed levels to the anchor is the separate F-04 programme
//! task). Both are recorded in `docs/FORMULA.md`.

use arb_math::fixed::sqrt_q64;
use arb_math::quote::Level;
use arb_math::wide::U256;
use sha2::{Digest, Sha256};

pub const LEVELS: usize = 6;
pub const BPS: u128 = 10_000;
pub const Q64: u128 = 1 << 64;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct OracleTick {
    pub slot: u64,
    pub publish_time: i64,
    pub price_q64: u128,
    pub confidence_bps: u32,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct VolatilityState {
    pub variance_short_q64: u128,
    pub variance_medium_q64: u128,
    pub previous_price_q64: u128,
    pub jump: bool,
}

impl VolatilityState {
    /// EWMA over a return expressed in Q64.64 fraction units.
    pub fn update(
        self,
        price_q64: u128,
        short_lambda_bps: u32,
        medium_lambda_bps: u32,
        jump_multiple: u128,
    ) -> Self {
        if self.previous_price_q64 == 0 {
            return Self {
                previous_price_q64: price_q64,
                ..self
            };
        }
        let ret = if price_q64 >= self.previous_price_q64 {
            ((price_q64 - self.previous_price_q64) << 64) / self.previous_price_q64
        } else {
            ((self.previous_price_q64 - price_q64) << 64) / self.previous_price_q64
        };
        let ret2 = mul_q64(ret, ret);
        let short = ewma(self.variance_short_q64, ret2, short_lambda_bps);
        let medium = ewma(self.variance_medium_q64, ret2, medium_lambda_bps);
        let sigma = sqrt_q64(short).unwrap_or(u128::MAX);
        Self {
            variance_short_q64: short,
            variance_medium_q64: medium,
            previous_price_q64: price_q64,
            jump: sigma > 0 && ret > sigma.saturating_mul(jump_multiple),
        }
    }

    pub fn sigma_q64(self) -> u128 {
        sqrt_q64(self.variance_short_q64).unwrap_or(u128::MAX)
    }
}

fn ewma(old: u128, sample: u128, lambda_bps: u32) -> u128 {
    let l = lambda_bps as u128;
    (old.saturating_mul(l)
        .saturating_add(sample.saturating_mul(BPS.saturating_sub(l))))
        / BPS
}

fn mul_q64(a: u128, b: u128) -> u128 {
    U256::mul_u128(a, b).shr(64).to_u128().unwrap_or(u128::MAX)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct KeeperParams {
    pub spread_floor_bps: u32,
    pub spread_min_bps: u32,
    pub spread_max_bps: u32,
    pub inventory_coeff_bps: u32,
    pub volatility_coeff_bps: u32,
    pub confidence_coeff_bps: u32,
    pub confidence_max_bps: u32,
    pub age_coeff_bps: u32,
    pub jump_extra_bps: u32,
    pub jump_cooldown_bps: u32,
    pub directional_coeff_bps: u32,
    pub utilization_bps: u32,
    pub depth_budget_bps: u32,
    pub sigma_target_q64: u128,
    /// `10^(base_decimals - quote_decimals)`. Divides the base reserve value so
    /// a SOL(9)/USDC(6) inventory is compared in the quote token's units
    /// (audit F-03). `1` when both tokens share a scale.
    pub base_atom_scale: u128,
    pub grace_slots: u64,
    pub expiry_slots: u64,
    pub offsets_bps: [u32; LEVELS],
    pub weights_bps: [u32; LEVELS],
}

impl Default for KeeperParams {
    fn default() -> Self {
        Self {
            spread_floor_bps: 1,
            spread_min_bps: 1,
            spread_max_bps: 50,
            inventory_coeff_bps: 5,
            volatility_coeff_bps: 2,
            confidence_coeff_bps: 1,
            confidence_max_bps: 10,
            age_coeff_bps: 1,
            jump_extra_bps: 5,
            jump_cooldown_bps: 5_000,
            directional_coeff_bps: 10_000,
            utilization_bps: 5_000,
            depth_budget_bps: 10_000,
            sigma_target_q64: 1 << 60,
            base_atom_scale: 1,
            grace_slots: 2,
            expiry_slots: 10,
            offsets_bps: [2, 5, 10, 20, 40, 80],
            weights_bps: [1_000, 1_500, 2_000, 2_000, 2_000, 1_500],
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct QuoteUpdate {
    pub slot: u64,
    pub publish_time: i64,
    pub oracle_price_q64: u128,
    pub confidence_bps: u32,
    pub anchor_sqrt_price: u128,
    pub reservation_sqrt_price: u128,
    pub half_spread_bps: u32,
    pub ask_extra_bps: u32,
    pub bid_extra_bps: u32,
    pub depth_mult_bps: u32,
    pub levels: [Level; LEVELS],
    pub offsets_bps: [u32; LEVELS],
    pub weights_bps: [u32; LEVELS],
}

/// Exact Borsh payload consumed by the P2 `update_quote` instruction.
pub fn encode_update_quote_instruction(update: &QuoteUpdate) -> Vec<u8> {
    let mut data = Vec::with_capacity(8 + 8 + 8 + 16 + 4 + 16 + 16 + 16 + LEVELS * 8 + LEVELS * 48);
    let mut hash = Sha256::new();
    hash.update(b"global:update_quote");
    data.extend_from_slice(&hash.finalize()[..8]);
    put_u64(&mut data, update.slot);
    put_i64(&mut data, update.publish_time);
    put_u128(&mut data, update.oracle_price_q64);
    put_u32(&mut data, update.confidence_bps);
    put_u128(&mut data, update.anchor_sqrt_price);
    put_u128(&mut data, update.reservation_sqrt_price);
    put_u32(&mut data, update.half_spread_bps);
    put_u32(&mut data, update.ask_extra_bps);
    put_u32(&mut data, update.bid_extra_bps);
    put_u32(&mut data, update.depth_mult_bps);
    for offset in update.offsets_bps {
        put_u32(&mut data, offset);
    }
    for weight in update.weights_bps {
        put_u32(&mut data, weight);
    }
    for level in &update.levels {
        put_u128(&mut data, level.sqrt_lo);
        put_u128(&mut data, level.sqrt_hi);
        put_u128(&mut data, level.liquidity);
    }
    data
}

fn put_u32(out: &mut Vec<u8>, value: u32) {
    out.extend_from_slice(&value.to_le_bytes());
}
fn put_u64(out: &mut Vec<u8>, value: u64) {
    out.extend_from_slice(&value.to_le_bytes());
}
fn put_i64(out: &mut Vec<u8>, value: i64) {
    out.extend_from_slice(&value.to_le_bytes());
}
fn put_u128(out: &mut Vec<u8>, value: u128) {
    out.extend_from_slice(&value.to_le_bytes());
}

/// Section 5.6 directional add-on in bps: `(ask_extra, bid_extra)`.
///
/// `previous_price_q64 == 0` means there is no prior tick and both are zero.
/// `coeff_bps` is the dimensionless coefficient in bps (`10_000` == 1.0).
fn directional_addon(price_q64: u128, previous_price_q64: u128,
                     coeff_bps: u32) -> (u32, u32) {
    if previous_price_q64 == 0 || price_q64 == 0 {
        return (0, 0);
    }
    let (up, down) = if price_q64 >= previous_price_q64 {
        (price_q64 - previous_price_q64, 0)
    } else {
        (0, previous_price_q64 - price_q64)
    };
    let ask = mul_div(up, BPS, previous_price_q64)
        .map(|move_bps| move_bps.saturating_mul(coeff_bps as u128) / BPS)
        .unwrap_or(0)
        .min(u32::MAX as u128) as u32;
    let bid = mul_div(down, BPS, previous_price_q64)
        .map(|move_bps| move_bps.saturating_mul(coeff_bps as u128) / BPS)
        .unwrap_or(0)
        .min(u32::MAX as u128) as u32;
    (ask, bid)
}

pub fn compute_quote(
    tick: OracleTick,
    state: VolatilityState,
    base: u128,
    quote: u128,
    age: u64,
    previous_price_q64: u128,
    params: KeeperParams,
) -> Option<QuoteUpdate> {
    if tick.price_q64 == 0 || base == 0 || quote == 0 || params.base_atom_scale == 0 {
        return None;
    }
    // Base reserve valued in quote atoms: `base * P / 2^64 / base_atom_scale`.
    // `price_q64` is Q64.64, so the raw product must be shifted down; and when
    // the two tokens have different decimals (SOL 9, USDC 6) the base amount is
    // rescaled before it is compared with the quote reserve (audit F-03). With
    // the old `base * price_q64` the ratio was off by 2^64 and the skew
    // saturated at its bound for every realistic reserve.
    let base_value = mul_div(base, tick.price_q64, Q64)?.checked_div(params.base_atom_scale)?;
    let denominator = base_value.checked_add(quote)?;
    if denominator == 0 {
        return None;
    }
    let q_bps: i128 = if base_value >= quote {
        ((base_value - quote).saturating_mul(BPS) / denominator).min(BPS) as i128
    } else {
        -(((quote - base_value).saturating_mul(BPS) / denominator).min(BPS) as i128)
    };
    let skew = (params.inventory_coeff_bps as i128).saturating_mul(q_bps) / BPS as i128;
    let reservation_factor = if skew >= 0 {
        BPS.saturating_sub(skew as u128)
    } else {
        BPS.saturating_add((-skew) as u128)
    };
    let reservation_price = mul_div(tick.price_q64, reservation_factor, BPS)?;

    let sigma = state.sigma_q64();
    // Keep sub-basis-point resolution: `coeff * sigma_fraction * 10^4`. The old
    // form floored sigma to whole bps first and then divided by 10^4 again, so
    // the volatility term was always zero for realistic sigma (audit F-09).
    let vol_term_bps =
        mul_div(sigma.saturating_mul(params.volatility_coeff_bps as u128), BPS, Q64)?;
    let confidence_term_bps =
        (params.confidence_coeff_bps as u128).saturating_mul(tick.confidence_bps as u128) / BPS;
    let age_term_bps =
        (params.age_coeff_bps as u128).saturating_mul(age.saturating_sub(params.grace_slots) as u128);
    let raw_spread = (params.spread_floor_bps as u128)
        .saturating_add(vol_term_bps)
        .saturating_add(confidence_term_bps)
        .saturating_add(age_term_bps)
        .saturating_add(if state.jump { params.jump_extra_bps as u128 } else { 0 });
    let spread = raw_spread
        .min(params.spread_max_bps as u128)
        .max(params.spread_min_bps as u128);

    let (ask_extra_bps, bid_extra_bps) =
        directional_addon(tick.price_q64, previous_price_q64, params.directional_coeff_bps);
    let ask_spread = spread.saturating_add(ask_extra_bps as u128);

    // Depth throttle (Section 5.9): min(sigma-target factor, confidence factor,
    // jump cool-down, budget). The old keeper applied the sigma-target factor
    // only (audit F-08/F-09).
    let sigma_factor = if sigma == 0 {
        BPS
    } else {
        mul_div(params.sigma_target_q64, BPS, sigma)?.min(BPS)
    };
    let confidence_factor = if params.confidence_max_bps == 0 {
        0
    } else {
        BPS.saturating_sub(
            (tick.confidence_bps as u128)
                .saturating_mul(BPS)
                .saturating_div(params.confidence_max_bps as u128)
                .min(BPS),
        )
    };
    let jump_factor = if state.jump {
        params.jump_cooldown_bps as u128
    } else {
        0
    };
    let rule = sigma_factor
        .saturating_mul(confidence_factor)
        .saturating_div(BPS)
        .saturating_mul(BPS.saturating_sub(jump_factor))
        .saturating_div(BPS);
    let depth = rule.min(BPS).min(params.depth_budget_bps as u128);

    let reservation_sqrt = sqrt_q64(reservation_price).ok()?;
    let anchor_sqrt = sqrt_q64(tick.price_q64).ok()?;
    let mut levels = [Level {
        sqrt_lo: 0,
        sqrt_hi: 0,
        liquidity: 0,
    }; LEVELS];
    let base_capacity = base
        .saturating_mul(params.utilization_bps as u128)
        .saturating_mul(depth)
        / (BPS * BPS);
    let mut previous = 0u32;
    for (i, level) in levels.iter_mut().enumerate() {
        let lo_factor = BPS + ask_spread + previous as u128;
        let hi_factor = BPS + ask_spread + params.offsets_bps[i] as u128;
        let lo_price = mul_div(reservation_price, lo_factor, BPS)?;
        let hi_price = mul_div(reservation_price, hi_factor, BPS)?;
        let lo = sqrt_q64(lo_price).ok()?;
        let hi = sqrt_q64(hi_price).ok()?;
        let capacity = base_capacity.saturating_mul(params.weights_bps[i] as u128) / BPS;
        let liquidity = if hi > lo {
            mul_div(mul_div(capacity, lo, 1)?, hi, hi - lo)?
        } else {
            return None;
        };
        *level = Level {
            sqrt_lo: lo,
            sqrt_hi: hi,
            liquidity,
        };
        previous = params.offsets_bps[i];
    }
    Some(QuoteUpdate {
        slot: tick.slot,
        publish_time: tick.publish_time,
        oracle_price_q64: tick.price_q64,
        confidence_bps: tick.confidence_bps,
        anchor_sqrt_price: anchor_sqrt,
        reservation_sqrt_price: reservation_sqrt,
        half_spread_bps: spread as u32,
        ask_extra_bps,
        bid_extra_bps,
        depth_mult_bps: depth as u32,
        levels,
        offsets_bps: params.offsets_bps,
        weights_bps: params.weights_bps,
    })
}

fn mul_div(a: u128, b: u128, c: u128) -> Option<u128> {
    if c == 0 {
        None
    } else {
        U256::mul_u128(a, b)
            .div_rem(arb_math::wide::U256::from_u128(c))?
            .0
            .to_u128()
    }
}

pub fn should_update(
    previous: Option<QuoteUpdate>,
    next: &QuoteUpdate,
    threshold_bps: u32,
    max_age_slots: u64,
) -> bool {
    let Some(old) = previous else { return true };
    if next.slot.saturating_sub(old.slot) >= max_age_slots {
        return true;
    }
    let diff = next.oracle_price_q64.abs_diff(old.oracle_price_q64);
    diff.saturating_mul(BPS) >= old.oracle_price_q64.saturating_mul(threshold_bps as u128)
}

pub fn priority_fee_lamports(sigma_q64: u128, base: u64, jump: bool) -> u64 {
    let urgency = sigma_q64.saturating_mul(10_000) / Q64;
    let mut fee = base.saturating_add(
        (base as u128).saturating_mul(urgency).min(u64::MAX as u128) as u64 / 10_000,
    );
    if jump {
        fee = fee.saturating_mul(2);
    }
    fee
}

pub trait QuoteSender {
    type Error;
    fn send(&mut self, quote: QuoteUpdate, priority_fee_lamports: u64) -> Result<(), Self::Error>;
}

#[derive(Default)]
pub struct DryRunSender {
    pub sent: Vec<(QuoteUpdate, u64)>,
}
impl QuoteSender for DryRunSender {
    type Error = ();
    fn send(&mut self, quote: QuoteUpdate, priority_fee_lamports: u64) -> Result<(), Self::Error> {
        self.sent.push((quote, priority_fee_lamports));
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn ewma_is_deterministic() {
        let a = VolatilityState::default().update(100 * Q64, 9400, 9900, 4);
        let b = VolatilityState::default().update(100 * Q64, 9400, 9900, 4);
        assert_eq!(a, b);
    }
    #[test]
    fn quote_and_update_gate_are_deterministic() {
        let t = OracleTick {
            slot: 10,
            publish_time: 10,
            price_q64: 150 * Q64,
            confidence_bps: 1,
        };
        let q = compute_quote(
            t,
            VolatilityState::default(),
            1_000,
            150_000,
            0,
            0,
            KeeperParams::default(),
        )
        .unwrap();
        assert!(should_update(None, &q, 5, 10));
        assert!(!should_update(Some(q), &q, 5, 10));
    }
    #[test]
    fn priority_fee_increases_for_jump() {
        assert!(priority_fee_lamports(1 << 60, 100, true) > priority_fee_lamports(0, 100, false));
    }
    #[test]
    fn update_payload_matches_anchor_shape() {
        let t = OracleTick {
            slot: 10,
            publish_time: 10,
            price_q64: 150 * Q64,
            confidence_bps: 1,
        };
        let q = compute_quote(
            t,
            VolatilityState::default(),
            1_000,
            150_000,
            0,
            0,
            KeeperParams::default(),
        )
        .unwrap();
        let payload = encode_update_quote_instruction(&q);
        assert_eq!(&payload[..8], &Sha256::digest(b"global:update_quote")[..8]);
        assert_eq!(
            payload.len(),
            8 + 8 + 8 + 16 + 4 + 16 + 16 + 16 + LEVELS * 8 + LEVELS * 48
        );
    }
    #[test]
    fn inventory_skew_is_decimal_aware() {
        // 1000 SOL (9 decimals) against 150,000 USDC (6 decimals) at 150 USDC.
        let tick = OracleTick {
            slot: 1,
            publish_time: 1,
            price_q64: 150 * Q64,
            confidence_bps: 1,
        };
        let params = KeeperParams {
            base_atom_scale: 1_000,
            ..KeeperParams::default()
        };
        let balanced = compute_quote(
            tick,
            VolatilityState::default(),
            1_000_000_000_000,
            150_000_000_000,
            0,
            0,
            params,
        )
        .unwrap();
        assert_eq!(
            balanced.reservation_sqrt_price, balanced.anchor_sqrt_price,
            "a balanced vault must quote at the anchor"
        );
    }

    #[test]
    fn directional_addon_marks_the_stale_side() {
        let tick = OracleTick {
            slot: 2,
            publish_time: 2,
            price_q64: 150 * Q64,
            confidence_bps: 1,
        };
        let up = compute_quote(
            tick,
            VolatilityState::default(),
            1_000,
            150_000,
            0,
            149 * Q64,
            KeeperParams::default(),
        )
        .unwrap();
        assert!(up.ask_extra_bps > 0 && up.bid_extra_bps == 0);
        let down = compute_quote(
            OracleTick {
                price_q64: 148 * Q64,
                ..tick
            },
            VolatilityState::default(),
            1_000,
            150_000,
            0,
            149 * Q64,
            KeeperParams::default(),
        )
        .unwrap();
        assert!(down.ask_extra_bps == 0 && down.bid_extra_bps > 0);
    }
}
