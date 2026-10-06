"""1-second reference price source (Build Plan §8.1, T1.4).

Loads real reference prices from a CEX export or generates deterministic
synthetic regimes (calm, trend, crash, jump). Real data loading is deliberately
thin: the download scripts in ``research/data`` produce CSV files with a
``timestamp`` and ``price`` column and never commit raw data.
"""

from __future__ import annotations

import csv
import math
import random
from dataclasses import dataclass
from pathlib import Path
from typing import Iterator, Literal

Regime = Literal["calm", "trend", "crash", "jump"]


@dataclass(frozen=True)
class PricePoint:
    second: int
    price: float


def synthetic_series(
    *,
    regime: Regime,
    length: int,
    start_price: float = 150.0,
    seed: int = 20261006,
    annual_vol: float = 0.8,
) -> list[PricePoint]:
    """Generate a per-second price path for one of the four regimes.

    Volatility is specified per year and converted to a per-second standard
    deviation using 365*24*3600 seconds. The regimes are qualitative on
    purpose; calibration (T1.5) uses the real data.
    """
    if length <= 0 or start_price <= 0:
        raise ValueError("length and start_price must be positive")
    rng = random.Random(seed)
    scale = annual_vol / math.sqrt(365 * 24 * 3600)
    drift = {"calm": 0.0, "trend": 0.00002, "crash": -0.00005, "jump": 0.0}[regime]
    prices = [start_price]
    for second in range(1, length):
        shock = rng.gauss(0.0, scale)
        if regime == "jump" and rng.random() < 1e-3:
            shock += rng.choice([-1.0, 1.0]) * 0.02
        prices.append(max(1e-6, prices[-1] * math.exp(drift + shock)))
    return [PricePoint(second=i, price=p) for i, p in enumerate(prices)]


def load_csv(path: str | Path, *, price_column: str = "price") -> list[PricePoint]:
    """Load a reference-price CSV; returns one point per row in file order."""
    points: list[PricePoint] = []
    with Path(path).open(newline="") as handle:
        reader = csv.DictReader(handle)
        if reader.fieldnames is None or price_column not in reader.fieldnames:
            raise ValueError(f"CSV must contain a {price_column!r} column")
        for index, row in enumerate(reader):
            points.append(PricePoint(second=index, price=float(row[price_column])))
    return points


def iter_prices(points: list[PricePoint]) -> Iterator[PricePoint]:
    yield from points
