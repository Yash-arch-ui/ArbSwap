"""Metric definitions (Build Plan §8.3, T1.4).

These functions are deliberately pure: they take recorded trades and price
paths and return numbers. No tuning happens here, and raw LP PnL / impermanent
loss are never headlined (Build Plan §8.5).
"""

from __future__ import annotations

import math
from dataclasses import dataclass


@dataclass(frozen=True)
class TradeRecord:
    second: int
    trader_side: str  # "buy" (trader buys base) or "sell"
    base_amount: float
    quote_amount: float
    exec_price: float
    mid_at_fill: float

    @property
    def vault_bought_base(self) -> bool:
        """The vault buys base when the trader sells it."""
        return self.trader_side == "sell"

    @property
    def notional(self) -> float:
        return abs(self.quote_amount)


def markout_bps(trade: TradeRecord, future_price: float) -> float:
    """Markout at a chosen future mid (Build Plan §8.3)."""
    if trade.exec_price <= 0:
        raise ValueError("exec_price must be positive")
    direction = 1.0 if trade.vault_bought_base else -1.0
    return 10_000.0 * direction * (future_price - trade.exec_price) / trade.exec_price


def notional_weighted_markout(trades: list[TradeRecord], horizon: int,
                              price_at) -> float:
    """Notional-weighted mean markout at ``horizon`` seconds after each fill.

    ``price_at(second)`` returns the mid at an absolute second.
    """
    total_weight = 0.0
    total = 0.0
    for trade in trades:
        future = price_at(trade.second + horizon)
        if future is None:
            continue
        total += trade.notional * markout_bps(trade, future)
        total_weight += trade.notional
    return total / total_weight if total_weight else 0.0


def is_quiet(trade: TradeRecord, price_at) -> bool:
    """Quiet flow: reference moved < 1 bps over the trailing 6 seconds."""
    before = price_at(trade.second - 5)
    after = price_at(trade.second + 1)
    if before is None or after is None or before <= 0:
        return False
    return abs(after - before) / before < 0.0001


def retail_half_spread_bps(trades: list[TradeRecord], price_at) -> float:
    """Notional-weighted half-spread on quiet fills only."""
    total_weight = 0.0
    total = 0.0
    for trade in trades:
        if not is_quiet(trade, price_at) or trade.mid_at_fill <= 0:
            continue
        half = 10_000.0 * abs(trade.exec_price - trade.mid_at_fill) / trade.mid_at_fill
        total += trade.notional * half
        total_weight += trade.notional
    return total / total_weight if total_weight else 0.0


def hedged_pnl(value_path: list[float], base_path: list[float],
               price_path: list[float]) -> float:
    """Sum of value changes minus the delta hedge on actual base holdings.

    ``value_path[t]`` is the vault value in quote at step ``t`` and
    ``base_path[t]`` the vault's base holding at the start of step ``t``.
    """
    if not (len(value_path) == len(base_path) == len(price_path)):
        raise ValueError("paths must have equal length")
    total = 0.0
    for t in range(len(value_path) - 1):
        hedge = base_path[t] * (price_path[t + 1] - price_path[t])
        total += (value_path[t + 1] - value_path[t]) - hedge
    return total


def quote_versus_fill_gap_bps(quoted_out: float, executed_out: float) -> float:
    """Gap definition (Build Plan §8.3); zero when output matches the quote."""
    if quoted_out <= 0:
        raise ValueError("quoted_out must be positive")
    return 10_000.0 * (quoted_out - executed_out) / quoted_out


def lvr_discrete(sigma_per_sqrt_second: float, liquidity_value: float,
                 seconds: float) -> float:
    """Discrete LVR for a constant-product segment (Build Plan §8.3)."""
    if sigma_per_sqrt_second < 0 or liquidity_value < 0 or seconds < 0:
        raise ValueError("LVR inputs must be non-negative")
    return (sigma_per_sqrt_second**2 / 8.0) * liquidity_value * seconds


def realized_volatility_per_sqrt_second(prices: list[float]) -> float:
    """Estimate sigma from a per-second price path via squared log returns."""
    if len(prices) < 2:
        return 0.0
    total = 0.0
    for previous, current in zip(prices, prices[1:]):
        if previous <= 0 or current <= 0:
            continue
        total += math.log(current / previous) ** 2
    return math.sqrt(total / (len(prices) - 1))
