"""Oracle model (Build Plan §8.1-8.2, T1.4).

The oracle exposes a *stale* reference price plus noise and a confidence
interval. This is the same interface Pyth Core presents to the keeper, so the
simulator can later be fed replayed Pyth updates.

Causality is enforced by the caller: the engine resolves the reference sample
at ``t - latency`` and hands it to :meth:`OracleModel.sample`. Nothing in this
module ever reads the current reference.
"""

from __future__ import annotations

import random
from dataclasses import dataclass

from simulation.sim.price_source import PricePoint


@dataclass(frozen=True)
class OracleTick:
    second: int
    reference_price: float
    oracle_price: float
    confidence: float
    publish_second: int
    publish_time: float = 0.0
    now_seconds: float = 0.0

    @property
    def age(self) -> float:
        """Seconds between the sample's publication and the observation."""
        return max(0.0, self.now_seconds - self.publish_time)


@dataclass
class OracleModel:
    """Latency + noise oracle with a configurable confidence interval."""

    latency_seconds: float = 1.0
    noise_bps: float = 1.0
    # Representative of live Pyth SOL/USD: conf ~0.018 on price ~120 = ~1.5 bps.
    confidence_bps: float = 1.5
    seed: int = 20261006
    # TEST HOOK - never used by a headline run. Positive values make the oracle
    # publish the reference ``cheat_seconds`` in the future, which lets the
    # shuffled-future test prove that honest results are not already optimistic.
    cheat_seconds: float = 0.0

    def __post_init__(self) -> None:
        self._rng = random.Random(self.seed)
        self._history: list[PricePoint] = []
        self._publication: int | None = None
        self._base: float | None = None
        self._cached: float | None = None

    def sample(self, *, step: int, now_seconds: float, stale_price: float,
               publish_time: float, reference_price: float,
               publication_index: int) -> OracleTick:
        """Add noise and a confidence band to an already-stale reference price.

        The noise is redrawn only when ``publication_index`` advances (or the
        underlying sample changes), so the oracle's refresh rate is set by the
        *reference* clock and not by how finely the simulation loop is stepped.
        """
        if stale_price <= 0:
            raise ValueError("stale_price must be positive")
        if (publication_index != self._publication or stale_price != self._base
                or self._cached is None):
            noise = self._rng.gauss(0.0, self.noise_bps / 10_000.0)
            self._cached = stale_price * (1.0 + noise)
            self._publication = publication_index
            self._base = stale_price
        oracle_price = self._cached
        confidence = oracle_price * self.confidence_bps / 10_000.0
        return OracleTick(
            second=step,
            reference_price=reference_price,
            oracle_price=oracle_price,
            confidence=confidence,
            publish_second=int(round(publish_time)),
            publish_time=publish_time,
            now_seconds=now_seconds,
        )

    def observe(self, point: PricePoint) -> OracleTick:
        """Sample at one-second archive resolution (kept for direct unit tests)."""
        self._history.append(point)
        index = max(0, len(self._history) - 1 - int(round(self.latency_seconds)))
        published = self._history[index]
        return self.sample(
            step=point.second,
            now_seconds=float(point.second),
            stale_price=published.price,
            publish_time=float(published.second),
            reference_price=point.price,
            publication_index=point.second,
        )
