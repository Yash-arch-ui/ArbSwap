"""Order-flow model (Build Plan §8.1, T1.4).

Two populations:
- **noise** traders: Poisson arrivals with lognormal sizes and random sides;
- **informed** arbitrageurs: trade only when the venue's marginal price differs
  from the reference by more than the effective fee. ``InformedFlow.size`` only
  supplies the *search bracket*; the engine refines it with golden-section
  maximisation of the marginal profit (``reference·out − in`` for a buy,
  ``in·(out′ − reference)`` for a sell). Sizing to the average-price breakeven
  instead would generate self-sustaining round trips (see ASSUMPTIONS A-16).
"""

from __future__ import annotations

import math
import random
from dataclasses import dataclass
from typing import Literal

Side = Literal["buy", "sell"]


@dataclass(frozen=True)
class NoiseFlow:
    arrival_rate: float = 0.2
    mean_size: float = 100.0
    size_sigma: float = 1.0
    seed: int = 20261006

    def arrivals(self, steps: int, *,
                 step_seconds: float = 1.0) -> list[tuple[int, Side, float]]:
        """Place arrivals for ``steps`` simulation steps of ``step_seconds`` each.

        ``arrival_rate`` is expressed **per second** and the random stream is
        indexed by *seconds*, so a 400 ms clock and a 1 s clock draw the same
        trigger/size/side sequence for the same simulated duration; only the
        sub-second placement (drawn from a separate stream) differs.
        """
        if step_seconds <= 0:
            raise ValueError("step_seconds must be positive")
        if steps < 0:
            raise ValueError("steps must be non-negative")
        total_seconds = int(math.ceil(steps * step_seconds - 1e-9))
        probability = min(1.0, max(0.0, self.arrival_rate))
        rng = random.Random(self.seed)
        sub_rng = random.Random(self.seed + 1)
        orders: list[tuple[int, Side, float]] = []
        for second in range(total_seconds):
            if rng.random() < probability:
                size = rng.lognormvariate(math.log(self.mean_size), self.size_sigma)
                side: Side = "buy" if rng.random() < 0.5 else "sell"
                time_in_second = second + sub_rng.random()
                step = int(time_in_second / step_seconds)
                step = min(steps - 1, max(int(second / step_seconds), step)) if steps else 0
                orders.append((step, side, size))
        return orders


@dataclass(frozen=True)
class InformedFlow:
    """Arbitrage threshold and size cap for the informed trader."""

    fee_bps: float = 1.0
    max_size: float = 10_000.0

    def should_trade(self, venue_price: float, reference_price: float) -> Side | None:
        if venue_price <= 0 or reference_price <= 0:
            return None
        edge_bps = 10_000.0 * (reference_price - venue_price) / venue_price
        if edge_bps > self.fee_bps:
            return "buy"  # venue is cheap; arb buys from it
        if edge_bps < -self.fee_bps:
            return "sell"  # venue is rich; arb sells to it
        return None

    def size(self, venue_price: float, reference_price: float, capacity: float) -> float:
        target = min(capacity, self.max_size)
        if venue_price <= 0:
            return 0.0
        # Linear first-order sizing toward the reference; the simulator refines
        # this using the venue's own marginal-price function.
        gap = abs(reference_price - venue_price) / venue_price
        return max(0.0, min(target, target * gap * 10.0))
