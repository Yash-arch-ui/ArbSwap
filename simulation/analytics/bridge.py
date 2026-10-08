"""Bridge a simulator run into the event stream (P1 -> P4 handoff).

The simulator produces ``TradeRecord``s; on chain the same information arrives
as ``SwapEvent`` logs. This module converts one into the other so the analytics
pipeline is fed exactly the shape it will see in production, and the integration
tests can assert the two independent implementations agree.
"""

from __future__ import annotations

from simulation.analytics import events as ev
from simulation.analytics import metrics
from simulation.analytics.dashboard import VenueAnalytics


def events_from_simulation(result, *, version: int = 0) -> list:
    """Convert a `SimResult`'s trades into reconciled ``SwapEvent``s.

    ``mid_at_fill`` comes from the simulator's recorded mid; ``quoted_out`` is
    reconstructed from the simulator's gap so the analytics gap metric is a
    cross-check rather than a tautology.
    """
    events = []
    for trade in result.trades:
        if trade.trader_side == "buy":
            amount_in = float(trade.quote_amount)
            amount_out = float(trade.base_amount)
        else:
            amount_in = float(trade.base_amount)
            amount_out = float(trade.quote_amount)
        if trade.gap_bps == 0:
            quoted_out = amount_out
        else:
            quoted_out = amount_out / (1.0 - trade.gap_bps / 10_000.0)
        events.append(
            ev.SwapEvent(
                slot=trade.second,
                version=version,
                side=trade.trader_side,
                amount_in=amount_in,
                amount_out=amount_out,
                fee=0.0,
                mid_at_fill=trade.mid_at_fill,
                quoted_out=quoted_out,
            )
        )
    return events


def analytics_for(result, name: str, price_at, *, step_seconds: float = 1.0) -> VenueAnalytics:
    swaps = events_from_simulation(result)
    return VenueAnalytics(
        name=name,
        hedged_pnl=metrics.hedged_pnl(result.value_path, result.base_path, result.price_path),
        markout_curve=metrics.markout_curve(swaps, price_at, step_seconds=step_seconds),
        quiet_half_spread_bps=metrics.retail_half_spread_bps(
            swaps, price_at, step_seconds=step_seconds
        ),
        gap=metrics.gap_stats(swaps),
        swaps=len(swaps),
        fees_quote=0.0,
        gas_quote=result.update_cost_quote,
    )
