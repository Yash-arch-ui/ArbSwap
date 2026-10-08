"""Research reference for Build Plan Section 5 (P1/T1.1).

This module intentionally uses ``float`` only for off-chain research quantities.
Token amounts and share accounting remain integers and use the vault-favouring
rounding rules from :mod:`fixed`.  The Rust/on-chain port must not copy the
floating-point implementation; it must match the golden vectors produced from
the same formulas using fixed-point inputs.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, replace
from typing import Literal

BPS = 10_000
Side = Literal["ask", "bid"]


@dataclass(frozen=True)
class QuoteParams:
    spread_floor: float = 0.0001
    spread_min: float = 0.00005
    spread_max: float = 0.005
    inventory_coeff: float = 0.0005
    volatility_coeff: float = 1.0
    confidence_coeff: float = 1.0
    age_coeff: float = 0.00001
    age_grace: float = 2.0
    jump_extra: float = 0.0005
    directional_coeff: float = 1.0
    utilization_max: float = 0.5
    sigma_target: float = 0.0001
    confidence_max_ratio: float = 0.001
    jump_cooldown_factor: float = 0.5
    grace_slots: float = 2.0
    expiry_slots: float = 10.0
    max_staleness: float = 2.0
    max_anchor_step: float = 0.005
    offsets_bps: tuple[int, ...] = (2, 5, 10, 20, 40, 80)
    weights_bps: tuple[int, ...] = (1_000, 1_500, 2_000, 2_000, 2_000, 1_500)

    def __post_init__(self) -> None:
        if len(self.offsets_bps) != len(self.weights_bps):
            raise ValueError("offset and weight counts must match")
        if sum(self.weights_bps) != BPS:
            raise ValueError("ladder weights must sum to 10,000 bps")
        if any(x < 0 for x in self.offsets_bps):
            raise ValueError("ladder offsets must be non-negative")
        if tuple(sorted(self.offsets_bps)) != self.offsets_bps:
            raise ValueError("ladder offsets must be monotonic")
        if not 0 < self.utilization_max <= 1:
            raise ValueError("utilization_max must be in (0, 1]")


@dataclass(frozen=True)
class VolatilityState:
    variance_short: float = 0.0
    variance_medium: float = 0.0
    previous_price: float | None = None
    jump_flag: bool = False

    def update(self, price: float, *, lam_short: float = 0.94,
               lam_medium: float = 0.99, jump_multiple: float = 4.0,
               step_seconds: float = 1.0) -> "VolatilityState":
        """One EWMA observation spaced ``step_seconds`` apart from the last one.

        The decay coefficients and the innovation are expressed **per second**,
        so the estimated variance rate does not depend on the simulation clock
        (both are unchanged at ``step_seconds == 1``).
        """
        if price <= 0 or not math.isfinite(price):
            raise ValueError("price must be finite and positive")
        if step_seconds <= 0:
            raise ValueError("step_seconds must be positive")
        if self.previous_price is None:
            return replace(self, previous_price=price, jump_flag=False)
        if self.previous_price <= 0:
            raise ValueError("previous price must be positive")
        ret = math.log(price / self.previous_price)
        decay_short = lam_short ** step_seconds
        decay_medium = lam_medium ** step_seconds
        innovation = ret * ret / step_seconds
        short = decay_short * self.variance_short + (1 - decay_short) * innovation
        medium = decay_medium * self.variance_medium + (1 - decay_medium) * innovation
        sigma = math.sqrt(short)
        threshold = jump_multiple * sigma * math.sqrt(step_seconds)
        jump = sigma > 0 and abs(ret) > threshold
        return VolatilityState(short, medium, price, jump)

    @property
    def sigma_short(self) -> float:
        return math.sqrt(self.variance_short)

    @property
    def sigma_medium(self) -> float:
        return math.sqrt(self.variance_medium)


@dataclass(frozen=True)
class LadderLevel:
    side: Side
    lo: float
    hi: float
    capacity: float
    offset_lo_bps: int
    offset_hi_bps: int
    liquidity: float


@dataclass(frozen=True)
class Quote:
    reference_price: float
    reservation_price: float
    half_spread: float
    ask_extra: float
    bid_extra: float
    depth_mult: float
    asks: tuple[LadderLevel, ...]
    bids: tuple[LadderLevel, ...]


def inventory_imbalance(base: float, quote: float, price: float) -> float:
    """Return q=(B*P-Q)/(B*P+Q), bounded to [-1,1]."""
    if min(base, quote, price) < 0 or base * price + quote <= 0:
        raise ValueError("reserves and price must be non-negative with value")
    return (base * price - quote) / (base * price + quote)


def reservation_price(price: float, inventory_q: float, inventory_coeff: float) -> float:
    """Apply the signed inventory skew from Section 5.3."""
    if price <= 0 or abs(inventory_q) > 1 + 1e-12:
        raise ValueError("invalid price or inventory imbalance")
    result = price * (1 - inventory_coeff * inventory_q)
    if result <= 0:
        raise ValueError("reservation price is not positive")
    return result


def compute_half_spread(*, sigma_short: float, inventory_q: float,
                        confidence: float, price: float, age: float,
                        jump_flag: bool, params: QuoteParams) -> float:
    """Compute and clamp Section 5.5 half-spread."""
    if price <= 0 or confidence < 0 or age < 0:
        raise ValueError("invalid spread inputs")
    raw = (
        params.spread_floor
        + params.volatility_coeff * sigma_short
        + params.inventory_coeff * abs(inventory_q)
        + params.confidence_coeff * confidence / price
        + params.age_coeff * max(0.0, age - params.age_grace)
        + (params.jump_extra if jump_flag else 0.0)
    )
    return min(params.spread_max, max(params.spread_min, raw))


def directional_addon(price: float, previous_price: float, *, coefficient: float) -> tuple[float, float]:
    """Return (ask_extra, bid_extra) from Section 5.6."""
    if price <= 0 or previous_price <= 0:
        raise ValueError("prices must be positive")
    move = (price - previous_price) / previous_price
    return coefficient * max(0.0, move), coefficient * max(0.0, -move)


def depth_multiplier(*, sigma_short: float, confidence: float, jump_flag: bool,
                     depth_budget: float, params: QuoteParams) -> float:
    """Apply the rule throttle and the normalized LVR budget cap."""
    if min(sigma_short, confidence, depth_budget) < 0:
        raise ValueError("throttle inputs must be non-negative")
    sigma_factor = 1.0 if sigma_short == 0 else min(1.0, params.sigma_target / sigma_short)
    confidence_factor = max(0.0, 1.0 - confidence / params.confidence_max_ratio)
    jump_factor = params.jump_cooldown_factor if jump_flag else 0.0
    rule = sigma_factor * confidence_factor * (1.0 - jump_factor)
    return min(1.0, max(0.0, rule), max(0.0, depth_budget))


def age_penalty(age: float, params: QuoteParams) -> float:
    """Extra spread fraction from quote age (Section 5.12)."""
    if age < 0:
        raise ValueError("age must be non-negative")
    return params.age_coeff * max(0.0, age - params.grace_slots)


def quote_expired(age: float, params: QuoteParams) -> bool:
    """True when a quote is past its expiry and must not fill (Section 5.12)."""
    if age < 0:
        raise ValueError("age must be non-negative")
    return age >= params.expiry_slots


def oracle_update_allowed(*, staleness: float, confidence_ratio: float,
                          anchor_step: float, params: QuoteParams) -> bool:
    """Reject an update that fails the Section 5.11 oracle guards."""
    if min(staleness, confidence_ratio, abs(anchor_step)) < 0:
        raise ValueError("oracle guards must be non-negative")
    return (
        staleness <= params.max_staleness
        and confidence_ratio <= params.confidence_max_ratio
        and abs(anchor_step) <= params.max_anchor_step
    )


def lvr_budget_value(revenue_per_second: float, gas_per_second: float,
                     sigma_short: float) -> float:
    """Return V_active <= 8*(R-gas)/sigma²; zero when the budget is non-positive."""
    if min(revenue_per_second, gas_per_second, sigma_short) < 0:
        raise ValueError("LVR budget inputs must be non-negative")
    if sigma_short == 0:
        return math.inf
    return max(0.0, 8.0 * (revenue_per_second - gas_per_second) / (sigma_short**2))


def _segment_liquidity(lo: float, hi: float, capacity: float, side: Side) -> float:
    if not 0 < lo < hi or capacity < 0:
        raise ValueError("invalid segment")
    if side == "ask":
        denominator = 1 / math.sqrt(lo) - 1 / math.sqrt(hi)
    else:
        denominator = math.sqrt(hi) - math.sqrt(lo)
    if denominator <= 0:
        raise ValueError("segment has no price width")
    return capacity / denominator


def build_ladder(*, price: float, reservation: float, half_spread: float,
                 ask_extra: float, bid_extra: float, base_reserve: float,
                 quote_reserve: float, depth_mult: float,
                 params: QuoteParams) -> tuple[tuple[LadderLevel, ...], tuple[LadderLevel, ...]]:
    """Construct monotonic ask/bid constant-product segments."""
    if min(price, reservation, base_reserve, quote_reserve) <= 0:
        raise ValueError("price, reservation, and reserves must be positive")
    if min(half_spread, ask_extra, bid_extra, depth_mult) < 0:
        raise ValueError("quote offsets must be non-negative")
    base_cap = depth_mult * params.utilization_max * base_reserve
    quote_cap = depth_mult * params.utilization_max * quote_reserve
    asks: list[LadderLevel] = []
    bids: list[LadderLevel] = []
    previous = 0
    for offset, weight in zip(params.offsets_bps, params.weights_bps):
        ask_lo = reservation * (1 + half_spread + ask_extra + previous / BPS)
        ask_hi = reservation * (1 + half_spread + ask_extra + offset / BPS)
        bid_hi = reservation * (1 - half_spread - bid_extra - previous / BPS)
        bid_lo = reservation * (1 - half_spread - bid_extra - offset / BPS)
        if not (0 < bid_lo < bid_hi < reservation < ask_lo < ask_hi):
            raise ValueError("ladder is not strictly monotonic or bid crossed zero")
        ask_capacity = base_cap * weight / BPS
        bid_capacity = quote_cap * weight / BPS
        asks.append(LadderLevel("ask", ask_lo, ask_hi, ask_capacity,
                                previous, offset, _segment_liquidity(ask_lo, ask_hi, ask_capacity, "ask")))
        bids.append(LadderLevel("bid", bid_lo, bid_hi, bid_capacity,
                                previous, offset, _segment_liquidity(bid_lo, bid_hi, bid_capacity, "bid")))
        previous = offset
    return tuple(asks), tuple(bids)


def compute_quote(*, price: float, base_reserve: float, quote_reserve: float,
                  confidence: float, age: float, volatility: VolatilityState,
                  params: QuoteParams, previous_price: float | None = None,
                  depth_budget: float = 1.0, apply_throttle: bool = True,
                  depth_override: float | None = None) -> Quote:
    q = inventory_imbalance(base_reserve, quote_reserve, price)
    p_res = reservation_price(price, q, params.inventory_coeff)
    spread = compute_half_spread(sigma_short=volatility.sigma_short,
                                 inventory_q=q, confidence=confidence,
                                 price=price, age=age,
                                 jump_flag=volatility.jump_flag, params=params)
    if previous_price is None:
        ask_extra = bid_extra = 0.0
    else:
        ask_extra, bid_extra = directional_addon(
            price, previous_price, coefficient=params.directional_coeff)
    if depth_override is not None:
        depth = depth_override
    elif not apply_throttle:
        depth = min(1.0, max(0.0, depth_budget))
    else:
        depth = depth_multiplier(sigma_short=volatility.sigma_short,
                                 confidence=confidence / price,
                                 jump_flag=volatility.jump_flag,
                                 depth_budget=depth_budget, params=params)
    asks, bids = build_ladder(price=price, reservation=p_res,
                              half_spread=spread, ask_extra=ask_extra,
                              bid_extra=bid_extra, base_reserve=base_reserve,
                              quote_reserve=quote_reserve, depth_mult=depth,
                              params=params)
    return Quote(price, p_res, spread, ask_extra, bid_extra, depth, asks, bids)


def walk_ladder(levels: tuple[LadderLevel, ...], amount_in: float,
                *, flow_n: float = 0.0) -> tuple[float, float, int]:
    """Walk ask/bid segments; return (output, new_flow_n, levels_consumed).

    ``amount_in`` is quote for asks and base for bids.  The continuous formulas
    are the Uniswap v3 formulas cited in Section 5.8.  The eventual on-chain
    port must replace these floats with Q64.64 checked arithmetic.
    """
    if amount_in < 0 or not levels:
        raise ValueError("amount and levels must be valid")
    side = levels[0].side
    remaining = amount_in
    output = 0.0
    consumed = 0
    for level in levels:
        if remaining <= 0:
            break
        if side == "ask":
            max_in = level.liquidity * (math.sqrt(level.hi) - math.sqrt(level.lo))
            used = min(remaining, max_in)
            start = math.sqrt(level.lo)
            end = start + used / level.liquidity
            output += level.liquidity * (1 / start - 1 / end)
            remaining -= used
            if used >= max_in * (1 - 1e-12):
                consumed += 1
        else:
            max_in = level.liquidity * (1 / math.sqrt(level.lo) - 1 / math.sqrt(level.hi))
            used = min(remaining, max_in)
            start = 1 / math.sqrt(level.hi)
            end = start + used / level.liquidity
            output += level.liquidity * (1 / start - 1 / end)
            remaining -= used
            if used >= max_in * (1 - 1e-12):
                consumed += 1
    if remaining > max(amount_in, 1.0) * 1e-12:
        raise ValueError("capacity exceeded")
    new_flow = flow_n + output if side == "ask" else flow_n - amount_in
    return output, new_flow, consumed


def reset_flow() -> float:
    """D-04: every accepted quote update resets net base flow."""
    return 0.0


def first_deposit_shares(deposit_base: int, deposit_quote: int,
                         min_liquidity: int) -> int:
    if min(deposit_base, deposit_quote) <= 0 or min_liquidity < 0:
        raise ValueError("invalid first deposit")
    shares = math.isqrt(deposit_base * deposit_quote)
    if shares <= min_liquidity:
        raise ValueError("deposit does not cover minimum liquidity")
    return shares - min_liquidity


def deposit_shares(deposit_base: int, deposit_quote: int, reserve_base: int,
                   reserve_quote: int, total_shares: int) -> int:
    if min(deposit_base, deposit_quote, reserve_base, reserve_quote, total_shares) <= 0:
        raise ValueError("invalid deposit state")
    return min(deposit_base * total_shares // reserve_base,
               deposit_quote * total_shares // reserve_quote)


def withdrawal_amounts(shares: int, reserve_base: int, reserve_quote: int,
                       total_shares: int) -> tuple[int, int]:
    if min(shares, reserve_base, reserve_quote, total_shares) < 0 or shares > total_shares:
        raise ValueError("invalid withdrawal state")
    return (shares * reserve_base // total_shares,
            shares * reserve_quote // total_shares)
