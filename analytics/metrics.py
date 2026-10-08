"""Analytics metrics (Build Plan §8.3), independently implemented.

Every function here is written from the specification, not imported from the
simulator, so the integration tests are a real cross-check: the same number
computed two ways must agree.

Source ideas (see docs/FORMULA.md §13):
- microprice weighted by opposite-side size: Solmaz et al., App. A.3.
- markout sign convention (positive = venue gained): Build Plan §8.3.
- LVR decomposition ``LP PnL = exposure + fees - LVR``: Milionis et al.;
  the constant-product ``sigma^2/8`` identity is their Example 3.
- quote-versus-fill gap: the 0x propAMM report (Base/Flashblocks; not a Solana
  result until measured on Solana, E8).
"""

from __future__ import annotations

import math
from dataclasses import dataclass

from analytics import events as ev

MOVING_THRESHOLD = 0.0001  # 1 bps


def microprice(bid: float, ask: float, q_bid: float, q_ask: float) -> float:
    """Size-weighted top-of-book price (Solmaz et al., App. A.3)."""
    if q_bid + q_ask <= 0:
        raise ValueError("microprice needs non-zero depth")
    return (bid * q_ask + ask * q_bid) / (q_bid + q_ask)


def _exec_price(swap: ev.SwapEvent) -> float:
    if swap.amount_out <= 0:
        raise ValueError("swap has no output")
    return swap.amount_in / swap.amount_out if swap.side == "buy" else swap.amount_out / swap.amount_in


def _venue_bought_base(swap: ev.SwapEvent) -> bool:
    return swap.side == "sell"


def _notional(swap: ev.SwapEvent) -> float:
    """Quote notional of the fill (matches the simulator's ``TradeRecord.notional``)."""
    return abs(swap.amount_in) if swap.side == "buy" else abs(swap.amount_out)


def markout_bps(swap: ev.SwapEvent, future_price: float) -> float:
    """Build Plan §8.3: ``1e4*d*(m(t+tau)-p_exec)/p_exec``, d=+1 when the
    venue bought base. Positive means the venue gained."""
    price = _exec_price(swap)
    direction = 1.0 if _venue_bought_base(swap) else -1.0
    return 10_000.0 * direction * (future_price - price) / price


def markout_curve(swaps, price_at, *, horizons=range(-5, 16), step_seconds: float = 1.0):
    """Notional-weighted mean markout per horizon (integer seconds in the spec)."""
    curve = {}
    for tau in horizons:
        steps = int(round(tau / step_seconds))
        total = 0.0
        weight = 0.0
        for swap in swaps:
            future = price_at(swap.slot + steps)
            if future is None:
                continue
            notional = _notional(swap)
            total += notional * markout_bps(swap, future)
            weight += notional
        curve[tau] = total / weight if weight else 0.0
    return curve


def markout_2s(swaps, price_at, *, step_seconds: float = 1.0) -> float:
    return markout_curve(swaps, price_at, horizons=(2,), step_seconds=step_seconds)[2]


def is_quiet(swap: ev.SwapEvent, price_at, *, step_seconds: float = 1.0) -> bool:
    lookback = max(1, int(round(5.0 / step_seconds)))
    forward = max(1, int(round(1.0 / step_seconds)))
    before = price_at(swap.slot - lookback)
    after = price_at(swap.slot + forward)
    if before is None or after is None or before <= 0:
        return False
    return abs(after - before) / before < MOVING_THRESHOLD


def retail_half_spread_bps(swaps, price_at, *, step_seconds: float = 1.0) -> float:
    """Notional-weighted half-spread on quiet fills only (Build Plan §8.3)."""
    total = 0.0
    weight = 0.0
    for swap in swaps:
        if swap.mid_at_fill <= 0 or not is_quiet(swap, price_at, step_seconds=step_seconds):
            continue
        half = 10_000.0 * abs(_exec_price(swap) - swap.mid_at_fill) / swap.mid_at_fill
        total += _notional(swap) * half
        weight += _notional(swap)
    return total / weight if weight else 0.0


@dataclass(frozen=True)
class GapStats:
    mean: float
    notional_weighted_mean: float
    identical_share: float
    p95: float


def gap_stats(swaps) -> GapStats:
    """Quote-versus-fill gap: mean, VW mean, identical share, 95th percentile."""
    if not swaps:
        return GapStats(0.0, 0.0, 1.0, 0.0)
    gaps = []
    total = 0.0
    weight = 0.0
    identical = 0
    for swap in swaps:
        if swap.quoted_out <= 0:
            gap = 0.0
        else:
            gap = 10_000.0 * (swap.quoted_out - swap.amount_out) / swap.quoted_out
        gaps.append(gap)
        notional = _notional(swap)
        total += notional * gap
        weight += notional
        if abs(gap) <= 1e-9:
            identical += 1
    gaps.sort()
    p95 = gaps[min(len(gaps) - 1, int(round(0.95 * (len(gaps) - 1))))]
    return GapStats(
        mean=sum(gaps) / len(gaps),
        notional_weighted_mean=total / weight if weight else 0.0,
        identical_share=identical / len(gaps),
        p95=p95,
    )


def hedged_pnl(value_path, base_path, price_path) -> float:
    """Value change minus the delta hedge on actual base holdings (Build Plan §8.3):
    ``sum_t [V_{t+1}-V_t - B_t*(P_{t+1}-P_t)]``."""
    if not (len(value_path) == len(base_path) == len(price_path)):
        raise ValueError("paths must have equal length")
    total = 0.0
    for t in range(len(value_path) - 1):
        total += (value_path[t + 1] - value_path[t]) - base_path[t] * (
            price_path[t + 1] - price_path[t]
        )
    return total


def lvr_theory(sigma_per_sqrt_second: float, liquidity_value: float, seconds: float) -> float:
    """Constant-product ``(sigma^2/8)*V*T`` (Milionis et al., Example 3)."""
    return (sigma_per_sqrt_second**2 / 8.0) * liquidity_value * seconds


def realized_volatility_per_sqrt_second(prices, *, step_seconds: float = 1.0) -> float:
    if len(prices) < 2 or step_seconds <= 0:
        return 0.0
    total = 0.0
    count = 0
    for previous, current in zip(prices, prices[1:]):
        if previous > 0 and current > 0:
            total += math.log(current / previous) ** 2
            count += 1
    return math.sqrt(total / (count * step_seconds)) if count else 0.0


@dataclass(frozen=True)
class Attribution:
    """LP PnL decomposed (fees, spread/LVR, gas); ``total`` is the hedged PnL."""

    fees_quote: float
    gas_quote: float
    adverse_selection_quote: float
    total: float


def attribution(swap_fees: float, keeper_gas: float, hedged: float) -> Attribution:
    """`hedged = fees - gas - adverse_selection`, so adverse selection is the
    residual (the LVR the pool paid away), per the LVR decomposition."""
    return Attribution(
        fees_quote=swap_fees,
        gas_quote=keeper_gas,
        adverse_selection_quote=swap_fees - keeper_gas - hedged,
        total=hedged,
    )


def e1_lvr_reduction(arb_hedged: float, passive_hedged: float) -> float:
    """E1: fractional hedged-PnL improvement of ArbSwap over the passive pool."""
    if passive_hedged == 0:
        return 0.0
    return (arb_hedged - passive_hedged) / abs(passive_hedged)
