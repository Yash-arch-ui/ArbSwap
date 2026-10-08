"""Bulk 1-second / sub-second downloads from Binance public archives.

`data.binance.vision` serves zipped daily archives, which is the only practical
way to pull *weeks* of 1-second data (the REST klines endpoint pages 1,000 rows
at a time). Two kinds are supported:

- ``klines`` at ``1s``: one row per second, price = close. Column 0 is
  ``openTime`` in **microseconds** on this endpoint (the REST API uses
  milliseconds), column 4 is the close.
- ``aggTrades``: every aggregated trade, used to build a genuinely sub-second
  reference path (last trade price per bin). Column 1 is the price, column 5 is
  the trade timestamp in microseconds.

Everything is written as ``timestamp_ms,price`` so ``load_price_csv`` reads it
unchanged. Raw archives and derived CSVs live under ``simulation/data/raw/``,
which is gitignored (Build Plan §4: data/ holds scripts only).

Usage::

    python -m simulation.data.download_vision --kind klines --symbol SOLUSDT \
        --start 2026-08-24 --days 42 --out simulation/data/raw/binance_SOLUSDT_1s.csv
    python -m simulation.data.download_vision --kind aggtrades --symbol SOLUSDT \
        --dates 2026-09-10 --bin-ms 100 --out simulation/data/raw/agg_SOLUSDT_100ms.csv
"""

from __future__ import annotations

import argparse
import csv
import io
import urllib.request
import zipfile
from datetime import date, timedelta
from pathlib import Path

VISION = "https://data.binance.vision/data/spot/daily"
USER_AGENT = "arbswap-simulation/0.1 (contact: team@example.invalid)"
MICROSECONDS_PER_SECOND = 1_000_000


def archive_url(kind: str, symbol: str, day: date, *, interval: str = "1s") -> str:
    """Public archive URL for one symbol/day. ``kind`` is ``klines`` or ``aggTrades``."""
    if kind == "klines":
        return f"{VISION}/klines/{symbol}/{interval}/{symbol}-{interval}-{day.isoformat()}.zip"
    if kind == "aggTrades":
        return f"{VISION}/aggTrades/{symbol}/{symbol}-aggTrades-{day.isoformat()}.zip"
    raise ValueError(f"unknown archive kind: {kind!r}")


def fetch_archive(url: str, *, cache_dir: Path | None = None) -> bytes:
    """Download (or read from ``cache_dir``) one daily archive."""
    if cache_dir is not None:
        cache_dir.mkdir(parents=True, exist_ok=True)
        cached = cache_dir / Path(url).name
        if cached.exists():
            return cached.read_bytes()
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(request, timeout=60) as response:
        payload = response.read()
    if cache_dir is not None:
        (cache_dir / Path(url).name).write_bytes(payload)
    return payload


def _rows(payload: bytes) -> list[list[str]]:
    with zipfile.ZipFile(io.BytesIO(payload)) as archive:
        name = archive.namelist()[0]
        text = archive.read(name).decode()
    return [row for row in csv.reader(io.StringIO(text)) if row]


def parse_klines_1s(payload: bytes) -> list[tuple[int, float]]:
    """``1s`` klines archive -> ``(timestamp_ms, close)``, forward-filled.

    Zero/missing closes are forward-filled so the grid stays one point per
    second, matching the behaviour of the REST downloader.
    """
    points: list[tuple[int, float]] = []
    last: float | None = None
    for row in _rows(payload):
        timestamp_ms = int(int(row[0]) // 1_000)  # archive uses microseconds
        price = float(row[4])
        if price <= 0:
            if last is None:
                continue
            price = last
        last = price
        points.append((timestamp_ms, price))
    return points


def parse_aggtrades(payload: bytes, *, bin_ms: int = 100) -> list[tuple[int, float]]:
    """``aggTrades`` archive -> one ``(timestamp_ms, price)`` per ``bin_ms``.

    The price of a bin is the last trade inside it; empty bins are omitted so
    the caller can forward-fill. This is what gives the simulator a genuine
    sub-second reference path.
    """
    if bin_ms <= 0:
        raise ValueError("bin_ms must be positive")
    binned: dict[int, float] = {}
    for row in _rows(payload):
        timestamp_ms = int(int(row[5]) // 1_000)
        price = float(row[1])
        if price <= 0:
            continue
        binned[(timestamp_ms // bin_ms) * bin_ms] = price
    return sorted(binned.items())


def write_csv(points: list[tuple[int, float]], out: Path) -> Path:
    out.parent.mkdir(parents=True, exist_ok=True)
    with out.open("w", newline="") as handle:
        writer = csv.writer(handle)
        writer.writerow(["timestamp_ms", "price"])
        for stamp, price in points:
            writer.writerow([stamp, f"{price:.10f}"])
    return out


class _GridWriter:
    """Streams ``(timestamp_ms, price)`` rows onto a fixed grid in one pass.

    Weeks of 1-second data are tens of millions of rows; keeping them all in a
    dict would need gigabytes, so each day is appended and forward-filled as it
    arrives. Rows must be supplied in non-decreasing timestamp order.
    """

    def __init__(self, out: Path, *, step_ms: int) -> None:
        out.parent.mkdir(parents=True, exist_ok=True)
        self._handle = out.open("w", newline="")
        self._writer = csv.writer(self._handle)
        self._writer.writerow(["timestamp_ms", "price"])
        self._step = step_ms
        self._cursor: int | None = None
        self._last: float | None = None
        self.count = 0

    def add(self, points: list[tuple[int, float]]) -> None:
        for stamp, price in points:
            if price <= 0:
                continue
            if self._cursor is None:
                self._cursor = stamp
            if stamp < self._cursor:
                continue  # already emitted on the grid
            if self._last is not None:
                while self._cursor < stamp:
                    self._emit(self._cursor, self._last)
                    self._cursor += self._step
            self._emit(stamp, price)
            self._last = price
            self._cursor = stamp + self._step

    def _emit(self, stamp: int, price: float) -> None:
        self._writer.writerow([stamp, f"{price:.10f}"])
        self.count += 1

    def close(self) -> int:
        self._handle.close()
        return self.count


def date_range(start: date, days: int) -> list[date]:
    return [start + timedelta(days=offset) for offset in range(days)]


def download_klines(symbol: str, *, start: date, days: int, out: Path,
                    cache_dir: Path | None = None, interval: str = "1s") -> Path:
    """Concatenate ``days`` of ``1s`` klines archives into one CSV."""
    grid = _GridWriter(out, step_ms=1_000)
    try:
        for day in date_range(start, days):
            payload = fetch_archive(archive_url("klines", symbol, day, interval=interval),
                                    cache_dir=cache_dir)
            grid.add(parse_klines_1s(payload))
    finally:
        grid.close()
    return out


def download_aggtrades(symbol: str, *, dates: list[date], bin_ms: int, out: Path,
                       cache_dir: Path | None = None) -> Path:
    """Concatenate ``aggTrades`` archives for ``dates`` into one binned CSV."""
    grid = _GridWriter(out, step_ms=bin_ms)
    try:
        for day in dates:
            payload = fetch_archive(archive_url("aggTrades", symbol, day), cache_dir=cache_dir)
            grid.add(parse_aggtrades(payload, bin_ms=bin_ms))
    finally:
        grid.close()
    return out


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--kind", choices=("klines", "aggtrades"), default="klines")
    parser.add_argument("--symbol", required=True)
    parser.add_argument("--start", type=date.fromisoformat, default=None)
    parser.add_argument("--days", type=int, default=1)
    parser.add_argument("--dates", type=date.fromisoformat, nargs="*", default=None)
    parser.add_argument("--bin-ms", type=int, default=100)
    parser.add_argument("--interval", default="1s")
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--cache-dir", type=Path, default=Path("simulation/data/raw/archive"))
    args = parser.parse_args()

    if args.kind == "klines":
        if args.start is None:
            parser.error("--start is required for --kind klines")
        path = download_klines(args.symbol, start=args.start, days=args.days,
                               out=args.out, cache_dir=args.cache_dir,
                               interval=args.interval)
    else:
        if not args.dates:
            parser.error("--dates is required for --kind aggtrades")
        path = download_aggtrades(args.symbol, dates=args.dates, bin_ms=args.bin_ms,
                                  out=args.out, cache_dir=args.cache_dir)
    print(f"wrote {sum(1 for _ in path.open()) - 1} rows to {path}")


if __name__ == "__main__":
    main()
