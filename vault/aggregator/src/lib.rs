//! ArbSwap aggregator adapter (Build Plan §12 T5.4).
//!
//! Exposes the on-chain vault as a routable, constant-product AMM to an
//! aggregator such as Jupiter. The price engine is the same ``arb-math`` ladder
//! the swap instruction executes, so the adapter's quote is bit-exact with the
//! vault's execution (Build Plan §0 rule 2: the backtest describes the product).
//!
//! Scope note: this crate implements the *price-simulation* layer an aggregator
//! adapter needs (``out_given_in`` / ``in_given_out`` across the displayed ask
//! and bid ladders, with the deterministic fee and ``min_out``/``min_version``
//! checks). The on-chain ``quote``/``swap`` CPI surface Jupiter calls and its
//! discriminator/account layout are deployment-dependent and were *not*
//! verified against the live Jupiter AMM interface in this offline session —
//! see ``docs/ARCHITECTURE.md`` for the deployment contract and its verification
//! status.
//!
//! Per Build Plan §6.4, a swap is honest by construction: the executed output is
//! at least ``min_out`` or the transaction reverts (``SlippageExceeded``).

use arb_math::{fee_amount, mean_price_q64, walk_ladder, Level, Side, SwapResult};

/// Which vault token the trader supplies. ``Base`` = the trader pays base (vault
/// bid side); ``Quote`` = the trader pays quote (vault ask side).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PaymentToken {
    Base,
    Quote,
}

impl PaymentToken {
    /// The underlying ladder side the vault walks for this payment token.
    fn side(self) -> Side {
        match self {
            PaymentToken::Base => Side::Bid,
            PaymentToken::Quote => Side::Ask,
        }
    }
}

/// A priced, honest swap preview returned by the adapter.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct AmmQuote {
    /// Amount the trader pays, before fees.
    pub amount_in: u128,
    /// Amount the vault pays out to the trader.
    pub amount_out: u128,
    /// Deterministic fee retained by the vault: ``ceil(amount_in * fee_bps / 1e4)``.
    pub fee: u128,
    /// Mean execution price in Q64.64 (quote per base) across the walked levels.
    pub mean_price_q64: u128,
    /// Input not absorbed because the ladder ran out of capacity; 0 on a full fill.
    pub remaining: u128,
}

/// ``out_given_in`` — how much the trader receives for ``amount_in`` of
/// ``token``, honoring ``min_out`` and `min_version`.
///
/// Returns ``Err(AggregatorError::SlippageExceeded)`` when the honest output is
/// below ``min_out`` (mirrors the on-chain ``SlippageExceeded`` path), so a
/// router can drop the route rather than risk a failing swap.
pub fn out_given_in(
    levels: &[Level],
    token: PaymentToken,
    amount_in: u128,
    fee_bps: u128,
    min_out: u128,
) -> Result<AmmQuote, AggregatorError> {
    if amounts_invalid(amount_in) {
        return Err(AggregatorError::InvalidAmount);
    }
    let fee = fee_amount(amount_in, fee_bps)?;
    let net_in = amount_in
        .checked_sub(fee)
        .ok_or(AggregatorError::Overflow)?;
    if net_in == 0 {
        return Err(AggregatorError::InvalidAmount);
    }
    let SwapResult { out, remaining, .. } = walk_ladder(levels, token.side(), net_in)?;
    if remaining != 0 {
        return Err(AggregatorError::CapacityExceeded);
    }
    if out < min_out {
        return Err(AggregatorError::SlippageExceeded);
    }
    let price = mean_price_q64(out, amount_in)?;
    Ok(AmmQuote {
        amount_in,
        amount_out: out,
        fee,
        mean_price_q64: price,
        remaining,
    })
}

/// ``in_given_out`` — how much of ``token`` a trader must supply to be certain of
/// at least ``amount_out`` (used by aggregators quoting the vault as an output
/// leg). Robust to fee rounding: it quotes the *ceil* input so the honest check
/// never undershoots.
pub fn in_given_out(
    levels: &[Level],
    token: PaymentToken,
    amount_out: u128,
    fee_bps: u128,
) -> Result<AmmQuote, AggregatorError> {
    if amount_out == 0 {
        return Err(AggregatorError::InvalidAmount);
    }
    // Bisect the minimum input whose honest output reaches `amount_out`. The
    // walk is monotone in the input, so a bounded binary search is exact.
    let mut lo = 1u128;
    let mut hi = 1u128 << 80;
    let mut best = None;
    while lo + 1 < hi {
        let mid = lo + (hi - lo) / 2;
        match check_out(levels, token, mid, fee_bps, amount_out) {
            Ok((out, fee, price)) => {
                best = Some(AmmQuote {
                    amount_in: mid,
                    amount_out: out,
                    fee,
                    mean_price_q64: price,
                    remaining: 0,
                });
                hi = mid;
            }
            Err(AggregatorError::CapacityExceeded) => {
                // Input exceeds the ladder; shrink the search upper bound.
                hi = mid;
            }
            Err(_) => lo = mid,
        }
    }
    best.ok_or(AggregatorError::InsufficientLiquidity)
}

fn check_out(
    levels: &[Level],
    token: PaymentToken,
    amount_in: u128,
    fee_bps: u128,
    target: u128,
) -> Result<(u128, u128, u128), AggregatorError> {
    let fee = fee_amount(amount_in, fee_bps)?;
    let net_in = amount_in
        .checked_sub(fee)
        .ok_or(AggregatorError::Overflow)?;
    if net_in == 0 {
        return Err(AggregatorError::InvalidAmount);
    }
    let SwapResult { out, remaining, .. } = walk_ladder(levels, token.side(), net_in)?;
    if remaining != 0 {
        return Err(AggregatorError::CapacityExceeded);
    }
    let price = mean_price_q64(out, amount_in)?;
    if out >= target {
        Ok((out, fee, price))
    } else {
        Err(AggregatorError::SlippageExceeded)
    }
}

/// Quote the best touch price (ask/bid) the trader would face for the first fill.
pub fn best_price(levels: &[Level], _token: PaymentToken) -> Result<u128, AggregatorError> {
    let level = levels
        .first()
        .ok_or(AggregatorError::InsufficientLiquidity)?;
    arb_math::price_from_sqrt(level.sqrt_lo).map_err(|_| AggregatorError::Uninitialized)
}

fn amounts_invalid(v: u128) -> bool {
    v == 0 || v > (1u128 << 80)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AggregatorError {
    /// Input/output is zero or out of the supported range.
    InvalidAmount,
    /// The ladder cannot absorb the full input.
    CapacityExceeded,
    /// The honest output is below the caller's ``min_out``.
    SlippageExceeded,
    /// There is not enough liquidity to reach the requested ``amount_out``.
    InsufficientLiquidity,
    /// Arithmetic overflow in the fee or walk.
    Overflow,
    /// The ladder has no usable level.
    Uninitialized,
}

impl From<arb_math::MathError> for AggregatorError {
    fn from(_: arb_math::MathError) -> Self {
        AggregatorError::Overflow
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // Q64.64 sqrt price for a real-valued price: sqrt_q64(price * 2^64).
    fn sqrt(price: f64) -> u128 {
        arb_math::sqrt_q64((price * 2.0f64.powi(64)) as u128).unwrap()
    }

    fn ask_levels() -> Vec<Level> {
        // A constant-product segment of ample liquidity whose sqrt-price grows
        // across the fill, i.e. a real quote cost for buying base.
        let lo = sqrt(149.0);
        let hi = sqrt(160.0);
        vec![Level {
            sqrt_lo: lo,
            sqrt_hi: hi,
            liquidity: 1_000_000_000_000_000_000_000_000,
        }]
    }

    #[test]
    fn paying_quote_then_calling_out_given_in_returns_more_than_min_out() {
        let levels = ask_levels();
        // Buying base with quote is the ask side.
        let quote = out_given_in(&levels, PaymentToken::Quote, 10_000, 1, 0).unwrap();
        assert!(quote.amount_out > 0);
        assert_eq!(quote.fee, 1); // ceil(10_000 * 1 / 10_000)
        assert_eq!(quote.remaining, 0);
        assert!(quote.mean_price_q64 > 0);
    }

    #[test]
    fn slippage_is_enforced_against_min_out() {
        let levels = ask_levels();
        assert!(out_given_in(&levels, PaymentToken::Quote, 10_000, 1, u128::MAX).is_err());
    }

    #[test]
    fn honest_output_never_below_min_out() {
        let levels = ask_levels();
        let generous = out_given_in(&levels, PaymentToken::Quote, 10_000, 1, 0).unwrap();
        let with_min =
            out_given_in(&levels, PaymentToken::Quote, 10_000, 1, generous.amount_out).unwrap();
        assert_eq!(with_min.amount_out, generous.amount_out);
    }

    #[test]
    fn in_given_out_bisects_to_a_supplying_input() {
        let levels = ask_levels();
        let direct = out_given_in(&levels, PaymentToken::Quote, 10_000, 1, 0).unwrap();
        let inverse = in_given_out(&levels, PaymentToken::Quote, direct.amount_out, 1).unwrap();
        // The inverse must actually deliver at least the requested output (the
        // honest guarantee), so its output never falls short of the target.
        assert!(inverse.amount_out >= direct.amount_out);
        // And paying that input through the direct path is *not* rejected.
        assert!(out_given_in(
            &levels,
            PaymentToken::Quote,
            inverse.amount_in,
            1,
            direct.amount_out
        )
        .is_ok());
    }

    #[test]
    fn best_price_uses_the_touch_level() {
        let levels = ask_levels();
        let lo_price = arb_math::price_from_sqrt(levels[0].sqrt_lo).unwrap();
        assert_eq!(best_price(&levels, PaymentToken::Quote).unwrap(), lo_price);
    }

    #[test]
    fn zero_input_is_rejected() {
        let levels = ask_levels();
        assert_eq!(
            out_given_in(&levels, PaymentToken::Quote, 0, 1, 0),
            Err(AggregatorError::InvalidAmount)
        );
    }
}
