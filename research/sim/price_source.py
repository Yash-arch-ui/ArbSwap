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

# Annualised volatility per regime (calm/trend/crash/jump). Chosen so the three
# headline regimes are qualitatively distinct; calibrated against real data in
# the walk-forward step, not assumed to be true.
REGIME_ANNUAL_VOL: dict[str, float] = {
    "calm": 0.35,
    "trend": 0.7,
    "crash": 2.0,
    "jump": 1.5,
}


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
    annual_vol: float | None = None,
) -> list[PricePoint]:
    """Generate a per-second price path for one of the four regimes.

    Volatility is specified per year and converted to a per-second standard
    deviation using 365*24*3600 seconds. The regimes are qualitative on
    purpose; calibration (T1.5) uses the real data.
    """
    if length <= 0 or start_price <= 0:
        raise ValueError("length and start_price must be positive")
    if annual_vol is None:
        annual_vol = REGIME_ANNUAL_VOL[regime]
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


def _parse_timestamp(value: str) -> int:
    """Accept seconds or milliseconds since the epoch and return seconds."""
    number = float(value)
    return int(number // 1000) if number > 1e11 else int(number)


def load_price_csv(
    path: str | Path,
    *,
    price_column: str = "price",
    timestamp_column: str | None = None,
) -> list[PricePoint]:
    """Load a real reference-price CSV onto a contiguous 1-second grid.

    The CSV is the output of the download scripts in ``research/data``. When a
    timestamp column is present (``timestamp_ms`` by default for Binance, or an
    explicit ``timestamp_column``), rows are sorted and missing seconds are
    forward-filled so the replay clock has exactly one point per second with a
    0-based ``second`` index. Without a timestamp column the rows are used in
    file order (one point per row), which matches ``load_csv``.
    """
    rows: list[tuple[int, float]] = []
    with Path(path).open(newline="") as handle:
        reader = csv.DictReader(handle)
        fieldnames = reader.fieldnames or []
        if price_column not in fieldnames:
            raise ValueError(f"CSV must contain a {price_column!r} column")
        if timestamp_column is None:
            for candidate in ("timestamp_ms", "timestamp", "time", "open_time"):
                if candidate in fieldnames:
                    timestamp_column = candidate
                    break
        for index, row in enumerate(reader):
            price = float(row[price_column])
            if timestamp_column is not None:
                rows.append((_parse_timestamp(row[timestamp_column]), price))
            else:
                rows.append((index, price))
    if timestamp_column is None:
        return [PricePoint(second=second, price=price) for second, price in rows]

    rows.sort(key=lambda item: item[0])
    dense: list[PricePoint] = []
    previous_price: float | None = None
    expected_second: int | None = None
    for timestamp, price in rows:
        if previous_price is None:
            expected_second = timestamp
        while expected_second is not None and expected_second < timestamp:
            dense.append(PricePoint(second=len(dense), price=previous_price))
            expected_second += 1
        if expected_second == timestamp or previous_price is None:
            dense.append(PricePoint(second=len(dense), price=price))
            expected_second = timestamp + 1
        previous_price = price
    return dense


def load_csv(path: str | Path, *, price_column: str = "price") -> list[PricePoint]:
    """Backward-compatible alias for :func:`load_price_csv`."""
    return load_price_csv(path, price_column=price_column)


def load_price_window(path: str | Path, *, start_ms: int, end_ms: int,
                      step_ms: int = 1_000,
                      timestamp_column: str = "timestamp_ms",
                      price_column: str = "price") -> list[PricePoint]:
    """Load one half-open ``[start_ms, end_ms)`` window as a contiguous grid.

    Rows are streamed so weeks of 1-second data never sit in memory at once;
    seconds with no trade are forward-filled. ``PricePoint.second`` is the
    0-based index *within the window*, which is the clock the simulator runs
    on, while ``start_ms``/``end_ms`` keep the absolute calendar anchoring.
    """
    if start_ms < 0 or end_ms <= start_ms:
        raise ValueError("need 0 <= start_ms < end_ms")
    if start_ms % step_ms or end_ms % step_ms:
        raise ValueError("window bounds must land on the grid")
    out: list[PricePoint] = []
    grid = start_ms
    last: float | None = None

    def emit(stamp: int, price: float) -> None:
        out.append(PricePoint(second=(stamp - start_ms) // step_ms, price=price))

    with Path(path).open(newline="") as handle:
        reader = csv.DictReader(handle)
        for row in reader:
            stamp = int(row[timestamp_column])
            if stamp >= end_ms:
                break
            price = float(row[price_column])
            if price <= 0:
                continue
            if last is None:
                # Anchor the grid: rows before the window only seed the fill.
                grid = stamp if stamp > start_ms else start_ms
            while last is not None and grid < stamp and grid < end_ms:
                if grid >= start_ms:
                    emit(grid, last)
                grid += step_ms
            if stamp >= grid:
                emit(stamp, price)
                grid = stamp + step_ms
            last = price
    while last is not None and grid < end_ms:
        emit(grid, last)
        grid += step_ms
    return out


def split_windows(points: list[PricePoint], windows: int) -> list[list[PricePoint]]:
    """Split a path into ``windows`` contiguous chunks (no look-ahead)."""
    if windows < 1:
        raise ValueError("windows must be >= 1")
    if len(points) < windows:
        raise ValueError("not enough points for the requested windows")
    size = len(points) // windows
    chunks = [points[index * size:(index + 1) * size] for index in range(windows - 1)]
    chunks.append(points[(windows - 1) * size:])
    return chunks


def iter_prices(points: list[PricePoint]) -> Iterator[PricePoint]:
    yield from points
