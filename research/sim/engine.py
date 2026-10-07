"""Event-driven simulator loop (Build Plan §8.1, T1.4).

Ties together the price source, oracle model, flow model, and a venue. The
loop is intentionally simple and deterministic so results can be reproduced
from a seed and compared across venues B1/B2/B3/B4.
"""

from __future__ import annotations

from dataclasses import dataclass, field

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
    quote_updates: int = 0
    update_cost_quote: float = 0.0
    priority_fee_cost_quote: float = 0.0


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
    keeper_update_delay_seconds: int = 1,
    update_cost_quote: float = 0.0,
    priority_fee_quote: float = 0.0,
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
    quote_updates = 0
    update_cost_total = 0.0
    priority_fee_total = 0.0
    last_update_second = -1

    for index, point in enumerate(prices):
        reference = point.price
        tick = oracle.observe(point)
        quote_fresh = True
        if isinstance(venue, VaultVenue):
            venue.volatility = venue.volatility.update(tick.oracle_price)
            age = point.second - tick.publish_second
            if last_update_second < 0 or index % max(1, keeper_update_delay_seconds) == 0:
                venue.refresh(price=tick.oracle_price, confidence=tick.confidence, age=age,
                              previous_price=previous_price, depth_budget=depth_budget)
                quote_updates += 1
                last_update_second = index
                venue.quote = max(0.0, venue.quote - update_cost_quote - priority_fee_quote)
                update_cost_total += update_cost_quote
                priority_fee_total += priority_fee_quote
            quote_fresh = venue.quote_state is not None and index - last_update_second < int(venue.params.expiry_slots)
        # Informed arbitrage around the refreshed quote: size to move the venue
        # price to the reference, capped by the trader's maximum size.
        side, amount = _informed_trade(venue, reference, informed) if quote_fresh else (None, 0.0)
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
            if quote_fresh and amount_in > 0 and venue.base > 0 and venue.quote > 0:
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
        quote_updates=quote_updates,
        update_cost_quote=update_cost_total,
        priority_fee_cost_quote=priority_fee_total,
    )


def _informed_trade(venue, reference: float, informed) -> tuple[str | None, float]:
    """Find the side and largest size whose average execution price is still
    favourable versus the reference.

    A real arbitrageur compares the price they would *execute at* (the venue's
    ask/bid, including spread and impact) to fair value — not the mid — and
    trades only while that execution price beats the reference. Sizing uses a
    bisection over the venue's pure ``preview`` (average execution price of a
    single fill from the current state), so no venue copy is needed; the probe
    numbers are identical to filling a deep copy.
    """
    if reference <= 0:
        return None, 0.0

    def marginal(side: str) -> float | None:
        try:
            return venue.preview(side, max(reference * 1e-9, 1e-12))
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
        try:
            price = venue.preview(side, probe)
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
