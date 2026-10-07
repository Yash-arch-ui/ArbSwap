//! Deterministic P3 keeper core.
//!
//! The transport is intentionally behind `QuoteSender`: replay and dry-run are
//! fully usable without an RPC dependency, while a Solana sender can be added
//! without changing quote calculation. All quote inputs and outputs are integer
//! fixed-point values, matching the on-chain `arb-math` conventions.

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
    pub fn update(self, price_q64: u128, short_lambda_bps: u32, medium_lambda_bps: u32, jump_multiple: u128) -> Self {
        if self.previous_price_q64 == 0 {
            return Self { previous_price_q64: price_q64, ..self };
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
        Self { variance_short_q64: short, variance_medium_q64: medium, previous_price_q64: price_q64, jump: sigma > 0 && ret > sigma.saturating_mul(jump_multiple) }
    }

    pub fn sigma_q64(self) -> u128 { sqrt_q64(self.variance_short_q64).unwrap_or(u128::MAX) }
}

fn ewma(old: u128, sample: u128, lambda_bps: u32) -> u128 {
    let l = lambda_bps as u128;
    (old.saturating_mul(l).saturating_add(sample.saturating_mul(BPS.saturating_sub(l)))) / BPS
}

fn mul_q64(a: u128, b: u128) -> u128 { U256::mul_u128(a, b).shr(64).to_u128().unwrap_or(u128::MAX) }

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct KeeperParams {
    pub spread_floor_bps: u32,
    pub spread_max_bps: u32,
    pub inventory_coeff_bps: u32,
    pub volatility_coeff_bps: u32,
    pub confidence_coeff_bps: u32,
    pub age_coeff_bps: u32,
    pub jump_extra_bps: u32,
    pub utilization_bps: u32,
    pub sigma_target_q64: u128,
    pub grace_slots: u64,
    pub expiry_slots: u64,
    pub offsets_bps: [u32; LEVELS],
    pub weights_bps: [u32; LEVELS],
}

impl Default for KeeperParams {
    fn default() -> Self {
        Self { spread_floor_bps: 1, spread_max_bps: 50, inventory_coeff_bps: 5, volatility_coeff_bps: 2, confidence_coeff_bps: 1, age_coeff_bps: 1, jump_extra_bps: 5, utilization_bps: 5_000, sigma_target_q64: 1 << 60, grace_slots: 2, expiry_slots: 10, offsets_bps: [2, 5, 10, 20, 40, 80], weights_bps: [1_000, 1_500, 2_000, 2_000, 2_000, 1_500] }
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
    put_u32(&mut data, 0);
    put_u32(&mut data, 0);
    put_u32(&mut data, update.depth_mult_bps);
    for offset in update.offsets_bps { put_u32(&mut data, offset); }
    for weight in update.weights_bps { put_u32(&mut data, weight); }
    for level in &update.levels {
        put_u128(&mut data, level.sqrt_lo);
        put_u128(&mut data, level.sqrt_hi);
        put_u128(&mut data, level.liquidity);
    }
    data
}

fn put_u32(out: &mut Vec<u8>, value: u32) { out.extend_from_slice(&value.to_le_bytes()); }
fn put_u64(out: &mut Vec<u8>, value: u64) { out.extend_from_slice(&value.to_le_bytes()); }
fn put_i64(out: &mut Vec<u8>, value: i64) { out.extend_from_slice(&value.to_le_bytes()); }
fn put_u128(out: &mut Vec<u8>, value: u128) { out.extend_from_slice(&value.to_le_bytes()); }

pub fn compute_quote(tick: OracleTick, state: VolatilityState, base: u128, quote: u128, age: u64, params: KeeperParams) -> Option<QuoteUpdate> {
    if tick.price_q64 == 0 || base == 0 || quote == 0 { return None; }
    let price_value = U256::mul_u128(base, tick.price_q64).to_u128()?;
    let denominator = price_value.checked_add(quote)?;
    let q_bps: i128 = if price_value >= quote { ((price_value - quote).saturating_mul(BPS) / denominator).min(BPS) as i128 } else { -(((quote - price_value).saturating_mul(BPS) / denominator).min(BPS) as i128) };
    let skew = (params.inventory_coeff_bps as i128).saturating_mul(q_bps) / BPS as i128;
    let reservation_factor = if skew >= 0 { BPS.saturating_sub(skew as u128) } else { BPS.saturating_add((-skew) as u128) };
    let reservation_price = mul_div(tick.price_q64, reservation_factor, BPS)?;
    let sigma = state.sigma_q64();
    let vol_bps = mul_div(sigma, 10_000, Q64)?.min(u32::MAX as u128) as u32;
    let mut spread = params.spread_floor_bps.saturating_add((params.volatility_coeff_bps as u64 * vol_bps as u64 / BPS as u64) as u32);
    spread = spread.saturating_add(params.confidence_coeff_bps.saturating_mul(tick.confidence_bps) / BPS as u32);
    spread = spread.saturating_add(params.age_coeff_bps.saturating_mul(age.saturating_sub(params.grace_slots) as u32));
    if state.jump { spread = spread.saturating_add(params.jump_extra_bps); }
    spread = spread.min(params.spread_max_bps);
    let depth: u128 = if sigma == 0 { BPS } else { mul_div(params.sigma_target_q64, BPS, sigma)?.min(BPS) };
    let reservation_sqrt = sqrt_q64(reservation_price).ok()?;
    let anchor_sqrt = sqrt_q64(tick.price_q64).ok()?;
    let mut levels = [Level { sqrt_lo: 0, sqrt_hi: 0, liquidity: 0 }; LEVELS];
    let base_capacity = base.saturating_mul(params.utilization_bps as u128).saturating_mul(depth as u128) / (BPS * BPS);
    let mut previous = 0u32;
    for i in 0..LEVELS {
        let lo_factor = BPS + spread as u128 + previous as u128;
        let hi_factor = BPS + spread as u128 + params.offsets_bps[i] as u128;
        let lo_price = mul_div(reservation_price, lo_factor, BPS)?;
        let hi_price = mul_div(reservation_price, hi_factor, BPS)?;
        let lo = sqrt_q64(lo_price).ok()?;
        let hi = sqrt_q64(hi_price).ok()?;
        let capacity = base_capacity.saturating_mul(params.weights_bps[i] as u128) / BPS;
        let liquidity = if hi > lo { mul_div(mul_div(capacity, lo, 1)?, hi, hi - lo)? } else { return None };
        levels[i] = Level { sqrt_lo: lo, sqrt_hi: hi, liquidity };
        previous = params.offsets_bps[i];
    }
    Some(QuoteUpdate { slot: tick.slot, publish_time: tick.publish_time, oracle_price_q64: tick.price_q64, confidence_bps: tick.confidence_bps, anchor_sqrt_price: anchor_sqrt, reservation_sqrt_price: reservation_sqrt, half_spread_bps: spread, depth_mult_bps: depth as u32, levels, offsets_bps: params.offsets_bps, weights_bps: params.weights_bps })
}

fn mul_div(a: u128, b: u128, c: u128) -> Option<u128> { if c == 0 { None } else { U256::mul_u128(a, b).div_rem(arb_math::wide::U256::from_u128(c))?.0.to_u128() } }

pub fn should_update(previous: Option<QuoteUpdate>, next: &QuoteUpdate, threshold_bps: u32, max_age_slots: u64) -> bool {
    let Some(old) = previous else { return true };
    if next.slot.saturating_sub(old.slot) >= max_age_slots { return true; }
    let diff = if next.oracle_price_q64 >= old.oracle_price_q64 { next.oracle_price_q64 - old.oracle_price_q64 } else { old.oracle_price_q64 - next.oracle_price_q64 };
    diff.saturating_mul(BPS) >= old.oracle_price_q64.saturating_mul(threshold_bps as u128)
}

pub fn priority_fee_lamports(sigma_q64: u128, base: u64, jump: bool) -> u64 {
    let urgency = sigma_q64.saturating_mul(10_000) / Q64;
    let mut fee = base.saturating_add((base as u128).saturating_mul(urgency).min(u64::MAX as u128) as u64 / 10_000);
    if jump { fee = fee.saturating_mul(2); }
    fee
}

pub trait QuoteSender { type Error; fn send(&mut self, quote: QuoteUpdate, priority_fee_lamports: u64) -> Result<(), Self::Error>; }

#[derive(Default)]
pub struct DryRunSender { pub sent: Vec<(QuoteUpdate, u64)> }
impl QuoteSender for DryRunSender { type Error = (); fn send(&mut self, quote: QuoteUpdate, priority_fee_lamports: u64) -> Result<(), Self::Error> { self.sent.push((quote, priority_fee_lamports)); Ok(()) } }

#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn ewma_is_deterministic() { let a = VolatilityState::default().update(100 * Q64, 9400, 9900, 4); let b = VolatilityState::default().update(100 * Q64, 9400, 9900, 4); assert_eq!(a, b); }
    #[test] fn quote_and_update_gate_are_deterministic() { let t = OracleTick { slot: 10, publish_time: 10, price_q64: 150 * Q64, confidence_bps: 1 }; let q = compute_quote(t, VolatilityState::default(), 1_000, 150_000, 0, KeeperParams::default()).unwrap(); assert!(should_update(None, &q, 5, 10)); assert!(!should_update(Some(q), &q, 5, 10)); }
    #[test] fn priority_fee_increases_for_jump() { assert!(priority_fee_lamports(1 << 60, 100, true) > priority_fee_lamports(0, 100, false)); }
    #[test] fn update_payload_matches_anchor_shape() {
        let t = OracleTick { slot: 10, publish_time: 10, price_q64: 150 * Q64, confidence_bps: 1 };
        let q = compute_quote(t, VolatilityState::default(), 1_000, 150_000, 0, KeeperParams::default()).unwrap();
        let payload = encode_update_quote_instruction(&q);
        assert_eq!(&payload[..8], &Sha256::digest(b"global:update_quote")[..8]);
        assert_eq!(payload.len(), 8 + 8 + 8 + 16 + 4 + 16 + 16 + 16 + LEVELS * 8 + LEVELS * 48);
    }
}
