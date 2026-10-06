"""Order-flow model (Build Plan §8.1, T1.4).

Two populations:
- **noise** traders: Poisson arrivals with lognormal sizes and random sides;
- **informed** arbitrageurs: trade only when the venue's marginal price differs
  from the reference by more than the effective fee, sized to move the venue
  price to the reference (bounded by available capacity).
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
    mean_size: float = 10.0
    size_sigma: float = 1.0
    seed: int = 20261006

    def arrivals(self, seconds: int) -> list[tuple[int, Side, float]]:
        rng = random.Random(self.seed)
        orders: list[tuple[int, Side, float]] = []
        for second in range(seconds):
            if rng.random() < self.arrival_rate:
                size = rng.lognormvariate(math.log(self.mean_size), self.size_sigma)
                side: Side = "buy" if rng.random() < 0.5 else "sell"
                orders.append((second, side, size))
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
