"""Oracle model (Build Plan §8.1-8.2, T1.4).

The oracle observes the reference price after a latency and adds noise, and
reports a confidence interval. This is the same interface Pyth Core exposes to
the keeper, so the simulator can later be fed replayed Pyth updates.
"""

from __future__ import annotations

import random
from dataclasses import dataclass

from research.sim.price_source import PricePoint


@dataclass(frozen=True)
class OracleTick:
    second: int
    reference_price: float
    oracle_price: float
    confidence: float
    publish_second: int


@dataclass
class OracleModel:
    """Latency + noise oracle with a configurable confidence interval."""

    latency_seconds: int = 0
    noise_bps: float = 1.0
    # Representative of live Pyth SOL/USD: conf ~0.018 on price ~120 = ~1.5 bps.
    confidence_bps: float = 1.5
    seed: int = 20261006

    def __post_init__(self) -> None:
        self._rng = random.Random(self.seed)
        self._history: list[PricePoint] = []

    def observe(self, point: PricePoint) -> OracleTick:
        self._history.append(point)
        index = max(0, len(self._history) - 1 - self.latency_seconds)
        published = self._history[index]
        noise = self._rng.gauss(0.0, self.noise_bps / 10_000.0)
        oracle_price = published.price * (1.0 + noise)
        confidence = oracle_price * self.confidence_bps / 10_000.0
        return OracleTick(
            second=point.second,
            reference_price=point.price,
            oracle_price=oracle_price,
            confidence=confidence,
            publish_second=published.second,
        )
