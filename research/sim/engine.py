"""Event-driven simulator loop (Build Plan §8.1, T1.4).

Ties together the price source, oracle model, flow model, and a venue. The
loop is intentionally simple and deterministic so results can be reproduced
from a seed and compared across venues B1/B2/B3/B4.
"""

from __future__ import annotations

import copy
from dataclasses import dataclass, field

from research.reference.quote_math import VolatilityState
from research.sim.flow import InformedFlow, NoiseFlow
from research.sim.metrics import TradeRecord
from research.sim.oracle import OracleModel
from research.sim.price_source import PricePoint
from research.sim.venues import HonestyRejected, PassivePool, VaultVenue


@dataclass
class SimResult:
    venue_name: str
    final_price: float
    base: float
    quote: float
    cash_flow: float
    trades: list[TradeRecord] = field(default_factory=list)
    value_path: list[float] = field(default_factory=list)
    base_path: list[float] = field(default_factory=list)
    price_path: list[float] = field(default_factory=list)
    rejects: int = 0


def venue_mid(venue) -> float:
    if isinstance(venue, PassivePool):
        return venue.price
    if venue.quote_state is not None and venue.quote_state.asks:
        best_ask = venue.quote_state.asks[0].lo
        best_bid = venue.quote_state.bids[0].hi
        return (best_ask + best_bid) / 2.0
    return 0.0


def simulate(
    *,
    venue_name: str,
    venue,
    prices: list[PricePoint],
    oracle: OracleModel,
    noise: NoiseFlow,
    informed: InformedFlow,
    depth_budget: float = 1.0,
) -> SimResult:
    noise_orders = {second: [] for second in range(len(prices))}
    for second, side, size in noise.arrivals(len(prices)):
        noise_orders[second].append((side, size))

    trades: list[TradeRecord] = []
    value_path: list[float] = []
    base_path: list[float] = []
    price_path: list[float] = []
    previous_price: float | None = None
    cash_flow = 0.0
    rejects = 0

    for index, point in enumerate(prices):
        reference = point.price
        tick = oracle.observe(point)
        if isinstance(venue, VaultVenue):
            venue.volatility = venue.volatility.update(tick.oracle_price)
            age = point.second - tick.publish_second
            venue.refresh(
                price=tick.oracle_price,
                confidence=tick.confidence,
                age=age,
                previous_price=previous_price,
                depth_budget=depth_budget,
            )
        # Informed arbitrage around the refreshed quote: size to move the venue
        # price to the reference, capped by the trader's maximum size.
        side, amount = _informed_trade(venue, reference, informed)
        if side is not None and amount > 0:
            trade, rejected = _apply(venue, side, amount, reference, index, trades)
            rejects += rejected
            if trade is not None:
                cash_flow += trade.quote_amount

        # Noise arrivals at the reference mid.
        for side, quote_notional in noise_orders.get(index, []):
            if side == "buy":
                amount_in = quote_notional
            else:
                amount_in = quote_notional / reference if reference > 0 else 0.0
            if amount_in > 0 and venue.base > 0 and venue.quote > 0:
                trade, rejected = _apply(venue, side, amount_in, reference, index, trades)
                rejects += rejected
                if trade is not None:
                    cash_flow += trade.quote_amount

        # End-of-step holdings: the base held during the move to the next step.
        held_base = venue.base if hasattr(venue, "base") else 0.0
        base_path.append(held_base)
        value_path.append(venue.value(reference) if isinstance(venue, VaultVenue) else
                          venue.quote + venue.base * reference)
        price_path.append(reference)
        previous_price = reference

    final_price = prices[-1].price if prices else 0.0
    return SimResult(
        venue_name=venue_name,
        final_price=final_price,
        base=venue.base,
        quote=venue.quote,
        cash_flow=cash_flow,
        trades=trades,
        value_path=value_path,
        base_path=base_path,
        price_path=price_path,
        rejects=rejects,
    )


def _informed_trade(venue, reference: float, informed) -> tuple[str | None, float]:
    """Find the side and largest size whose average execution price is still
    favourable versus the reference.

    A real arbitrageur compares the price they would *execute at* (the venue's
    ask/bid, including spread and impact) to fair value — not the mid — and
    trades only while that execution price beats the reference. Sizing uses a
    bisection on a deep copy so the live venue is untouched until the caller
    applies one fill.
    """
    if reference <= 0:
        return None, 0.0
    epsilon = max(reference * 1e-9, 1e-12)

    def marginal(side: str) -> float | None:
        trial = copy.deepcopy(venue)
        try:
            return trial.fill(side, epsilon).exec_price
        except (ValueError, ZeroDivisionError):
            return None

    ask = marginal("buy")
    bid = marginal("sell")
    if ask is not None and ask < reference:
        side = "buy"
    elif bid is not None and bid > reference:
        side = "sell"
    else:
        return None, 0.0

    low, high = 0.0, informed.max_size
    for _ in range(18):
        probe = (low + high) / 2.0
        trial = copy.deepcopy(venue)
        try:
            price = trial.fill(side, probe).exec_price
        except (ValueError, ZeroDivisionError):
            high = probe
            continue
        favourable = price < reference if side == "buy" else price > reference
        if favourable:
            low = probe
        else:
            high = probe
    return side, low


def _apply(venue, side: str, amount_in: float, reference: float,
           second: int, trades: list[TradeRecord]) -> tuple[TradeRecord | None, int]:
    if isinstance(venue, VaultVenue) and venue.quote_state is None:
        return None, 0
    try:
        fill = venue.fill(side, amount_in)
    except HonestyRejected:
        return None, 1
    except (ValueError, ZeroDivisionError):
        return None, 0
    if side == "buy":
        base_amount = fill.amount_out
        quote_amount = fill.amount_in
    else:
        base_amount = fill.amount_in
        quote_amount = fill.amount_out
    trade = TradeRecord(
        second=second,
        trader_side=side,
        base_amount=base_amount,
        quote_amount=quote_amount,
        exec_price=fill.exec_price,
        mid_at_fill=reference,
        gap_bps=fill.gap_bps,
    )
    trades.append(trade)
    return trade, 0
