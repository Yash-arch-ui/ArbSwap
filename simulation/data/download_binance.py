"""Download 1-second reference prices from Binance (Build Plan §8.6, T1.4/T0.4).

Binance klines are the CEX reference for the simulator. The 1s endpoint pages
backward/forward via ``startTime``/``endTime`` in 1,000-row windows; the daily
UTC archives (``data.binance.vision``) are the fallback for older history and do
not need to be downloaded here — ``load_price_csv`` accepts any CSV with a
``timestamp`` (ms or s) and a ``price`` column.

No third-party dependency: uses ``urllib`` from the standard library only.

Usage::

    python -m simulation.data.download_binance \
        --symbol SOLUSDT --days 3 \
        --out simulation/data/raw/binance_SOLUSDT_1s.csv
"""

from __future__ import annotations

import argparse
import csv
import json
import time
import urllib.error
import urllib.request
from pathlib import Path

BINANCE_KLINES = "https://api.binance.com/api/v3/klines"
USER_AGENT = "arbswap-simulation/0.1 (contact: team@example.invalid)"
MAX_LIMIT = 1_000
MS_PER_SECOND = 1_000


def _get(url: str, *, retries: int = 5, backoff: float = 1.5) -> list:
    last_error: Exception | None = None
    for attempt in range(retries):
        try:
            request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
            with urllib.request.urlopen(request, timeout=30) as response:
                return json.loads(response.read().decode())
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as error:
            last_error = error
            time.sleep(backoff**attempt)
    raise RuntimeError(f"request failed after {retries} attempts: {url}") from last_error


def fetch_klines(symbol: str, start_ms: int, end_ms: int) -> list[list]:
    """Fetch all 1s klines for ``[start_ms, end_ms)``, oldest first.

    Returns Binance raw rows: ``[openTime, open, high, low, close, volume, ...]``.
    """
    rows: list[list] = []
    cursor = start_ms
    while cursor < end_ms:
        url = (
            f"{BINANCE_KLINES}?symbol={symbol}&interval=1s"
            f"&startTime={cursor}&endTime={end_ms}&limit={MAX_LIMIT}"
        )
        batch = _get(url)
        if not batch:
            break
        rows.extend(batch)
        next_cursor = int(batch[-1][0]) + MS_PER_SECOND
        if next_cursor <= cursor:
            break
        cursor = next_cursor
        if len(batch) < MAX_LIMIT:
            break
    return rows


def _forward_fill(rows: list[list]) -> list[tuple[int, float]]:
    """Return ``(open_time_ms, close)`` with zero-volume 1s bars forward-filled.

    Binance emits a 1s bar per second, including empty seconds (volume 0) whose
    OHLC repeats or is flat. Forward filling the close onto every second keeps
    the replay clock monotonic at exactly one point per second.
    """
    points: list[tuple[int, float]] = []
    last_price: float | None = None
    for row in rows:
        price = float(row[4])  # close
        if price <= 0:
            if last_price is None:
                continue
            price = last_price
        last_price = price
        points.append((int(row[0]), price))
    return points


def download(
    *,
    symbol: str = "SOLUSDT",
    days: float = 3.0,
    out: Path,
    end_ms: int | None = None,
) -> Path:
    """Download ``days`` of 1s klines ending now (or ``end_ms``) and write CSV."""
    end_ms = end_ms if end_ms is not None else int(time.time() * 1_000)
    start_ms = end_ms - int(days * 24 * 3600 * 1_000)
    rows = fetch_klines(symbol, start_ms, end_ms)
    points = _forward_fill(rows)
    out.parent.mkdir(parents=True, exist_ok=True)
    with out.open("w", newline="") as handle:
        writer = csv.writer(handle)
        writer.writerow(["timestamp_ms", "price"])
        for timestamp_ms, price in points:
            writer.writerow([timestamp_ms, f"{price:.10f}"])
    return out


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--symbol", default="SOLUSDT")
    parser.add_argument("--days", type=float, default=3.0)
    parser.add_argument("--out", type=Path, default=None)
    args = parser.parse_args()
    out = args.out or Path(f"simulation/data/raw/binance_{args.symbol}_1s.csv")
    path = download(symbol=args.symbol, days=args.days, out=out)
    lines = sum(1 for _ in path.open()) - 1
    print(f"wrote {lines} 1s points to {path}")


if __name__ == "__main__":
    main()
