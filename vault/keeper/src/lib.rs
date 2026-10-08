//! Deterministic P3 keeper core.
//!
//! The transport is intentionally behind `QuoteSender`: replay and dry-run are
//! fully usable without an RPC dependency, while a Solana sender can be added
//! without changing quote calculation. All quote inputs and outputs are integer
//! fixed-point values, matching the on-chain `arb-math` conventions.
//!
//! Parity with `simulation/reference/quote_math.py` (Task 5):
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
use solana_address::Address;
use solana_hash::Hash;
use solana_instruction::{AccountMeta, Instruction};
use solana_keypair::Keypair;
use solana_transaction::Transaction;

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
            spread_floor_bps: 2,
            spread_min_bps: 2,
            spread_max_bps: 50,
            inventory_coeff_bps: 5,
            volatility_coeff_bps: 10_000,
            confidence_coeff_bps: 10_000,
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
fn directional_addon(price_q64: u128, previous_price_q64: u128, coeff_bps: u32) -> (u32, u32) {
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

/// Item 3: LP-available reserves for ladder sizing. The insurance, keeper and
/// protocol buckets are claims on the reserves, so the keeper must size the
/// ladder from the reserve *net* of those buckets, never the gross reserve.
/// Returns `(base_available, quote_available)`, saturating at zero.
#[allow(clippy::too_many_arguments)]
pub fn available_reserves(
    base: u128,
    quote: u128,
    insurance_base: u128,
    insurance_quote: u128,
    keeper_base: u128,
    keeper_quote: u128,
    protocol_base: u128,
    protocol_quote: u128,
) -> (u128, u128) {
    let base_liab = insurance_base
        .saturating_add(keeper_base)
        .saturating_add(protocol_base);
    let quote_liab = insurance_quote
        .saturating_add(keeper_quote)
        .saturating_add(protocol_quote);
    (
        base.saturating_sub(base_liab),
        quote.saturating_sub(quote_liab),
    )
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
    // F-09: match `quote_math.compute_half_spread` exactly. The reference works
    // in price *fractions* with dimensionless coefficients; its term is
    // `coeff * signal(grasp as a fraction)`. The keeper stores each coefficient
    // as `reference_coeff * 10_000`, so the bps term is
    // `coefficient_bps * signal_fraction`. (The earlier form multiplied by 10^4
    // again, so the volatility term was always zero for realistic sigma.)
    let vol_term_bps = mul_div(params.volatility_coeff_bps as u128, sigma, Q64)?;
    let inventory_term_bps =
        (params.inventory_coeff_bps as u128).saturating_mul(q_bps.unsigned_abs()) / BPS;
    let confidence_term_bps =
        (params.confidence_coeff_bps as u128).saturating_mul(tick.confidence_bps as u128) / BPS;
    let age_term_bps = (params.age_coeff_bps as u128)
        .saturating_mul(age.saturating_sub(params.grace_slots) as u128);
    let raw_spread = (params.spread_floor_bps as u128)
        .saturating_add(vol_term_bps)
        .saturating_add(inventory_term_bps)
        .saturating_add(confidence_term_bps)
        .saturating_add(age_term_bps)
        .saturating_add(if state.jump {
            params.jump_extra_bps as u128
        } else {
            0
        });
    let spread = raw_spread
        .min(params.spread_max_bps as u128)
        .max(params.spread_min_bps as u128);

    let (ask_extra_bps, bid_extra_bps) = directional_addon(
        tick.price_q64,
        previous_price_q64,
        params.directional_coeff_bps,
    );
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

/// Tight compute-unit limit for an `update_quote` transaction. The measured
/// instruction cost is 12,802 CU (ASSUMPTIONS A-17), so 60,000 leaves room for
/// the Pyth verification + account deserialisation that must fit in the same
/// transaction (the program verifies the update in-band).
pub const MAX_UPDATE_COMPUTE_UNITS: u32 = 60_000;

/// A streaming price source (Pyth Hermes or a replayed feed).
pub trait PriceSource {
    type Error;
    /// Latest tick, tagged with the slot it was read at. `Ok(None)` means the
    /// source has no usable tick this round (stale, wide, or unparseable), and
    /// the loop must skip the update and let the quote expire (safe).
    fn latest(&self, slot: u64) -> Result<Option<OracleTick>, Self::Error>;
}

/// Convert a Pyth `(price, exponent)` pair to Q64.64, floor. Mirrors the
/// program's `pyth_price_q64`.
pub fn pyth_decimal_to_q64(value: i64, exponent: i32) -> Option<u128> {
    if value <= 0 {
        return None;
    }
    let magnitude = value as u128;
    if exponent >= 0 {
        let scale = 10u128.checked_pow(exponent as u32)?;
        magnitude.checked_mul(scale)?.checked_mul(Q64)
    } else {
        let divisor = 10u128.checked_pow((-exponent) as u32)?;
        magnitude.checked_mul(Q64)?.checked_div(divisor)
    }
}

/// `ceil(conf * 10_000 / price)` in bps, matching the program's
/// `decoded_conf_bps`.
pub fn confidence_bps(conf: u64, price: i64) -> u32 {
    if price <= 0 {
        return u32::MAX;
    }
    let numerator = (conf as u128).saturating_mul(BPS);
    numerator.div_ceil(price as u128).min(u32::MAX as u128) as u32
}

/// Parse a Pyth Hermes `/v2/updates/price/latest` response body.
pub fn parse_hermes(body: &str, slot: u64) -> Option<OracleTick> {
    let value: serde_json::Value = serde_json::from_str(body).ok()?;
    let price = value.get("parsed")?.as_array()?.first()?.get("price")?;
    let raw: i64 = price.get("price")?.as_str()?.parse().ok()?;
    let conf: u64 = price.get("conf")?.as_str()?.parse().ok()?;
    let exponent: i32 = price.get("expo")?.as_i64()? as i32;
    let publish_time: i64 = price.get("publish_time")?.as_i64()?;
    Some(OracleTick {
        slot,
        publish_time,
        price_q64: pyth_decimal_to_q64(raw, exponent)?,
        confidence_bps: confidence_bps(conf, raw),
    })
}

/// Hermes HTTP source with an injected transport (`fetch(url) -> body`), so the
/// parser and the request URL are testable without a network.
pub struct HermesSource<F> {
    pub url: String,
    pub fetch: F,
}

impl<F, E> PriceSource for HermesSource<F>
where
    F: Fn(&str) -> Result<String, E>,
{
    type Error = E;
    fn latest(&self, slot: u64) -> Result<Option<OracleTick>, Self::Error> {
        let body = (self.fetch)(&self.url)?;
        Ok(parse_hermes(&body, slot))
    }
}

/// Adaptive priority fee: scales the base fee with volatility urgency and
/// doubles on a jump, clipped to `[floor, cap]` so a calm keeper is cheap and a
/// stressed one cannot overpay without bound.
pub fn adaptive_priority_fee(sigma_q64: u128, base: u64, jump: bool, floor: u64, cap: u64) -> u64 {
    let raw = priority_fee_lamports(sigma_q64, base, jump);
    raw.max(floor).min(cap.max(floor))
}

/// Everything needed to build a real `update_quote` transaction, resolved from
/// the program id and vault address (PDAs are derived).
#[derive(Clone, Debug)]
pub struct UpdateQuotePlan {
    pub program_id: Address,
    pub keeper: Address,
    pub vault: Address,
    pub config: Address,
    pub quote_state: Address,
    pub price_update: Address,
    pub keeper_bond: Address,
    pub recent_blockhash: Hash,
    pub compute_unit_limit: u32,
}

/// Build the signed `update_quote` transaction: a compute-budget limit and
/// price instruction followed by the quote update. Deterministic and testable
/// without a network (the caller supplies the already-derived PDAs).
pub fn build_update_quote_transaction(
    plan: &UpdateQuotePlan,
    keeper: &Keypair,
    quote: &QuoteUpdate,
    priority_fee_micro_lamports_per_cu: u64,
) -> Transaction {
    let data = encode_update_quote_instruction(quote);
    let update_quote = Instruction {
        program_id: plan.program_id,
        accounts: vec![
            AccountMeta::new(plan.keeper, true),
            AccountMeta::new(plan.vault, false),
            AccountMeta::new_readonly(plan.config, false),
            AccountMeta::new(plan.quote_state, false),
            AccountMeta::new_readonly(plan.price_update, false),
            AccountMeta::new_readonly(plan.keeper_bond, false),
        ],
        data,
    };
    let instructions = vec![
        solana_compute_budget_interface::ComputeBudgetInstruction::set_compute_unit_limit(
            plan.compute_unit_limit,
        ),
        solana_compute_budget_interface::ComputeBudgetInstruction::set_compute_unit_price(
            priority_fee_micro_lamports_per_cu,
        ),
        update_quote,
    ];
    let mut transaction = Transaction::new_with_payer(&instructions, Some(&plan.keeper));
    // `Hash` is not `Copy` in every feature configuration, so clone it.
    #[allow(clippy::clone_on_copy)]
    transaction.sign(&[keeper], plan.recent_blockhash.clone());
    transaction
}

/// A keeper sender for a live RPC: the caller injects the transport (a closure
/// that submits a `Transaction`) and a blockhash refresher, so this crate needs
/// no RPC dependency and the signed bytes are testable offline.
///
/// Retries refresh the blockhash and re-sign on every attempt; a re-sent
/// transaction with the same signature is de-duplicated by the cluster, so the
/// retry loop cannot double-spend an update.
pub struct LiveSender<B, S> {
    pub plan: UpdateQuotePlan,
    pub keeper: Keypair,
    pub priority_fee_micro_lamports_per_cu: u64,
    pub refresh_blockhash: B,
    pub submit: S,
    pub max_attempts: u32,
}

impl<B, S, E> QuoteSender for LiveSender<B, S>
where
    B: FnMut() -> Result<Hash, E>,
    S: FnMut(Transaction) -> Result<(), E>,
{
    type Error = E;
    fn send(&mut self, quote: QuoteUpdate, priority_fee_lamports: u64) -> Result<(), E> {
        let _ = priority_fee_lamports;
        let attempts = self.max_attempts.max(1);
        let mut last = None;
        for _ in 0..attempts {
            // Fresh blockhash each attempt; expired blockhashes are the common
            // cause of a dropped update.
            let blockhash = (self.refresh_blockhash)()?;
            self.plan.recent_blockhash = blockhash;
            let transaction = build_update_quote_transaction(
                &self.plan,
                &self.keeper,
                &quote,
                self.priority_fee_micro_lamports_per_cu,
            );
            match (self.submit)(transaction) {
                Ok(()) => return Ok(()),
                Err(error) => last = Some(error),
            }
        }
        Err(last.expect("at least one attempt"))
    }
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
    fn available_reserves_excludes_the_buckets() {
        // 1_000 base / 150_000 quote with buckets of 100 base and 20_000 quote.
        let (b, q) = available_reserves(1_000, 150_000, 40, 10_000, 30, 5_000, 30, 5_000);
        assert_eq!(b, 900); // 1000 - (40+30+30)
        assert_eq!(q, 130_000); // 150000 - (10000+5000+5000)
                                // Saturates rather than underflowing when liabilities exceed reserves.
        let (b, q) = available_reserves(10, 10, 10, 10, 10, 10, 10, 10);
        assert_eq!((b, q), (0, 0));
    }
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

    #[test]
    fn live_transaction_builder_emits_budget_and_update() {
        use solana_signer::Signer;
        let keeper = Keypair::new();
        let plan = UpdateQuotePlan {
            program_id: Address::new_from_array([1u8; 32]),
            keeper: keeper.pubkey(),
            vault: Address::new_from_array([2u8; 32]),
            config: Address::new_from_array([3u8; 32]),
            quote_state: Address::new_from_array([4u8; 32]),
            price_update: Address::new_from_array([5u8; 32]),
            keeper_bond: Address::new_from_array([6u8; 32]),
            recent_blockhash: Hash::default(),
            compute_unit_limit: 60_000,
        };
        let tick = OracleTick {
            slot: 1,
            publish_time: 1,
            price_q64: 150 * Q64,
            confidence_bps: 1,
        };
        let quote = compute_quote(
            tick,
            VolatilityState::default(),
            1_000,
            150_000,
            0,
            0,
            KeeperParams::default(),
        )
        .unwrap();
        let transaction = build_update_quote_transaction(&plan, &keeper, &quote, 1_000);
        assert_eq!(transaction.message.instructions.len(), 3);
        let update = &transaction.message.instructions[2];
        assert_eq!(update.data, encode_update_quote_instruction(&quote));
        assert_eq!(
            transaction.message.account_keys[update.program_id_index as usize],
            plan.program_id
        );
        // The first two instructions are ComputeBudget limit + price.
        assert_eq!(
            transaction.message.account_keys
                [transaction.message.instructions[0].program_id_index as usize],
            solana_compute_budget_interface::ID
        );
        assert!(!transaction.signatures.is_empty());
    }

    #[test]
    fn parse_hermes_extracts_the_price_and_confidence() {
        let body = r#"{"parsed":[{"id":"feed","price":{"price":"15000000000","conf":"1","expo":-8,"publish_time":1000}}]}"#;
        let tick = parse_hermes(body, 5).expect("parsed");
        assert_eq!(tick.price_q64, 150 * Q64);
        assert_eq!(tick.confidence_bps, 1);
        assert_eq!(tick.publish_time, 1000);
        assert_eq!(tick.slot, 5);
        assert!(parse_hermes("not json", 1).is_none());
        assert!(parse_hermes(r#"{"parsed":[]}"#, 1).is_none());
    }

    #[test]
    fn pyth_decimal_conversion_matches_the_program() {
        assert_eq!(pyth_decimal_to_q64(150, 0), Some(150 * Q64));
        assert_eq!(pyth_decimal_to_q64(15_000_000_000, -8), Some(150 * Q64));
        assert_eq!(pyth_decimal_to_q64(-1, 0), None);
        assert_eq!(confidence_bps(1, 15_000_000_000), 1);
        assert_eq!(confidence_bps(0, 15_000_000_000), 0);
    }

    #[test]
    fn adaptive_priority_fee_is_clipped() {
        // Calm: sigma small -> floor applies.
        assert_eq!(
            adaptive_priority_fee(0, 1_000, false, 5_000, 1_000_000),
            5_000
        );
        // Jump doubles and can exceed the cap, so the cap applies.
        assert_eq!(
            adaptive_priority_fee(1 << 64, u64::MAX / 2, true, 1_000, 10_000),
            10_000
        );
    }

    #[test]
    fn live_sender_retries_with_a_fresh_blockhash() {
        use solana_signer::Signer;
        use std::cell::Cell;
        use std::rc::Rc;
        let keeper = Keypair::new();
        let attempts = Rc::new(Cell::new(0u32));
        let refreshes = Rc::new(Cell::new(0u32));
        let plan = UpdateQuotePlan {
            program_id: Address::new_from_array([1u8; 32]),
            keeper: keeper.pubkey(),
            vault: Address::new_from_array([2u8; 32]),
            config: Address::new_from_array([3u8; 32]),
            quote_state: Address::new_from_array([4u8; 32]),
            price_update: Address::new_from_array([5u8; 32]),
            keeper_bond: Address::new_from_array([6u8; 32]),
            recent_blockhash: Hash::default(),
            compute_unit_limit: MAX_UPDATE_COMPUTE_UNITS,
        };
        let quote = compute_quote(
            OracleTick {
                slot: 1,
                publish_time: 1,
                price_q64: 150 * Q64,
                confidence_bps: 1,
            },
            VolatilityState::default(),
            1_000,
            150_000,
            0,
            0,
            KeeperParams::default(),
        )
        .unwrap();

        let counter = attempts.clone();
        let refresher = refreshes.clone();
        let mut sender = LiveSender {
            plan,
            keeper,
            priority_fee_micro_lamports_per_cu: 1_000,
            max_attempts: 3,
            refresh_blockhash: move || {
                refresher.set(refresher.get() + 1);
                Ok(Hash::new_from_array([refresher.get() as u8; 32]))
            },
            submit: move |_tx| {
                counter.set(counter.get() + 1);
                if counter.get() < 3 {
                    Err("rpc busy")
                } else {
                    Ok(())
                }
            },
        };
        sender
            .send(quote, 1_000)
            .expect("succeeds on the third try");
        assert_eq!(attempts.get(), 3);
        assert_eq!(refreshes.get(), 3, "blockhash refreshed per attempt");
    }
}
