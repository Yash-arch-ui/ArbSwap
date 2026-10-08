"""Event-driven simulator loop (Build Plan §8.1, T1.4).

Clock model
-----------
Three independent clocks are explicit so the loop can be run at archive
resolution *and* at slot resolution:

``source_step_seconds``
    spacing of the reference series handed in (``1.0`` for the Binance 1-second
    archives, ``0.1`` for an ``aggTrades``-derived reference).
``step_seconds``
    how often the loop advances. Marks, markouts and path metrics live on this
    grid; ``0.4`` matches a Solana slot, ``1.0`` matches the archive.
``slot_seconds``
    the on-chain slot clock. Keeper decisions only happen on slot boundaries
    and every landing delay is rounded up to the next boundary, so a decision
    made at ``t`` becomes live no earlier than ``t + latency + landing``.

The loop is deterministic: the same seed, path and parameters reproduce the
same run bit for bit.
"""

from __future__ import annotations

import math
import random
from dataclasses import dataclass, field

from simulation.sim.costs import CostModel, landing_delay
from simulation.sim.flow import InformedFlow, NoiseFlow
from simulation.sim.metrics import TradeRecord
from simulation.sim.oracle import OracleModel, OracleTick
from simulation.sim.price_source import PricePoint
from simulation.sim.venues import HonestyRejected, PassivePool, VaultVenue


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
    # Item 1g: ticks where the quote was expired so no fill was attempted.
    expired_skips: int = 0
    update_gas_quote: float = 0.0
    update_priority_quote: float = 0.0
    swap_gas_quote: float = 0.0
    swap_priority_quote: float = 0.0
    step_seconds: float = 1.0
    mid_path: list[float] = field(default_factory=list)
    decision_times: list[float] = field(default_factory=list)

    @property
    def update_cost_quote(self) -> float:
        """Total keeper transaction cost (gas + priority) paid by the vault."""
        return self.update_gas_quote + self.update_priority_quote

    @property
    def priority_fee_cost_quote(self) -> float:
        """Priority-fee portion of :attr:`update_cost_quote`."""
        return self.update_priority_quote

    @property
    def swap_cost_quote(self) -> float:
        """Total swap transaction cost (reported, not debited from the vault)."""
        return self.swap_gas_quote + self.swap_priority_quote

    @property
    def seconds(self) -> float:
        return len(self.value_path) * self.step_seconds


def venue_mid(venue) -> float:
    if isinstance(venue, PassivePool):
        return venue.price
    if venue.quote_state is not None and venue.quote_state.asks:
        best_ask = venue.quote_state.asks[0].lo
        best_bid = venue.quote_state.bids[0].hi
        return (best_ask + best_bid) / 2.0
    return 0.0


def _source_index(seconds: float, source_step: float, count: int) -> int:
    """Index of the last reference sample at or before ``seconds`` (clamped)."""
    index = int(math.floor(round(seconds / source_step, 9)))
    return min(max(index, 0), count - 1)


def _on_slot(time_s: float, slot_s: float) -> bool:
    quotient = time_s / slot_s
    return abs(quotient - round(quotient)) < 1e-6


def simulate(
    *,
    venue_name: str,
    venue,
    prices: list[PricePoint],
    oracle: OracleModel,
    noise: NoiseFlow,
    informed: InformedFlow,
    depth_budget: float = 1.0,
    step_seconds: float = 1.0,
    source_step_seconds: float = 1.0,
    slot_seconds: float = 0.4,
    keeper_update_interval_seconds: float = 1.0,
    costs: CostModel | None = None,
    landing_delay_sampler=landing_delay,
    seed: int = 20261006,
    record_quotes: bool = False,
) -> SimResult:
    if step_seconds <= 0 or source_step_seconds <= 0 or slot_seconds <= 0:
        raise ValueError("clock constants must be positive")
    if keeper_update_interval_seconds < 0:
        raise ValueError("keeper_update_interval_seconds must be non-negative")
    if not prices:
        raise ValueError("prices must be non-empty")

    cost_model = costs if costs is not None else CostModel()
    effective_slot = max(slot_seconds, step_seconds)
    effective_latency = oracle.latency_seconds - oracle.cheat_seconds
    total_seconds = len(prices) * source_step_seconds
    n_steps = max(1, int(math.ceil(total_seconds / step_seconds - 1e-9)))

    noise_orders: dict[int, list[tuple[str, float]]] = {}
    for step, side, size in noise.arrivals(n_steps, step_seconds=step_seconds):
        noise_orders.setdefault(step, []).append((side, size))

    trades: list[TradeRecord] = []
    value_path: list[float] = []
    base_path: list[float] = []
    price_path: list[float] = []
    mid_path: list[float] = []
    rng = random.Random(seed)

    pending: list[tuple[float, int, OracleTick]] = []
    next_decision_time = 0.0
    last_refresh_time = -math.inf
    last_refresh_oracle: float | None = None
    last_source_index = -1
    last_volatility_time: float | None = None
    cash_flow = 0.0
    rejects = 0
    expired_skips = 0
    quote_updates = 0
    decision_times: list[float] = []
    update_gas = 0.0
    update_priority = 0.0
    swap_gas = 0.0
    swap_priority = 0.0

    for index in range(n_steps):
        now = index * step_seconds
        src_idx = _source_index(now, source_step_seconds, len(prices))
        stale_idx = _source_index(now - effective_latency, source_step_seconds, len(prices))
        reference = prices[src_idx].price
        publish_time = stale_idx * source_step_seconds
        stale_price = prices[stale_idx].price
        tick = oracle.sample(step=index, now_seconds=now, stale_price=stale_price,
                             publish_time=publish_time, reference_price=reference,
                             publication_index=src_idx)

        # The keeper decides on a fixed wall-clock grid (multiples of the update
        # interval) and the decision is taken at the first slot boundary at or
        # after its target time, so both the number of decisions and the order
        # of the landing-delay draws are the same on any simulation clock. When
        # the interval is shorter than a simulation step several targets fall
        # into one step and are all taken there, rather than being dropped.
        if isinstance(venue, VaultVenue) and _on_slot(now, effective_slot):
            while now + 1e-9 >= next_decision_time:
                landed_at = math.ceil((now + landing_delay_sampler(rng)) / effective_slot
                                      - 1e-9) * effective_slot
                pending.append((max(landed_at, now), index, tick))
                decision_times.append(now)
                if keeper_update_interval_seconds <= 0:
                    # 0 => one decision per evaluation boundary.
                    break
                next_decision_time += keeper_update_interval_seconds

        quote_fresh = True
        if isinstance(venue, VaultVenue):
            # Volatility is an EWMA of the *reference* series, so it is updated
            # exactly when a new reference sample arrives — not once per loop
            # iteration. Otherwise a 400 ms clock would decay the variance 2.5x
            # faster than a 1 s clock and every spread would silently change.
            if src_idx != last_source_index:
                elapsed = (now - last_volatility_time
                           if last_volatility_time is not None else step_seconds)
                venue.volatility = venue.volatility.update(
                    tick.oracle_price,
                    step_seconds=elapsed if elapsed > 0 else step_seconds)
                last_volatility_time = now
                last_source_index = src_idx
            if pending:
                due = [item for item in pending if item[0] <= now + 1e-9]
                if due:
                    pending[:] = [item for item in pending if item[0] > now + 1e-9]
                    due.sort(key=lambda item: (item[0], item[1]))
                    for _, _, landed_tick in due:
                        age = max(0.0, now - landed_tick.publish_time)
                        venue.refresh(price=landed_tick.oracle_price,
                                      confidence=landed_tick.confidence, age=age,
                                      previous_price=last_refresh_oracle,
                                      depth_budget=depth_budget)
                        last_refresh_oracle = landed_tick.oracle_price
                        last_refresh_time = now
                        quote_updates += 1
                        gas, priority = cost_model.update(reference)
                        venue.quote = max(0.0, venue.quote - gas - priority)
                        update_gas += gas
                        update_priority += priority
            quote_fresh = (venue.quote_state is not None
                           and now - last_refresh_time < venue.params.expiry_slots * slot_seconds)
            if not quote_fresh:
                expired_skips += 1

        side, amount = _informed_trade(venue, reference, informed) if quote_fresh else (None, 0.0)
        if side is not None and amount > 0:
            trade, rejected = _apply(venue, side, amount, reference, index, trades)
            rejects += rejected
            if trade is not None:
                cash_flow += trade.quote_amount
                gas, priority = cost_model.swap(reference)
                swap_gas += gas
                swap_priority += priority

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
                    gas, priority = cost_model.swap(reference)
                    swap_gas += gas
                    swap_priority += priority

        held_base = venue.base if hasattr(venue, "base") else 0.0
        base_path.append(held_base)
        value_path.append(venue.value(reference) if isinstance(venue, VaultVenue) else
                          venue.quote + venue.base * reference)
        price_path.append(reference)
        if record_quotes:
            mid_path.append(venue_mid(venue))

    return SimResult(
        venue_name=venue_name,
        final_price=prices[-1].price,
        base=venue.base,
        quote=venue.quote,
        cash_flow=cash_flow,
        trades=trades,
        value_path=value_path,
        base_path=base_path,
        price_path=price_path,
        rejects=rejects,
        quote_updates=quote_updates,
        expired_skips=expired_skips,
        decision_times=decision_times,
        update_gas_quote=update_gas,
        update_priority_quote=update_priority,
        swap_gas_quote=swap_gas,
        swap_priority_quote=swap_priority,
        step_seconds=step_seconds,
        mid_path=mid_path,
    )


def _informed_trade(venue, reference: float, informed) -> tuple[str | None, float]:
    """Size the arbitrageur to its own profit maximum.

    The arbitrageur picks the size that maximises ``reference x amount_out -
    amount_in`` (buy) or ``amount_in x amount_out' - reference x amount_in``
    (sell), i.e. it keeps trading until the *marginal* execution price reaches
    fair value. That is the standard optimum: sizing until the *average*
    execution price reaches fair value would leave the trader exactly at
    breakeven, would push the venue past fair value, and would make it
    oscillate around the reference forever while donating fees.

    Sizing uses a golden-section search over the venue's pure ``preview``, so no
    venue copy is needed.
    """
    if reference <= 0 or informed.max_size <= 0:
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

    def profit(size: float) -> float:
        if size <= 0:
            return 0.0
        try:
            average = venue.preview(side, size)
        except (ValueError, ZeroDivisionError):
            return -math.inf
        if average <= 0:
            return -math.inf
        if side == "buy":
            return reference * (size / average) - size
        return size * (average - reference)

    low, high = 0.0, informed.max_size
    golden = (math.sqrt(5.0) - 1.0) / 2.0
    left = high - golden * (high - low)
    right = low + golden * (high - low)
    f_left, f_right = profit(left), profit(right)
    for _ in range(24):
        if f_left > f_right:
            high, right, f_right = right, left, f_left
            left = high - golden * (high - low)
            f_left = profit(left)
        else:
            low, left, f_left = left, right, f_right
            right = low + golden * (high - low)
            f_right = profit(right)
    size = (low + high) / 2.0
    if size <= 0 or not math.isfinite(profit(size)) or profit(size) <= 0:
        return None, 0.0
    return side, size


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
